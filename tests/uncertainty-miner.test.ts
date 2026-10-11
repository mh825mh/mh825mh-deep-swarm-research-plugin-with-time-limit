import { describe, it, expect } from "vitest";
import { extractUncertaintyQueries } from "../src/swarm/uncertainty-miner";

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
