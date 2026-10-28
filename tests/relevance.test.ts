import { describe, it, expect } from "vitest";
import { computeRelevance } from "../src/net/extractor";

describe("computeRelevance", () => {
  it("accepts a page containing the distinctive keyword", () => {
    const text =
      "Reincarnation research examines past-life accounts and the evidence collectors have documented. " +
      "These studies focus on reincarnation cases reported by children.";
    const score = computeRelevance(text, "Reincarnation claims", "Evidence about reincarnation", ["reincarnation"]);
    expect(score).toBeGreaterThan(0);
  });

  it("rejects a page that only mentions generic words (e.g. RWE healthcare)", () => {
    const text =
      "Real world evidence (RWE) in healthcare is generated from routine clinical practice. " +
      "Regulators increasingly use this evidence to support approval decisions across therapy areas.";
    const score = computeRelevance(
      text,
      "Real-World Evidence (RWE) in Healthcare",
      "Evidence from clinical practice",
      ["reincarnation"],
    );
    expect(score).toBe(0);
  });

  it("gives partial credit instead of hard-rejecting one of two core terms", () => {
    const text =
      "Reincarnation is a central belief in several religions. Clinical evidence of past lives remains debated.";
    const score = computeRelevance(text, "Belief systems", "", ["reincarnation", "skeptic"]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.6);
  });

  it("matches a page containing every required keyword", () => {
    const text =
      "Reincarnation studies, while controversial, face sustained skepticism from critics who propose " +
      "alternative explanations for reported past-life memories.";
    const score = computeRelevance(text, "Reincarnation and skepticism", "", ["reincarnation", "skeptic"]);
    expect(score).toBeGreaterThan(0);
  });
});