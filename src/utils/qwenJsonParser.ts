import { ZodSchema } from "zod";

/**
 * Strips closed and unclosed <think> blocks, removes markdown code fences,
 * and extracts the outermost JSON object or array for Zod validation.
 */
export function extractCleanJsonString(rawOutput: string): string {
  // 1. Strip complete <think>...</think> blocks (case-insensitive, multiline)
  let cleaned = rawOutput.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. If an unclosed <think> tag remains, look for the last JSON block after reasoning
  if (/<think>/i.test(cleaned)) {
    const thinkIndex = cleaned.search(/<think>/i);
    const afterThink = cleaned.slice(thinkIndex + 7);
    const fenceMatch = afterThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
      cleaned = fenceMatch[1].trim();
    } else {
      const firstBrace = afterThink.indexOf("{");
      cleaned = firstBrace !== -1 ? afterThink.slice(firstBrace).trim() : "";
    }
  }

  // 3. Strip standard markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 4. Slice from first '{' or '[' to matching last '}' or ']'
  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  let start = -1;
  let end = -1;

  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    end = cleaned.lastIndexOf("}");
  } else if (firstArr !== -1) {
    start = firstArr;
    end = cleaned.lastIndexOf("]");
  }

  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }

  return cleaned;
}

export function parseQwenJson<T>(rawOutput: string, schema: ZodSchema<T>, fallback: T): T {
  try {
    const jsonStr = extractCleanJsonString(rawOutput);
    if (!jsonStr) return fallback;
    const parsed = JSON.parse(jsonStr);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}
