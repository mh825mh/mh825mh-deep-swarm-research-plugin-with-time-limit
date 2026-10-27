import { describe, it, expect } from "vitest";
import {
  buildCoreTopicQuery,
  buildSafeSearchQuery,
  capQueryKeywords,
  tokenizeTopicQuery,
} from "../src/utils/topicQuery";

const LONG_TOPIC =
  "What are the core mechanisms, evidence, and primary sources of the Orthodox " +
  "Church Fathers' theology of deification (theosis) according to tradition?";

describe("buildCoreTopicQuery", () => {
  it("extracts the core entity from a 28-word research prompt", () => {
    expect(buildCoreTopicQuery(LONG_TOPIC, 4)).toBe(
      "Orthodox Church Fathers theology",
    );
  });

  it("keeps a short topic's core entity term", () => {
    expect(buildCoreTopicQuery("reincarnation evidence", 4)).toBe(
      "reincarnation",
    );
  });

  it("never returns an empty query for a stopword-only topic", () => {
    const q = buildCoreTopicQuery("the and of what how", 4);
    expect(q.length).toBeGreaterThan(0);
  });
});

describe("capQueryKeywords", () => {
  it("strips site operators and punctuation", () => {
    const q = capQueryKeywords(
      'protein folding (site:wikipedia.org OR site:britannica.com) 2025',
      10,
    );
    expect(q).not.toContain("site:");
    expect(q).not.toContain("(");
    expect(q).toBe("protein folding 2025");
  });

  it("caps the keyword count", () => {
    const q = capQueryKeywords("one two three four five six seven eight nine ten eleven", 10);
    expect(q.split(" ")).toHaveLength(10);
  });
});

describe("buildSafeSearchQuery", () => {
  it("keeps topic + suffix at or below the keyword cap", () => {
    const q = buildSafeSearchQuery(LONG_TOPIC, "recent developments updates", 10);
    expect(q.split(" ").length).toBeLessThanOrEqual(10);
    expect(q).not.toMatch(/\bsite:/);
  });
});

describe("tokenizeTopicQuery", () => {
  it("preserves meaningful hyphens and digits", () => {
    expect(tokenizeTopicQuery("COVID-19 2026 outlook")).toEqual([
      "COVID-19",
      "2026",
      "outlook",
    ]);
  });
});
