/**
 * @file utils/qwen-parser.ts
 * Robust parsing helpers for Qwen-style reasoning models (and any model that
 * emits `<think>...</think>` blocks). Reasoning tokens are stripped before JSON
 * extraction so a chain-of-thought prefix can never break a structured-output
 * pipeline.
 */

/** Reasoning effort knob threaded into the LLM layer. */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const ORPHAN_THINK_TAG_RE = /<\/?think\b[^>]*>/gi;

/**
 * Removes every `<think>...</think>` block (case-insensitive, multi-line).
 * Repeated passes plus an orphan-tag sweep also clean up nested blocks, which a
 * single non-greedy regex pass would leave behind.
 */
export function stripThinkTags(raw: string): string {
  if (!raw) return "";
  let out = raw;
  let prev: string;
  do {
    prev = out;
    out = out.replace(THINK_BLOCK_RE, "");
  } while (out !== prev);
  // Sweep up any unbalanced tags a nested block left behind.
  return out.replace(ORPHAN_THINK_TAG_RE, "");
}

/** Strips a single outer ```/```json Markdown fence, matching the legacy paths. */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/**
 * Extracts and parses the JSON payload from a raw model completion.
 *
 * Pipeline: strip `<think>` blocks → strip Markdown fences → slice from the
 * first `{`/`[` to the last `}`/`]` → parse. This tolerates leading chatter
 * ("Here is the JSON:") and trailing commentary, and cannot be defeated by a
 * reasoning prefix that itself happens to contain braces.
 *
 * @throws descriptive Error when no JSON is present or parsing fails.
 */
export function extractQwenJson<T = unknown>(rawOutput: string): T {
  const withoutThink = stripThinkTags(rawOutput ?? "");
  const cleaned = stripCodeFences(withoutThink);

  if (!cleaned) {
    throw new Error(
      "extractQwenJson: empty model output after stripping <think> blocks and code fences.",
    );
  }

  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length === 0) {
    throw new Error("extractQwenJson: no JSON object or array found in model output.");
  }
  const start = Math.min(...starts);

  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (end < start) {
    throw new Error("extractQwenJson: unbalanced JSON boundaries in model output.");
  }

  const payload = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`extractQwenJson: failed to parse extracted JSON (${reason}).`);
  }
}
