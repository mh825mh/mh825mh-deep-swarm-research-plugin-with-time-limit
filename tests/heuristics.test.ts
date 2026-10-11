import { describe, it, expect } from "vitest";
import { passesHeuristicFilter } from "../src/scoring/heuristics";

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
