/**
 * @file local/gatekeeper.ts
 * Cheap pre-flight gate that decides whether a run should search the local RAG
 * libraries. This is a repetitive binary classification, so reasoning tokens are
 * explicitly disabled (`reasoningEffort: 'none'` + `disableThinking`) — thinking
 * here only adds latency and can derail a YES/NO answer.
 *
 * The call uses a single isolated message array; nothing is carried over from
 * previous worker turns, so no `<think>` context chains leak into the gate.
 */

import { LMStudioClient } from "@lmstudio/sdk";
import { buildPredictionOptions } from "../utils/llm";
import { optimizeForQwen38 } from "../utils/qwenOptimizer";

export type GateDecision = "yes" | "no" | "error" | "unavailable";

export interface GatekeeperOptions {
  readonly topic: string;
  readonly signal?: AbortSignal;
}

/**
 * Asks the loaded model whether the topic explicitly requires personal /
 * internal / company documents.
 *
 * Returns a decision rather than a bare boolean so the caller can preserve its
 * original logging for the "no" and "error" cases:
 *   - "yes"         → the model said YES (keep local search on)
 *   - "no"          → the model said NO (bypass local search)
 *   - "error"       → the call failed (caller defaults to web-only)
 *   - "unavailable" → no model loaded (caller keeps its previous behavior)
 */
export async function topicNeedsLocalSources(
  options: GatekeeperOptions,
): Promise<GateDecision> {
  const { topic, signal } = options;
  try {
    if (signal?.aborted) return "error";
    const client = new LMStudioClient();
    const models = await client.llm.listLoaded();
    if (!models || models.length === 0) return "unavailable";
    const model = await client.llm.model(models[0].identifier);

    const gatePrompt = `Topic: "${topic}". Does this query explicitly ask for personal, internal, or company documents? Answer ONLY YES or NO.`;
    // Micro-call fast path: prefill an empty <think> block and append /no_think
    // so Qwen 3.8 never burns (or gets truncated inside) a reasoning trace for a
    // one-word YES/NO decision.
    const optimized = optimizeForQwen38(
      "gatekeeper",
      "You are a precise binary classifier. Reply with a single word.",
      gatePrompt,
    );
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: optimized.systemPrompt },
      { role: "user", content: optimized.userPrompt },
    ];
    if (optimized.assistantPrefill) {
      messages.push({ role: "assistant", content: optimized.assistantPrefill });
    }
    const stream = model.respond(
      messages as never,
      buildPredictionOptions({
        maxTokens: optimized.maxTokens,
        temperature: optimized.temperature,
        reasoningEffort: "none",
        disableThinking: true,
      }) as never,
    );

    let result = "";
    for await (const chunk of stream) result += chunk.content ?? "";
    return result.trim().toUpperCase().includes("NO") ? "no" : "yes";
  } catch {
    return "error";
  }
}
