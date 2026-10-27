import { describe, it, expect } from "vitest";
import {
  InRunQueryTracker,
  normalizeQueryKey,
  sanitizeSearchQuery,
} from "../src/net/queryCache";

describe("InRunQueryTracker", () => {
  it("allows each (engine, query) pair exactly once", () => {
    const tracker = new InRunQueryTracker();
    expect(tracker.shouldExecute("searxng", "church fathers")).toBe(true);
    expect(tracker.shouldExecute("searxng", "  Church   Fathers ")).toBe(false);
    expect(tracker.shouldExecute("ddg", "church fathers")).toBe(true);
    expect(tracker.hasRun("searxng", "church fathers")).toBe(true);
  });

  it("resets between runs", () => {
    const tracker = new InRunQueryTracker();
    tracker.shouldExecute("searxng", "q");
    tracker.reset();
    expect(tracker.shouldExecute("searxng", "q")).toBe(true);
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeQueryKey("  Church   Fathers ")).toBe("church fathers");
  });
});

describe("sanitizeSearchQuery", () => {
  it("strips OpenAlex/Abstract metadata from critic retry input", () => {
    const raw =
      "[OpenAlex Peer-Reviewed Work] Title: Patristic Theology Year: 2022 " +
      "Abstract: In this paper the authors examine deification in the Church Fathers.";
    const q = sanitizeSearchQuery("orthodox church fathers theology", 10);
    const retry = sanitizeSearchQuery(`${q} ${raw}`, 10);

    expect(retry).not.toContain("[");
    expect(retry).not.toContain("Abstract");
    expect(retry).not.toContain("Title:");
    expect(retry.split(/\s+/).length).toBeLessThanOrEqual(10);
    expect(retry).toContain("orthodox");
  });

  it("removes site operators, year stuffing, and duplicate words", () => {
    const q = sanitizeSearchQuery(
      "church fathers site:wikipedia.org church fathers 2025 2026",
      10,
    );
    expect(q).not.toContain("site:");
    expect(q).not.toContain("2025");
    expect(q.split(" ").filter((w) => w === "church")).toHaveLength(1);
  });
});
