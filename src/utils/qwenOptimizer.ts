// src/utils/qwenOptimizer.ts
// Qwen 3.8 fast-call wrapper + intra-page BM25 pruner + skill-pack fallback.
//
// Three run-time optimisations that all target the same bottleneck (the single
// LM Studio kv-cache slot fed by a local Qwen-class model):
//   1. optimizeForQwen38 — prefill `<think>\n</think>\n` and append `/no_think`
//      on deterministic micro-calls (gatekeeper / critic / mutator) so a 10-token
//      classification never gets cut off inside a reasoning block.
//   2. extractTopBm25Windows — keep only the top BM25-scored paragraphs of a page
//      instead of blindly slicing the first 5K-16K characters, so the real data
//      buried mid-article still reaches the critic and synthesis.
//   3. resolveSkillPackWithFallback — never leave an investigative/empirical
//      topic with "[SKILL] none"; unmatched topics default to the academic pack.

export type LlmTaskType =
  | "gatekeeper" // 10-token yes/no local RAG check -> NO THINK
  | "critic" // Flat CARD: grading batches     -> NO THINK
  | "mutator" // Fast search query mutation     -> NO THINK
  | "planner" // Task decomposition             -> KEEP THINK (capped)
  | "synthesizer"; // Final Markdown report          -> KEEP THINK

export interface OptimizedPromptConfig {
  systemPrompt: string;
  userPrompt: string;
  assistantPrefill?: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Optimizes prompts for Qwen 3.8 in LM Studio.
 * Disables <think> chains on deterministic micro-calls so the single KV-cache slot
 * never stalls or truncates inside a <think> block.
 */
export function optimizeForQwen38(
  task: LlmTaskType,
  systemPrompt: string,
  userPrompt: string,
  defaultMaxTokens = 1024,
): OptimizedPromptConfig {
  const isMicroCall =
    task === "gatekeeper" || task === "critic" || task === "mutator";

  if (isMicroCall) {
    return {
      // Qwen3 / Qwen3.8 honors `/no_think` in system/user prompt AND empty <think> prefill
      systemPrompt: `${systemPrompt.trim()}\n/no_think`,
      userPrompt: `${userPrompt.trim()} /no_think`,
      assistantPrefill: "<think>\n</think>\n",
      temperature: 0.0,
      maxTokens:
        task === "gatekeeper" ? 32 : task === "mutator" ? 160 : 384,
    };
  }

  return {
    systemPrompt,
    userPrompt,
    temperature: task === "planner" ? 0.2 : 0.3,
    maxTokens: defaultMaxTokens,
  };
}

/**
 * Intra-Page BM25 Paragraph Windowing
 * Replaces blind 5K-16K top-of-page slicing with the top K most relevant paragraphs
 * across the entire document, preserving inline heading context.
 */
export function extractTopBm25Windows(
  markdownContent: string,
  query: string,
  maxChars = 2200,
  k1 = 1.4,
  b = 0.75,
): string {
  if (markdownContent.length <= maxChars) return markdownContent;

  const queryTerms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    ),
  );
  if (queryTerms.length === 0) return markdownContent.slice(0, maxChars);

  // Split into semantic blocks (~350-700 chars) preserving headings
  const rawBlocks = markdownContent
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 40);

  if (rawBlocks.length === 0) return markdownContent.slice(0, maxChars);

  const avgLen =
    rawBlocks.reduce((acc, blk) => acc + blk.length, 0) / rawBlocks.length;

  const scored = rawBlocks.map((block, index) => {
    const lower = block.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      let tf = 0;
      let pos = 0;
      while ((pos = lower.indexOf(term, pos)) !== -1) {
        tf++;
        pos += term.length;
      }
      if (tf > 0) {
        const normTf =
          (tf * (k1 + 1)) /
          (tf + k1 * (1 - b + b * (block.length / Math.max(1, avgLen))));
        score += normTf;
      }
    }
    // Boost headings and paragraphs containing numbers/citations/years
    if (/^#{1,4}\s/.test(block)) score *= 1.25;
    if (/\b(19\d\d|20[0-2]\d|\d+(\.\d+)?%)\b/.test(block)) score *= 1.15;

    return { index, block, score };
  });

  // Sort by BM25 score descending, take top blocks until maxChars is reached,
  // then restore original reading order so prose remains coherent.
  scored.sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  let currentChars = 0;
  for (const item of scored) {
    if (currentChars + item.block.length > maxChars && selected.length > 0) {
      continue;
    }
    selected.push(item);
    currentChars += item.block.length + 2;
    if (currentChars >= maxChars) break;
  }

  return selected
    .sort((a, b) => a.index - b.index)
    .map((s) => s.block)
    .join("\n\n");
}

/**
 * Fallback Skill Pack Matcher
 * Prevents `[SKILL] none — no domain tags or pack match` on investigative/empirical topics.
 */
export function resolveSkillPackWithFallback(
  topic: string,
  explicitTags: ReadonlyArray<string> = [],
): "academic" | "market" | "policy" {
  const combined = `${topic} ${explicitTags.join(" ")}`.toLowerCase();

  if (
    /\b(market|price|revenue|competitor|valuation|saas|stock|pricing|forecast|b2b|startup)\b/.test(
      combined,
    )
  ) {
    return "market";
  }
  if (
    /\b(law|regulation|compliance|policy|gdpr|statute|legal|government|directive|tax|dvla)\b/.test(
      combined,
    )
  ) {
    return "policy";
  }
  // Default investigative, scientific, historical, or "evidence about X" queries to academic.md
  return "academic";
}
