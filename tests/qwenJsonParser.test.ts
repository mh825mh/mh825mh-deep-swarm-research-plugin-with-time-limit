import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractCleanJsonString, parseQwenJson } from "../src/utils/qwenJsonParser";

const CriticSchema = z.object({
  onTopic: z.boolean(),
  claimStrength: z.enum(["high", "medium", "low"]),
});

describe("qwenJsonParser", () => {
  it("strips complete <think> blocks with stray braces inside reasoning", () => {
    const raw = `<think>\nLet me check if { "fake": true } works.\n</think>\n\`\`\`json\n{"onTopic": true, "claimStrength": "high"}\n\`\`\``;
    const result = parseQwenJson(raw, CriticSchema, { onTopic: false, claimStrength: "low" });
    expect(result).toEqual({ onTopic: true, claimStrength: "high" });
  });

  it("recovers fenced JSON even when <think> tag is unclosed", () => {
    const raw = `<think>Reasoning got cut off before closing tag... \`\`\`json\n{"onTopic": true, "claimStrength": "medium"}\n\`\`\``;
    const cleaned = extractCleanJsonString(raw);
    expect(JSON.parse(cleaned)).toEqual({ onTopic: true, claimStrength: "medium" });
  });

  it("returns fallback when output is completely truncated inside <think>", () => {
    const raw = `<think>Still thinking about the query and ran out of tokens...`;
    const fallback = { onTopic: false, claimStrength: "low" as const };
    expect(parseQwenJson(raw, CriticSchema, fallback)).toEqual(fallback);
  });
});
