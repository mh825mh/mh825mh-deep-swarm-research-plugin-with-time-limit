import { describe, it, expect } from "vitest";
import {
  computeCrawlBudgetMs,
  resolveEffectiveRuntimeMs,
  FALLBACK_MODE_CAP_MS,
} from "../src/utils/timeBudget";

const MIN = 60_000;
const STANDARD_CAP = 20 * MIN;

describe("resolveEffectiveRuntimeMs", () => {
  it("uses the mode cap when the session limit is 0 (unlimited)", () => {
    expect(resolveEffectiveRuntimeMs(0, STANDARD_CAP)).toBe(STANDARD_CAP);
  });

  it("uses the smaller finite session limit", () => {
    expect(resolveEffectiveRuntimeMs(10 * MIN, STANDARD_CAP)).toBe(10 * MIN);
  });

  it("caps a session limit larger than the mode cap", () => {
    expect(resolveEffectiveRuntimeMs(60 * MIN, STANDARD_CAP)).toBe(STANDARD_CAP);
  });

  it("treats Infinity/NaN as unlimited and falls back to the mode cap", () => {
    expect(resolveEffectiveRuntimeMs(Infinity, STANDARD_CAP)).toBe(STANDARD_CAP);
    expect(resolveEffectiveRuntimeMs(NaN, STANDARD_CAP)).toBe(STANDARD_CAP);
  });

  it("falls back to a 20 minute cap when the mode cap is invalid", () => {
    expect(resolveEffectiveRuntimeMs(0, 0)).toBe(FALLBACK_MODE_CAP_MS);
    expect(resolveEffectiveRuntimeMs(0, NaN)).toBe(FALLBACK_MODE_CAP_MS);
    expect(computeCrawlBudgetMs(0, 0)).toBe(16 * MIN);
  });
});

describe("computeCrawlBudgetMs", () => {
  it("reserves 20 percent for synthesis", () => {
    expect(computeCrawlBudgetMs(0, STANDARD_CAP)).toBe(16 * MIN);
    expect(computeCrawlBudgetMs(10 * MIN, STANDARD_CAP)).toBe(8 * MIN);
  });

  it("never returns 0 ms for an unlimited session", () => {
    expect(computeCrawlBudgetMs(0, STANDARD_CAP)).toBeGreaterThan(0);
  });
});
