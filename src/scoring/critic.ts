/**
 * @file scoring/critic.ts
 * The critic/verifier worker — the evaluating half of the evaluator–optimizer
 * loop. It CANNOT search: it never touches the network layer and its prompt
 * forbids proposing queries. Its only job is to grade evidence cards produced
 * by the crawl workers (on-topic, dated, primary-vs-secondary, contradicts the
 * accepted ledger), tag claim strength, and mark PASS/FAIL. Failing cards
 * trigger a targeted retry search round in the orchestrator; the synthesis then
 * reads only the graded ledger.
 *
 * Grading is two-staged to burn as few of the LLM call-budget slots as possible:
 *   1. Deterministic pre-grading (zero LLM calls) — dated / nature / on-topic.
 *   2. Batched LLM grading (several cards per call) that confirms the heuristic
 *      verdict and checks each card against the accepted-ledger window.
 */

import {
  ClaimStrength,
  CriticVerdict,
  Datedness,
  EvidenceCard,
  GradedEvidenceCard,
  SourceNature,
  StatusFn,
  WarnFn,
  SkillPack,
} from "../types";
import { LlmCallManager, askLoadedModel, askStructured, hasLoadedModel } from "../utils/llm";
import { extractQwenJson } from "../utils/qwen-parser";
import { boundEvidenceChunk } from "../utils/text";
import { lexicalScore, passesHeuristicFilter, LexicalTier } from "./heuristics";
import {
  CRITIC_CARDS_PER_BATCH,
  CRITIC_EXTRACTED_CLAIM_MAX_CHARS,
  CRITIC_MAX_GRADE_BATCHES,
  CRITIC_LEDGER_CONTEXT_CARDS,
  CRITIC_MAX_TOKENS,
  CRITIC_TEMPERATURE,
  CRITIC_TIMEOUT_MS,
} from "../constants";
import {
  criticVerdictBatchSchema,
  criticVerdictBatchJsonSchema,
} from "../planning/schemas";

const CRITIC_WORKER_ID = "critic";
const ON_TOPIC_OVERLAP_THRESHOLD = 0.4;
const STALE_YEARS = 4;

/**
 * Internal parse result. Extends the internal verdict fragment with the two
 * flat fields the wire schema carries but the deterministic `CriticVerdict`
 * shape does not: `extractedClaim` (used to sharpen the card's claim) and
 * `sourceUrl` (compared against the card's resolved URL for provenance drift).
 */
export interface ParsedVerdict extends Partial<CriticVerdict> {
  readonly extractedClaim?: string;
  readonly sourceUrl?: string;
}

export interface RunCriticOptions {
  readonly cards: ReadonlyArray<EvidenceCard>;
  readonly topic: string;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly llmManager: LlmCallManager;
  readonly status?: StatusFn;
  readonly warn?: WarnFn;
  readonly signal?: AbortSignal;
  /** Already-accepted ledger cards the batch is checked against for
   * contradictions (used when grading a retry round incrementally). */
  readonly priorAccepted?: ReadonlyArray<EvidenceCard>;
  /** Auto-selected skill pack whose conventions the critic should follow. */
  readonly skill?: SkillPack;
}

export interface RunCriticResult {
  readonly graded: ReadonlyArray<GradedEvidenceCard>;
  readonly failed: ReadonlyArray<GradedEvidenceCard>;
  readonly callsUsed: number;
  /**
   * True when at least one failing card was top-tier by the deterministic
   * lexical pre-filter. Only then is the orchestrator's bounded retry search
   * round allowed to spend crawler + LLM budget — low-value failures fall back
   * deterministically so synthesis is never starved.
   */
  readonly retryWorthy: boolean;
}

interface PreGrade {
  readonly onTopic: boolean;
  readonly dated: Datedness;
  readonly sourceNature: SourceNature;
  readonly note: string;
}

function keywordOverlap(
  card: EvidenceCard,
  topicKeywords: ReadonlyArray<string>,
): number {
  const distinct = topicKeywords.filter((k) => k.trim().length > 2);
  if (distinct.length === 0) return 1;
  const haystack =
    `${card.title} ${card.relevantClaim} ${card.supportingExcerpt}`.toLowerCase();
  const matched = distinct.filter((k) => haystack.includes(k.toLowerCase())).length;
  return matched / distinct.length;
}

function extractYear(text: string): number | null {
  const m = /(?:19|20)\d{2}/.exec(text);
  return m ? parseInt(m[0], 10) : null;
}

function classifyYear(year: number): Datedness {
  return year >= new Date().getFullYear() - STALE_YEARS ? "dated" : "stale";
}

function preGradeDated(card: EvidenceCard): { dated: Datedness; note: string } {
  const freshnessYear = extractYear(card.freshness ?? "");
  if (freshnessYear) return { dated: classifyYear(freshnessYear), note: `dated ${freshnessYear}` };
  const urlYear = /(?:19|20)\d{2}/.exec(card.canonicalUrl);
  const urlYearNum = urlYear ? parseInt(urlYear[0], 10) : null;
  if (urlYearNum) {
    const dated = classifyYear(urlYearNum);
    return { dated, note: `dated ${urlYearNum} (from URL)` };
  }
  if (/undated|n\.d\.|unknown/i.test(card.title)) {
    return { dated: "undated", note: "undated source" };
  }
  return { dated: "undated", note: "no explicit publication date" };
}

function preGradeNature(card: EvidenceCard): SourceNature {
  switch (card.sourceTier) {
    case "academic":
    case "government":
      return "primary";
    case "news":
    case "reference":
      return "secondary";
    default:
      return "unknown";
  }
}

function preGrade(
  card: EvidenceCard,
  topicKeywords: ReadonlyArray<string>,
): PreGrade {
  const overlap = keywordOverlap(card, topicKeywords);
  const { dated, note } = preGradeDated(card);
  return {
    onTopic: overlap >= ON_TOPIC_OVERLAP_THRESHOLD,
    dated,
    sourceNature: preGradeNature(card),
    note: `${note}; topic overlap ${Math.round(overlap * 100)}%`,
  };
}

/** Maps a flat wire verdict onto the internal verdict fragment. */
function mapFlatVerdict(
  v: {
    cardId: string;
    onTopic: boolean;
    hasDate: boolean;
    contradictsLedger: boolean;
    claimStrength: "high" | "medium" | "low";
    extractedClaim?: string;
    sourceUrl?: string;
  },
  ledgerIds: ReadonlyArray<string>,
): ParsedVerdict {
  const claimStrength: ClaimStrength =
    v.claimStrength === "high"
      ? "documented"
      : v.claimStrength === "medium"
        ? "disputed"
        : "speculation";
  return {
    cardId: v.cardId,
    onTopic: v.onTopic,
    dated: v.hasDate ? "dated" : "undated",
    // The wire flag is a boolean; attribute the contradiction to the accepted
    // ledger window the batch was graded against (never to an invented id).
    contradicts: v.contradictsLedger ? [...ledgerIds] : [],
    claimStrength,
    pass: v.onTopic && !v.contradictsLedger,
    extractedClaim: v.extractedClaim,
    sourceUrl: v.sourceUrl,
  };
}

/**
 * Parses critic output into verdict fragments. First tries schema-validated
 * JSON (item 4 — the primary path, driven by structured output); any failure or
 * non-JSON output falls back to the strict `CARD: ...` line format so one bad
 * batch can't drop the grading round.
 *
 * @param ledgerIds ids of the accepted ledger cards this batch was graded
 *   against; a `contradictsLedger: true` verdict is attributed to them.
 */
export function parseVerdicts(
  raw: string,
  ledgerIds: ReadonlyArray<string> = [],
): ReadonlyMap<string, ParsedVerdict> {
  try {
    const parsed = extractQwenJson<any>(raw);
    const list = Array.isArray(parsed) ? { verdicts: parsed } : parsed;
    const validated = criticVerdictBatchSchema.safeParse(list);
    if (validated.success && validated.data.verdicts.length > 0) {
      const out = new Map<string, ParsedVerdict>();
      for (const v of validated.data.verdicts) {
        out.set(v.cardId, mapFlatVerdict(v, ledgerIds));
      }
      return out;
    }
  } catch {
    /* not JSON — fall through to the line parser */
  }
  return parseCriticLines(raw);
}

/**
 * Parses the strict per-card critic output lines into verdict fragments.
 * Malformed or unknown lines are skipped so one bad card can't drop a batch.
 * Kept as the non-JSON fallback for models that ignore the flat JSON schema.
 */
export function parseCriticLines(raw: string): ReadonlyMap<string, ParsedVerdict> {
  type MutableVerdict = {
    cardId?: string;
    onTopic?: boolean;
    dated?: Datedness;
    sourceNature?: SourceNature;
    contradicts?: string[];
    claimStrength?: ClaimStrength;
    pass?: boolean;
    note?: string;
  };
  const out = new Map<string, ParsedVerdict>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!/^CARD:/i.test(trimmed)) continue;
    const idMatch = /^CARD:\s*([A-Za-z0-9_-]+)\s*\|/.exec(trimmed);
    if (!idMatch) continue;
    const id = idMatch[1];

    const field = (name: string): string | null => {
      const m = new RegExp(`${name}:\\s*([^|]*)`, "i").exec(trimmed);
      return m ? m[1].trim() : null;
    };

    const verdict: MutableVerdict = { cardId: id };

    const onTopic = field("ONTOPIC");
    if (onTopic) verdict.onTopic = onTopic.toUpperCase().startsWith("Y");

    const hasDate = field("HASDATE");
    if (hasDate) {
      verdict.dated = hasDate.toUpperCase().startsWith("Y") ? "dated" : "undated";
    } else {
      const date = field("DATE");
      const dateYear = date && !/^NONE$/i.test(date) ? extractYear(date) : null;
      verdict.dated = dateYear ? classifyYear(dateYear) : "undated";
    }

    const nature = field("NATURE");
    if (nature) {
      const n = nature.toUpperCase();
      verdict.sourceNature = n.startsWith("PRIMARY")
        ? "primary"
        : n.startsWith("SECONDARY")
          ? "secondary"
          : "unknown";
    }

    const conflicts = field("CONFLICTS");
    verdict.contradicts = conflicts
      ? conflicts
          .split(/[;,]/)
          .map((s) => s.trim())
          .filter((s) => Boolean(s) && !/^NONE$/i.test(s))
      : [];

    const strength = (field("STRENGTH") ?? "").toLowerCase();
    if (["documented", "disputed", "anecdote", "speculation"].includes(strength)) {
      verdict.claimStrength = strength as ClaimStrength;
    }

    const pass = field("PASS");
    if (pass) verdict.pass = pass.toUpperCase().startsWith("Y");

    const note = field("NOTE");
    if (note) verdict.note = note;

    out.set(id, verdict);
  }
  return out;
}

/** Normalized host+path comparison for provenance drift checks. */
function normalizeUrlForCompare(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${host}${path}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Uses the model's `extractedClaim` to sharpen the card's claim text when it is
 * substantive. Provenance (URL/title/tier) always stays deterministic — only
 * the claim sentence is allowed to come from the model.
 */
function applyExtractedClaim(
  card: EvidenceCard,
  parsed: ParsedVerdict | undefined,
): EvidenceCard {
  const claim = (parsed?.extractedClaim ?? "").replace(/\s+/g, " ").trim();
  if (claim.length < 20) return card;
  return { ...card, relevantClaim: claim.slice(0, CRITIC_EXTRACTED_CLAIM_MAX_CHARS) };
}

function finalizeVerdict(
  card: EvidenceCard,
  topicKeywords: ReadonlyArray<string>,
  llm: ParsedVerdict | undefined,
): CriticVerdict {
  const pre = preGrade(card, topicKeywords);
  const onTopic = llm?.onTopic ?? pre.onTopic;
  const contradicts = llm?.contradicts ?? [];
  const dated = llm?.dated ?? pre.dated;
  const sourceNature = llm?.sourceNature ?? pre.sourceNature;
  const claimStrength = llm?.claimStrength ?? card.claimStrength;

  // The note is fully deterministic flag text — the model never supplies prose.
  const flags = [
    onTopic ? "on-topic" : "OFF-TOPIC",
    `date:${dated}`,
    sourceNature,
    contradicts.length > 0 ? `conflicts:${contradicts.join(",")}` : "no-conflicts",
    `strength:${claimStrength}`,
  ];
  const claimed = llm?.sourceUrl?.trim();
  if (claimed && normalizeUrlForCompare(claimed) !== normalizeUrlForCompare(card.canonicalUrl)) {
    flags.push("url-mismatch");
  }

  return {
    cardId: card.id,
    onTopic,
    dated,
    sourceNature,
    contradicts,
    claimStrength,
    pass: onTopic && contradicts.length === 0,
    note: `${pre.note} | ${flags.join(" | ")}`,
  };
}

/**
 * Deterministic-only grading used when no model/budget is available (the critic
 * LLM never ran). Every card is treated as passing the on-topic gate; the
 * verdict reflects only the heuristic date/nature classification so downstream
 * synthesis still sees a single GradedEvidenceCard shape.
 */
export function gradeCardFallback(
  card: EvidenceCard,
  topicKeywords: ReadonlyArray<string> = [],
): GradedEvidenceCard {
  return { ...card, critic: finalizeVerdict(card, topicKeywords, undefined) };
}

function buildBatchPrompt(
  batch: ReadonlyArray<EvidenceCard>,
  ledgerWindow: ReadonlyArray<EvidenceCard>,
  topic: string,
  skill?: SkillPack,
): string {
  const ledgerBlock =
    ledgerWindow.length > 0
      ? ledgerWindow
          .map(
            (c) =>
              `[${c.id}] "${c.title}" — ${c.relevantClaim.slice(0, 160)}`,
          )
          .join("\n")
      : "(none yet)";

  const cardsBlock = batch
    .map((c) => {
      const claim = boundEvidenceChunk(c.relevantClaim).slice(0, 220);
      const excerpt = boundEvidenceChunk(c.supportingExcerpt).slice(0, 400);
      return (
        `[${c.id}] "${c.title}"\n` +
        `Author/host: ${c.authorOrHost} | Tier: ${c.sourceTier} | ` +
        `Published: ${c.freshness ?? "unknown"} | Confidence: ${c.confidence}\n` +
        `Claim: ${claim}\n` +
        `Excerpt: ${excerpt}`
      );
    })
    .join("\n\n");

  return `You are a VERIFIER critic, NOT a researcher. You cannot search and must not propose queries. You grade ONLY the evidence cards below against the research topic.

TOPIC: "${topic}"

${skill ? `SKILL PACK APPLIED — "${skill.name}" v${skill.version}: follow its conventions when judging relevance and nature.\n${skill.content}\n` : ""}
ACCEPTED LEDGER (evidence already accepted — check cards against these):
${ledgerBlock}

CARDS TO GRADE:
${cardsBlock}

For each card output EXACTLY ONE line:
CARD: <id> | ONTOPIC: <YES|NO> | HASDATE: <YES|NO> | CONFLICTS: <NONE|ledger-id;ledger-id> | STRENGTH: <documented|disputed|anecdote|speculation> | PASS: <YES|NO>

(Preferred: answer with a single flat JSON object with no prose: { "verdicts": [ { "cardId": "E1", "onTopic": true, "hasDate": true, "contradictsLedger": false, "claimStrength": "high|medium|low", "extractedClaim": "<one sentence supported by the excerpt>", "sourceUrl": "<the card's URL>" } ] }.)

RULES:
- ONTOPIC NO if the card does not directly support the research topic.
- HASDATE YES only if the card carries an explicit publication date.
- CONTRADICTSLEDGER YES if this card's claim conflicts with the ACCEPTED LEDGER above.
- CLAIMSTRENGTH: high = backed by explicit data or peer review; medium = plausible but contested; low = anecdote or speculation.
- EXTRACTEDCLAIM: state the card's core claim in one short sentence, using only the excerpt text.
- OUTPUT: compact JSON only — no explanations, no markdown, no commentary.`;
}

/**
 * LLM-grades one batch against the accepted-ledger window. Returns null when no
 * model is loaded, the call budget is exhausted, or the request failed — the
 * caller then keeps the deterministic pre-grade verdicts.
 */
async function gradeBatch(
  batch: ReadonlyArray<EvidenceCard>,
  ledgerWindow: ReadonlyArray<EvidenceCard>,
  topic: string,
  llmManager: LlmCallManager,
  signal?: AbortSignal,
  skill?: SkillPack,
): Promise<ReadonlyMap<string, ParsedVerdict> | null> {
  if (!llmManager.canCall(CRITIC_WORKER_ID)) return null;
  if (!(await hasLoadedModel())) return null;

  llmManager.recordCall(CRITIC_WORKER_ID);
  const prompt = buildBatchPrompt(batch, ledgerWindow, topic, skill);
  const commonOpts = {
    maxTokens: CRITIC_MAX_TOKENS,
    temperature: CRITIC_TEMPERATURE,
    timeoutMs: CRITIC_TIMEOUT_MS,
    signal,
    // The critic is pure extraction/classification — reasoning tokens add no
    // value and would slow every batch down.
    reasoningEffort: "none" as const,
    disableThinking: true,
  };

  // Preferred path: native structured output with the flat JSON schema; the
  // verdicts come back pre-validated so the critic never trusts free prose.
  const structured = await askStructured(prompt, criticVerdictBatchSchema, {
    jsonSchema: criticVerdictBatchJsonSchema,
    ...commonOpts,
  });
  if (structured && structured.verdicts.length > 0) {
    const ledgerIds = ledgerWindow.map((c) => c.id);
    const map = new Map<string, ParsedVerdict>();
    for (const v of structured.verdicts) {
      map.set(v.cardId, mapFlatVerdict(v, ledgerIds));
    }
    return map;
  }

  const raw = await askLoadedModel(prompt, commonOpts);
  return raw ? parseVerdicts(raw, ledgerWindow.map((c) => c.id)) : null;
}

export async function runCritic(options: RunCriticOptions): Promise<RunCriticResult> {
  const { cards, topic, topicKeywords, llmManager, status, warn, signal, priorAccepted, skill } = options;
  let callsUsed = 0;
  const graded: GradedEvidenceCard[] = [];
  const failed: GradedEvidenceCard[] = [];
  const ledgerWindow: EvidenceCard[] = [...(priorAccepted ?? [])];

  // Deterministic fast-path: reject unusable cards before any LLM batch so the
  // critic only spends inference on evidence worth grading.
  const tiers = new Map<string, LexicalTier>();
  const scored: Array<{ card: EvidenceCard; score: number }> = [];
  const remaining: EvidenceCard[] = [];
  let heuristicRejected = 0;
  for (const card of cards) {
    const input = {
      url: card.canonicalUrl,
      title: card.title,
      text: `${card.relevantClaim} ${card.supportingExcerpt}`,
      query: topic,
    };
    const heuristic = passesHeuristicFilter(input);
    if (heuristic.pass) {
      const lexical = lexicalScore(input);
      tiers.set(card.id, lexical.tier);
      scored.push({ card, score: lexical.score });
      continue;
    }
    heuristicRejected++;
    const base = finalizeVerdict(card, topicKeywords, undefined);
    failed.push({
      ...card,
      critic: {
        ...base,
        onTopic: false,
        pass: false,
        note: `heuristic reject: ${heuristic.reason ?? "failed pre-filter"}`,
      },
    });
  }
  if (heuristicRejected > 0) {
    status?.(
      `[CRITIC] Heuristic pre-filter rejected ${heuristicRejected} card(s) before any LLM call.`,
    );
  }

  // Grade the strongest lexical candidates first so a truncated batch budget
  // spends its LLM calls on the evidence most likely to survive the critic.
  scored.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  for (const { card } of scored) remaining.push(card);

  let batches = 0;
  let parseRetryUsed = false;
  while (remaining.length > 0 && batches < CRITIC_MAX_GRADE_BATCHES) {
    const batch = remaining.splice(0, CRITIC_CARDS_PER_BATCH);
    batches++;
    if (signal?.aborted || llmManager.shouldStop()) {
      remaining.unshift(...batch);
      break;
    }

    const ledgerContext = ledgerWindow.slice(-CRITIC_LEDGER_CONTEXT_CARDS);
    let parsed = await gradeBatch(batch, ledgerContext, topic, llmManager, signal, skill);

    // Bounded single retry: a malformed/failed batch is only re-issued when it
    // contains a top-tier lexical card. Low-value batches fall back to the
    // deterministic verdicts so the 20% synthesis reserve is preserved.
    if (
      !parsed &&
      !parseRetryUsed &&
      !signal?.aborted &&
      !llmManager.shouldStop() &&
      batch.some((c) => tiers.get(c.id) === "high")
    ) {
      parseRetryUsed = true;
      status?.(`[CRITIC] Batch parse failed on top-tier evidence — retrying once.`);
      parsed = await gradeBatch(batch, ledgerContext, topic, llmManager, signal, skill);
    }

    if (!parsed) {
      remaining.unshift(...batch);
      break;
    }
    callsUsed++;

    for (const card of batch) {
      const parsedVerdict = parsed.get(card.id);
      const verdict = finalizeVerdict(card, topicKeywords, parsedVerdict);
      const gradedCard: GradedEvidenceCard = {
        ...applyExtractedClaim(card, parsedVerdict),
        critic: verdict,
      };
      if (verdict.pass) {
        graded.push(gradedCard);
        ledgerWindow.push(card);
      } else {
        failed.push(gradedCard);
      }
    }
  }

  // Any cards never reached by an LLM batch keep their deterministic verdict.
  for (const card of remaining) {
    const verdict = finalizeVerdict(card, topicKeywords, undefined);
    const gradedCard: GradedEvidenceCard = { ...card, critic: verdict };
    if (verdict.pass) graded.push(gradedCard);
    else failed.push(gradedCard);
  }

  // A retry round is only worth crawling for if a *strong* card failed —
  // low-tier failures fall back deterministically.
  const retryWorthy = failed.some((c) => tiers.get(c.id) === "high");

  status?.(
    `[CRITIC] Graded ${graded.length + failed.length} cards (${graded.length} pass, ` +
      `${failed.length} fail, ${callsUsed} LLM call${callsUsed === 1 ? "" : "s"}${retryWorthy ? ", retry-worthy failures" : ""}).`,
  );
  if (failed.length > 0) {
    warn?.(
      `[CRITIC] ${failed.length} card(s) failed — ${failed.map((c) => c.critic.note).slice(0, 3).join("; ")}`,
    );
  }

  return { graded, failed, callsUsed, retryWorthy };
}

/**
 * Builds the targeted retry queries for failed cards. Called by the orchestrator
 * so ONLY failing claims trigger another search round (bounded and deduped).
 */
export function buildRetryQueries(
  failed: ReadonlyArray<{ readonly relevantClaim: string }>,
  topic: string,
  max: number,
): ReadonlyArray<string> {
  const queries: string[] = [];
  for (const card of failed) {
    if (queries.length >= max) break;
    const claim = (card.relevantClaim || "")
      .replace(/\s+/g, " ")
      .replace(/[|]/g, "")
      .trim()
      .slice(0, 120);
    if (!claim) continue;
    const q = `${topic} ${claim}`.replace(/\s+/g, " ").trim().slice(0, 250);
    if (!q || queries.includes(q)) continue;
    queries.push(q);
  }
  return queries;
}