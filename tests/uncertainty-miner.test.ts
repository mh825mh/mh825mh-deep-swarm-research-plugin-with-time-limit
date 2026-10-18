import { describe, it, expect } from "vitest";
import {
  extractUncertaintyQueries,
  filterNovelQueries,
  queryJaccard,
  shouldMineUncertainty,
} from "../src/swarm/uncertainty-miner";

describe("extractUncertaintyQueries", () => {
  const topic = "melatonin";

  it("returns [] for empty or whitespace-only traces", () => {
    expect(extractUncertaintyQueries("", topic)).toEqual([]);
    expect(extractUncertaintyQueries("   \n  \t", topic)).toEqual([]);
  });

  it("returns [] when no uncertainty pattern is present", () => {
    const trace = "The sky is blue. Grass is green and the model is confident.";
    expect(extractUncertaintyQueries(trace, topic)).toEqual([]);
  });

  it("derives a search query from an 'unclear' clause", () => {
    const trace = "It remains unclear how the mechanism operates.";
    expect(extractUncertaintyQueries(trace, topic)).toEqual([
      "melatonin mechanism operates",
    ]);
  });

  it("derives queries from multiple uncertainty patterns", () => {
    const trace = [
      "It remains unclear how the mechanism operates.",
      "There is no data on long-term effects in children.",
    ].join("\n");
    const queries = extractUncertaintyQueries(trace, topic);
    expect(queries).toContain("melatonin mechanism operates");
    expect(queries).toContain("melatonin long-term effects children");
    expect(queries.length).toBe(2);
  });

  it("handles 'conflicts with' and 'need to verify' patterns", () => {
    const trace =
      "This conflicts with the earlier cohort. I need to verify the sample size.";
    const queries = extractUncertaintyQueries(trace, topic);
    expect(queries.some((q) => q.includes("earlier cohort"))).toBe(true);
    expect(queries.some((q) => q.includes("sample size"))).toBe(true);
    expect(queries.every((q) => q.startsWith(topic))).toBe(true);
  });

  it("dedupes identical derived queries", () => {
    const trace = "The result is unclear. The result is unclear.";
    const queries = extractUncertaintyQueries(trace, topic);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("caps every query length and keeps the topic prefix", () => {
    const longClause =
      "It is unclear whether the extraordinarily long mechanistic pathway involving numerous intermediate signalling molecules and transcription factors actually generalises beyond the original narrow cohort of participants.";
    const queries = extractUncertaintyQueries(longClause, topic);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.length).toBeLessThanOrEqual(200);
      expect(q.startsWith(topic)).toBe(true);
    }
  });

  it("trims a long topic and still anchors the query", () => {
    const queries = extractUncertaintyQueries(
      "No evidence exists for the proposed pathway.",
      "  the   effects of   melatonin   ",
    );
    expect(queries.length).toBe(1);
    expect(queries[0].startsWith("the effects of melatonin")).toBe(true);
  });
});

describe("filterNovelQueries (Jaccard near-duplicate dedupe)", () => {
  it("drops a query that is a near-duplicate of one already searched", () => {
    const novel = filterNovelQueries(
      ["melatonin long-term effects children"],
      ["melatonin long term effects in children"],
    );
    expect(novel).toEqual([]);
  });

  it("keeps genuinely novel queries", () => {
    const novel = filterNovelQueries(
      ["melatonin paediatric dosing thresholds"],
      ["melatonin long-term effects children"],
    );
    expect(novel).toEqual(["melatonin paediatric dosing thresholds"]);
  });

  it("dedupes within the incoming batch as well as against prior queries", () => {
    const novel = filterNovelQueries(
      [
        "melatonin receptor binding affinity",
        "the melatonin receptor binding affinity",
        "melatonin circadian phase shift",
      ],
      [],
    );
    expect(novel).toHaveLength(2);
    expect(novel[0]).toContain("receptor");
    expect(novel[1]).toContain("circadian");
  });

  it("reports Jaccard similarity of 1 for identical token sets", () => {
    expect(queryJaccard("alpha beta gamma", "gamma beta alpha")).toBe(1);
  });

  it("reports 0 when either query has no tokens", () => {
    expect(queryJaccard("", "alpha beta")).toBe(0);
    expect(queryJaccard("!!!", "alpha beta")).toBe(0);
  });
});

describe("shouldMineUncertainty (budget gating)", () => {
  it("allows mining when time and LLM budget are both healthy", () => {
    expect(
      shouldMineUncertainty({
        elapsedFraction: 0.2,
        remainingLlmCalls: 40,
        activeWorkers: 5,
      }),
    ).toBeNull();
  });

  it("skips once more than 65% of the hard runtime has elapsed", () => {
    expect(
      shouldMineUncertainty({
        elapsedFraction: 0.66,
        remainingLlmCalls: 40,
        activeWorkers: 5,
      }),
    ).toBe("time-budget");
  });

  it("allows mining at the 65% elapsed boundary", () => {
    expect(
      shouldMineUncertainty({
        elapsedFraction: 0.65,
        remainingLlmCalls: 40,
        activeWorkers: 5,
      }),
    ).toBeNull();
  });

  it("skips when remaining LLM calls fall below activeWorkers + 3", () => {
    expect(
      shouldMineUncertainty({
        elapsedFraction: 0.1,
        remainingLlmCalls: 7,
        activeWorkers: 5,
      }),
    ).toBe("llm-budget");
  });

  it("allows mining exactly at the activeWorkers + 3 boundary", () => {
    expect(
      shouldMineUncertainty({
        elapsedFraction: 0.1,
        remainingLlmCalls: 8,
        activeWorkers: 5,
      }),
    ).toBeNull();
  });

  it("always requires the 3-call reserve even with a single worker", () => {
    expect(
      shouldMineUncertainty({
        elapsedFraction: 0.1,
        remainingLlmCalls: 3,
        activeWorkers: 1,
      }),
    ).toBe("llm-budget");
  });
});
