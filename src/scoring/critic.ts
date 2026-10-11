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
import { passesHeuristicFilter } from "./heuristics";
import {
  CRITIC_CARDS_PER_BATCH,
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

/**
 * Parses critic output into verdict fragments. First tries schema-validated
 * JSON (item 4 — the primary path, driven by structured output); any failure or
 * non-JSON output falls back to the strict `CARD: ...` line format so one bad
 * batch can't drop the grading round.
 */
export function parseVerdicts(
  raw: string,
): ReadonlyMap<string, Partial<CriticVerdict>> {
  try {
    const parsed = extractQwenJson<any>(raw);
    const list = Array.isArray(parsed) ? { verdicts: parsed } : parsed;
    const validated = criticVerdictBatchSchema.safeParse(list);
    if (validated.success && validated.data.verdicts.length > 0) {
      const out = new Map<string, Partial<CriticVerdict>>();
      for (const v of validated.data.verdicts) {
        out.set(v.cardId, {
          cardId: v.cardId,
          onTopic: v.onTopic,
          dated: v.dated,
          sourceNature: v.sourceNature,
          contradicts: [...v.contradicts],
          claimStrength: v.claimStrength,
          pass: v.pass,
          note: v.note,
        });
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
 */
export function parseCriticLines(
  raw: string,
): ReadonlyMap<string, Partial<CriticVerdict>> {
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
  const out = new Map<string, MutableVerdict>();
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

    const date = field("DATE");
    const dateYear = date && !/^NONE$/i.test(date) ? extractYear(date) : null;
    verdict.dated = dateYear ? classifyYear(dateYear) : "undated";

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

function finalizeVerdict(
  card: EvidenceCard,
  topicKeywords: ReadonlyArray<string>,
  llm: Partial<CriticVerdict> | undefined,
): CriticVerdict {
  const pre = preGrade(card, topicKeywords);
  const onTopic = llm?.onTopic ?? pre.onTopic;
  const contradicts = llm?.contradicts ?? [];
  const noteParts = [llm?.note, pre.note].filter(Boolean);
  return {
    cardId: card.id,
    onTopic,
    dated: llm?.dated ?? pre.dated,
    sourceNature: llm?.sourceNature ?? pre.sourceNature,
    contradicts,
    claimStrength: llm?.claimStrength ?? card.claimStrength,
    pass: onTopic && contradicts.length === 0,
    note: noteParts.length > 0 ? noteParts.join(" | ") : "no issues flagged",
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
CARD: <id> | ONTOPIC: <YES|NO> | DATE: <date text or NONE> | NATURE: <PRIMARY|SECONDARY|UNKNOWN> | CONFLICTS: <NONE|id;id> | STRENGTH: <documented|disputed|anecdote|speculation> | PASS: <YES|NO> | NOTE: <reason, max 160 chars>

(You may instead answer with a single JSON object: { "verdicts": [ one object per card with keys cardId, onTopic, dated, sourceNature, contradicts, claimStrength, pass, note ] }.)

RULES:
- ONTOPIC NO if the card does not directly support the research topic.
- PRIMARY = original research / official data; SECONDARY = news or review reporting on primary work; UNKNOWN otherwise.
- CONFLICTS: list ACCEPTED LEDGER card ids whose stance contradicts this card's claim; NONE if none.
- STRENGTH: documented only if backed by explicit data or peer review; disputed if contested; anecdote if personal account; else speculation.
- PASS YES only if ONTOPIC=YES and CONFLICTS=NONE.

OUTPUT:`;
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
): Promise<ReadonlyMap<string, Partial<CriticVerdict>> | null> {
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

  // Preferred path: native structured output with a JSON schema; the verdicts
  // come back pre-validated so the critic never trusts free prose.
  const structured = await askStructured(prompt, criticVerdictBatchSchema, {
    jsonSchema: criticVerdictBatchJsonSchema,
    ...commonOpts,
  });
  if (structured && structured.verdicts.length > 0) {
    const map = new Map<string, Partial<CriticVerdict>>();
    for (const v of structured.verdicts) {
      map.set(v.cardId, {
        cardId: v.cardId,
        onTopic: v.onTopic,
        dated: v.dated,
        sourceNature: v.sourceNature,
        contradicts: [...v.contradicts],
        claimStrength: v.claimStrength,
        pass: v.pass,
        note: v.note,
      });
    }
    return map;
  }

  const raw = await askLoadedModel(prompt, commonOpts);
  return raw ? parseVerdicts(raw) : null;
}

export async function runCritic(options: RunCriticOptions): Promise<RunCriticResult> {
  const { cards, topic, topicKeywords, llmManager, status, warn, signal, priorAccepted, skill } = options;
  let callsUsed = 0;
  const graded: GradedEvidenceCard[] = [];
  const failed: GradedEvidenceCard[] = [];
  const ledgerWindow: EvidenceCard[] = [...(priorAccepted ?? [])];

  // Deterministic fast-path: reject unusable cards before any LLM batch so the
  // critic only spends inference on evidence worth grading.
  const remaining: EvidenceCard[] = [];
  let heuristicRejected = 0;
  for (const card of cards) {
    const heuristic = passesHeuristicFilter({
      url: card.canonicalUrl,
      title: card.title,
      text: `${card.relevantClaim} ${card.supportingExcerpt}`,
      query: topic,
    });
    if (heuristic.pass) {
      remaining.push(card);
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

  let batches = 0;
  while (remaining.length > 0 && batches < CRITIC_MAX_GRADE_BATCHES) {
    const batch = remaining.splice(0, CRITIC_CARDS_PER_BATCH);
    batches++;
    if (signal?.aborted || llmManager.shouldStop()) {
      remaining.unshift(...batch);
      break;
    }

    const parsed = await gradeBatch(batch, ledgerWindow.slice(-CRITIC_LEDGER_CONTEXT_CARDS), topic, llmManager, signal, skill);
    if (!parsed) {
      remaining.unshift(...batch);
      break;
    }
    callsUsed++;

    for (const card of batch) {
      const verdict = finalizeVerdict(card, topicKeywords, parsed.get(card.id));
      const gradedCard: GradedEvidenceCard = { ...card, critic: verdict };
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

  status?.(
    `[CRITIC] Graded ${graded.length + failed.length} cards (${graded.length} pass, ` +
      `${failed.length} fail, ${callsUsed} LLM call${callsUsed === 1 ? "" : "s"}).`,
  );
  if (failed.length > 0) {
    warn?.(
      `[CRITIC] ${failed.length} card(s) failed — ${failed.map((c) => c.critic.note).slice(0, 3).join("; ")}`,
    );
  }

  return { graded, failed, callsUsed };
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