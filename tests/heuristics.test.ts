import { describe, it, expect } from "vitest";
import { passesHeuristicFilter, lexicalScore } from "../src/scoring/heuristics";

/** Pads a string to comfortably exceed the 180-char minimum. */
function padded(text: string): string {
  return (text + " " + "lorem ipsum dolor sit amet consectetur ".repeat(6)).trim();
}

describe("passesHeuristicFilter", () => {
  it("rejects snippets shorter than the minimum length", () => {
    const result = passesHeuristicFilter({
      url: "https://example.com",
      title: "Short",
      text: "too short to matter",
      query: "reincarnation evidence",
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/too short/);
  });

  it("rejects when query keyword overlap is below the threshold", () => {
    const result = passesHeuristicFilter({
      url: "https://example.com",
      title: "Quarterly accounting",
      text: padded("completely unrelated subject matter about bookkeeping"),
      query: "reincarnation evidence studies",
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/overlap/);
  });

  it("rejects boilerplate / paywall signatures", () => {
    const result = passesHeuristicFilter({
      url: "https://example.com",
      title: "Access Denied",
      text: padded("reincarnation evidence studies are documented here"),
      query: "reincarnation evidence studies",
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/boilerplate/);
  });

  it("passes a long, on-topic snippet", () => {
    const result = passesHeuristicFilter({
      url: "https://example.com",
      title: "Reincarnation evidence",
      text: padded("reincarnation evidence studies document controlled cases"),
      query: "reincarnation evidence studies",
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("passes when the query has no distinctive keywords", () => {
    const result = passesHeuristicFilter({
      url: "https://example.com",
      title: "Anything",
      text: padded("a sufficiently long body of text with no query words"),
      query: "a in of",
    });
    expect(result.pass).toBe(true);
  });
});

describe("lexicalScore", () => {
  it("ranks a long, on-topic passage as high tier", () => {
    const scored = lexicalScore({
      url: "https://example.com",
      title: "Reincarnation evidence",
      text: padded("reincarnation evidence studies document controlled cases"),
      query: "reincarnation evidence studies",
    });
    expect(scored.tier).toBe("high");
    expect(scored.score).toBeGreaterThanOrEqual(0.55);
  });

  it("ranks a short, off-topic snippet as low tier", () => {
    const scored = lexicalScore({
      url: "https://example.com",
      title: "Quarterly accounting",
      text: "bookkeeping ledger entries and tax filings",
      query: "reincarnation evidence studies",
    });
    expect(scored.tier).toBe("low");
    expect(scored.overlap).toBe(0);
  });

  it("gates a navigation wall out before tiering and never outranks on-topic prose", () => {
    const wallInput = {
      url: "https://example.com",
      title: "Unrelated",
      text: "nav home about contact login subscribe ".repeat(40),
      query: "reincarnation evidence studies",
    };
    // The strict lexical gate drops it before any tier decision is made.
    expect(passesHeuristicFilter(wallInput).pass).toBe(false);
    // And its substance-only score still sits below a precise on-topic passage.
    const wall = lexicalScore(wallInput);
    const good = lexicalScore({
      url: "https://example.com",
      title: "Reincarnation evidence",
      text: padded("reincarnation evidence studies document controlled cases"),
      query: "reincarnation evidence studies",
    });
    expect(wall.score).toBeLessThan(good.score);
  });
});
