import { describe, it, expect } from "vitest";
import { extractQwenJson, stripThinkTags, extractThinkBlocks } from "../src/utils/qwen-parser";

describe("stripThinkTags", () => {
  it("removes think blocks case-insensitively and across newlines", () => {
    const raw = "a<THINK>\nsecret\n</Think>b";
    expect(stripThinkTags(raw)).toBe("ab");
  });

  it("removes multiple think blocks", () => {
    const raw = "<think>one</think>keep<think>two</think>";
    expect(stripThinkTags(raw)).toBe("keep");
  });

  it("leaves non-think text untouched", () => {
    expect(stripThinkTags('{"a":1}')).toBe('{"a":1}');
  });

  it("sweeps up unbalanced tags left by nested blocks", () => {
    const raw = "outer<think>outer <think>inner</think> tail</think>";
    expect(stripThinkTags(raw).includes("think")).toBe(false);
  });

  it("removes a truncated/unclosed <think> block to end of string", () => {
    expect(stripThinkTags("keep this<think>cut off mid senten")).toBe("keep this");
  });

  it("keeps text that precedes a truncated reasoning prefix", () => {
    expect(stripThinkTags('{"ok":true}<THINK>reasoning')).toBe('{"ok":true}');
  });
});

describe("extractThinkBlocks", () => {
  it("returns the inner text of a single think block", () => {
    expect(extractThinkBlocks("a <think>reasoning here</think> b")).toBe(
      "reasoning here",
    );
  });

  it("joins multiple think blocks and ignores non-think text", () => {
    expect(
      extractThinkBlocks("<think>Premise.</think> Between. <think>Conclusion.</think>"),
    ).toBe("Premise.\n\nConclusion.");
  });

  it("returns an empty string when no think block is present", () => {
    expect(extractThinkBlocks("just an answer")).toBe("");
    expect(extractThinkBlocks("")).toBe("");
  });
});

describe("extractQwenJson", () => {
  it("parses a raw JSON object", () => {
    expect(extractQwenJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a raw JSON array", () => {
    expect(extractQwenJson('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("parses markdown-fenced JSON", () => {
    expect(extractQwenJson('```json\n{"workers": []}\n```')).toEqual({
      workers: [],
    });
  });

  it("strips a think block before the JSON payload", () => {
    const raw = '<think>reasoning {not json} here</think>\n{"ok":true}';
    expect(extractQwenJson(raw)).toEqual({ ok: true });
  });

  it("handles nested <think> blocks", () => {
    const raw = "<think>outer <think>inner</think> tail</think>{\"ok\":true}";
    expect(extractQwenJson(raw)).toEqual({ ok: true });
  });

  it("ignores leading chatter and trailing commentary", () => {
    const raw = 'Sure! Here is the plan: {"verdicts":[]} — hope that helps.';
    expect(extractQwenJson(raw)).toEqual({ verdicts: [] });
  });

  it("strips an unclosed <think> prefix left by max-token truncation", () => {
    const raw = '<think>Let me reason about this {"verdicts": [{"cardId": "E1"';
    // No JSON survives an unclosed reasoning block that swallowed the payload.
    expect(() => extractQwenJson(raw)).toThrow();
  });

  it("recovers JSON that precedes an unclosed truncated <think> block", () => {
    const raw = '{"verdicts":[]}<think>now I will double-check every claim and';
    expect(extractQwenJson(raw)).toEqual({ verdicts: [] });
  });

  it("strips an unclosed <think> block that contains braces", () => {
    const raw = '<think>{"fake":true} then it got cut off{"workers":[]}';
    expect(() => extractQwenJson(raw)).toThrow();
  });

  it("strips a truncated block followed by JSON that was swallowed inside it", () => {
    const raw = '<think>reasoning that was cut off mid senten\n{"ok":true}';
    // The JSON sits inside the unterminated block, so it is not trusted.
    expect(() => extractQwenJson(raw)).toThrow();
  });

  it("throws on output that is only reasoning", () => {
    expect(() => extractQwenJson("<think>only reasoning</think>")).toThrow();
  });

  it("throws on an unterminated think block with no JSON at all", () => {
    expect(() => extractQwenJson("<think>still thinking and thinking")).toThrow();
  });

  it("throws on malformed JSON", () => {
    expect(() => extractQwenJson("{not: valid}")).toThrow(/extractQwenJson/);
  });

  it("throws on empty output", () => {
    expect(() => extractQwenJson("")).toThrow();
  });
});
