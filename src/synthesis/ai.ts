// src/synthesis/ai.ts
import { LMStudioClient } from "@lmstudio/sdk";
import { ReportSource, ContradictionEntry, StatusFn, EvidenceCard, GradedEvidenceCard, ContextBudget, SkillPack } from "../types";
import { logLlmDiagnostics, estimateTokens, preflightSynthesis } from "../utils/tokens";
import { buildPredictionOptions, withThinkingDirective } from "../utils/llm";
import { boundEvidenceChunk } from "../utils/text";
import {
  DepthProfile,
  AI_SYNTHESIS_TEMPERATURE,
  AI_SYNTHESIS_TIMEOUT_MS,
  CONTRADICTION_SOURCE_CHARS,
  CONTRADICTION_MAX_SOURCES,
  SYSTEM_INSTRUCTIONS,
} from "../constants";

function renderVerdict(card: GradedEvidenceCard): string {
  const c = card.critic;
  const parts = [
    c.onTopic ? "on-topic" : "OFF-TOPIC",
    `dated:${c.dated}`,
    c.sourceNature,
    c.contradicts.length > 0 ? `conflicts:${c.contradicts.join(",")}` : "no-conflicts",
  ];
  return parts.join(" | ");
}

function prepareEvidenceLedger(
  evidence: ReadonlyArray<GradedEvidenceCard>,
  maxTokens: number
): string {
  const sorted = [...evidence].sort((a, b) => {
    const score = { High: 3, Medium: 2, Low: 1 };
    return score[b.confidence] - score[a.confidence];
  });

  const ledger: string[] = [];
  let currentTokens = 0;
  const tokenLimit = maxTokens - 1000;

  for (const card of sorted) {
    if (!card.critic.pass) continue;
    const claim = boundEvidenceChunk(card.relevantClaim);
    const excerpt = boundEvidenceChunk(card.supportingExcerpt);
    const entry = `[${card.id}] (${card.entityType}) ${card.title} - ${card.authorOrHost}\nURL: ${card.canonicalUrl}\nTier: ${card.sourceTier} | Confidence: ${card.confidence} | Freshness: ${card.freshness ?? "Unknown"}\nCRITIC: ${renderVerdict(card)}\nClaim: ${claim}\nExcerpt: "${excerpt}"`;

    const entryTokens = estimateTokens(entry);
    if (currentTokens + entryTokens > tokenLimit) break;

    ledger.push(entry);
    currentTokens += entryTokens;
  }

  return ledger.join("\n\n---\n\n");
}

export async function synthesiseReport(
  topic: string,
  evidence: ReadonlyArray<GradedEvidenceCard>,
  coveredClaims: ReadonlyArray<string>,
  gapClaims: ReadonlyArray<string>,
  status: StatusFn,
  budget: ContextBudget,
  skill?: SkillPack,
): Promise<string | null> {
  if (evidence.length === 0) return null;

  status(`AI synthesis - preparing evidence ledger (${evidence.length} cards, budget: ${budget.maxSynthesisInput} tokens)…`);

  const evidenceBlock = prepareEvidenceLedger(evidence, budget.maxSynthesisInput);

  const skillBlock = skill
    ? `\nSKILL PACK APPLIED — "${skill.name}" v${skill.version} (auto-selected from topic domain tags). Follow its conventions for this topic:\n${skill.content}\n`
    : "";

  const prompt = `You are an expert research analyst. Write a comprehensive, well-structured narrative synthesis of these research findings.

TOPIC: "${topic}"
CLAIMS COVERED: ${coveredClaims.join(", ")}
${skillBlock}
EVIDENCE LEDGER (CRITIC-VERIFIED, PASS cards only — every card was graded on-topic and checked against the accepted ledger for contradictions):
 ${evidenceBlock}

STRICT OUTPUT RULES:
1. SUMMARY: Start with a Markdown table of recommended sources using these exact columns: | Recommendation | Why it fits | Official verification | Status |
2. CITATION ANCHORING: You MUST cite every factual claim inline using the Exact Index Format: [1], [2], etc.
3. NO ORPHAN METRICS: Do not include ANY percentages, statistics, or metrics unless they are explicitly written verbatim in the provided Evidence Ledger. If you cannot point to the exact excerpt, DROP the statistic.
4. TAXONOMY SEPARATION: Keep documented field investigations, anecdotal accounts, and philosophical doctrine in separate sections. Do not conflate them.
5. NO HALLUCINATED NAMES: You may only cite authors, researchers, and institutions explicitly listed in the Evidence Ledger.
6. NO INVENTED URLS: Citations are keys into the ledger. Every [Index] must match a ledger card, and every URL you write must be the card's exact Canonical URL.
7. REFERENCE APPENDIX: Conclude the report with a strict Markdown table titled "Reference Appendix" mapping each [Index] to its Canonical URL and Author/Host.

SYNTHESIS:`;

  const promptTokens = estimateTokens(prompt);
  const preflight = preflightSynthesis(promptTokens, budget);

  status(`[TOKEN PREFLIGHT] Projected: ${preflight.projectedTotal}/${budget.modelContextLimit} | Decision: ${preflight.decision}`);

  if (preflight.decision === "FAIL-SAFE") {
    status("SYNTHESIS_SKIPPED_CONTEXT_RISK");
    return null;
  }

  logLlmDiagnostics("synthesiseReport", prompt);

  try {
    const client = new LMStudioClient();
    const models = await Promise.race<Awaited<ReturnType<typeof client.llm.listLoaded>>>([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), AI_SYNTHESIS_TIMEOUT_MS)),
    ]);

    if (!Array.isArray(models) || models.length === 0) return null;
    const model = await client.llm.model(models[0].identifier);

    const messages = withThinkingDirective(
      [
        { role: "system" as const, content: SYSTEM_INSTRUCTIONS },
        { role: "user" as const, content: prompt },
      ],
      { reasoningEffort: "medium" },
    );
    const stream = model.respond(
      messages as never,
      buildPredictionOptions({
        maxTokens: budget.outputReserve,
        temperature: AI_SYNTHESIS_TEMPERATURE,
        reasoningEffort: "medium",
      }) as never,
    );

    let result = "";
    for await (const chunk of stream) result += chunk.content ?? "";

    if (result.length > 100) {
      status(`AI synthesis complete (${result.length} chars)`);
      return result;
    }
    return null;
  } catch (err) {
    status(`AI synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Maps the critic's per-card "contradicts" verdicts into the report's
 * ContradictionEntry shape. Card ids are `E<k>` where k is the 1-based index of
 * the source in the final crawled array, so they line up with the citation
 * index rendered in the report.
 */
export function deriveContradictions(
  graded: ReadonlyArray<GradedEvidenceCard>,
): ReadonlyArray<ContradictionEntry> {
  const byId = new Map(graded.map((c) => [c.id, c]));
  const indexOf = (card: GradedEvidenceCard): number => {
    const m = /^E(\d+)$/.exec(card.id);
    return m ? parseInt(m[1], 10) : 0;
  };
  const emitted = new Set<string>();
  const entries: ContradictionEntry[] = [];

  for (const card of graded) {
    for (const otherId of card.critic.contradicts) {
      const other = byId.get(otherId);
      if (!other || other.id === card.id) continue;
      const key = [card.id, otherId].sort().join("<->");
      if (emitted.has(key)) continue;
      emitted.add(key);

      const severity =
        card.critic.claimStrength === "documented" ||
        other.critic.claimStrength === "documented"
          ? "major"
          : card.critic.claimStrength === "disputed" ||
              other.critic.claimStrength === "disputed"
            ? "moderate"
            : "minor";

      entries.push({
        claim: card.relevantClaim.slice(0, 220),
        sourceA: {
          index: indexOf(card),
          title: card.title,
          stance: `${card.critic.claimStrength}${card.critic.pass ? "" : " — flagged by critic"}`,
        },
        sourceB: {
          index: indexOf(other),
          title: other.title,
          stance: `${other.critic.claimStrength}${other.critic.pass ? "" : " — flagged by critic"}`,
        },
        severity,
      });

      if (entries.length >= CONTRADICTION_MAX_SOURCES) break;
    }
    if (entries.length >= CONTRADICTION_MAX_SOURCES) break;
  }

  return entries;
}

export async function detectContradictions(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  status: StatusFn,
  profile: DepthProfile,
): Promise<ReadonlyArray<ContradictionEntry>> {
  if (sources.length < 3) return [];

  status("Checking for cross-source contradictions...");

  const sourceBlock = sources.slice(0, profile.contradictionMaxSources).map((s) => {
    const preview = s.text.slice(0, CONTRADICTION_SOURCE_CHARS).replace(/\n+/g, " ").trim();
    return `[${s.index}] "${s.title}" - ${s.tier}\n${preview}`;
  }).join("\n\n");

  const maxContradictions = Math.min(10, Math.max(5, Math.floor(sources.length / 5)));

  const prompt = `You are a fact-checking analyst. Given these research sources on "${topic}", identify any CONTRADICTIONS.
SOURCES:
 ${sourceBlock}

For each contradiction, output ONE line:
CLAIM: <claim> | SOURCE_A: [<index>] <stance> | SOURCE_B: [<index>] <stance> | SEVERITY: <minor/moderate/major>

If none, output: NONE
Max ${maxContradictions} contradictions.
OUTPUT:`;

  try {
    const client = new LMStudioClient();
    const models = await client.llm.listLoaded();
    if (!models || models.length === 0) return [];
    const model = await client.llm.model(models[0].identifier);
    
    const messages = withThinkingDirective(
      [{ role: "user" as const, content: prompt }],
      { reasoningEffort: "none", disableThinking: true },
    );
    const stream = model.respond(
      messages as never,
      buildPredictionOptions({
        maxTokens: 1500,
        temperature: 0.15,
        reasoningEffort: "none",
        disableThinking: true,
      }) as never,
    );

    let raw = "";
    for await (const chunk of stream) raw += chunk.content ?? "";

    if (!raw || /^NONE$/im.test(raw.trim())) return [];

    const entries: ContradictionEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("CLAIM:")) continue;
      try {
        const claimMatch = /CLAIM:\s*(.+?)\s*\|/.exec(trimmed);
        const sourceAMatch = /SOURCE_A:\s*\[(\d+)\]\s*(.+?)\s*\|/.exec(trimmed);
        const sourceBMatch = /SOURCE_B:\s*\[(\d+)\]\s*(.+?)\s*\|/.exec(trimmed);
        const sevMatch = /SEVERITY:\s*(minor|moderate|major)/i.exec(trimmed);
        if (!claimMatch || !sourceAMatch || !sourceBMatch) continue;

        const idxA = parseInt(sourceAMatch[1], 10);
        const idxB = parseInt(sourceBMatch[1], 10);
        entries.push({
          claim: claimMatch[1].trim(),
          sourceA: { index: idxA, title: sources.find(s => s.index === idxA)?.title ?? `Source ${idxA}`, stance: sourceAMatch[2].trim() },
          sourceB: { index: idxB, title: sources.find(s => s.index === idxB)?.title ?? `Source ${idxB}`, stance: sourceBMatch[2].trim() },
          severity: (sevMatch?.[1]?.toLowerCase() ?? "minor") as "minor" | "moderate" | "major",
        });
      } catch { continue; }
    }
    return entries;
  } catch {
    return [];
  }
}