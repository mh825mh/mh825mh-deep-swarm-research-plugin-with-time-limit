import { describe, it, expect } from "vitest";
import { verifyCitations, resolveCitation } from "../src/synthesis/verify";

const LEDGER = [
  { id: "E1", canonicalUrl: "https://example.com/2024/01/01/a" },
  { id: "E2", canonicalUrl: "https://www.example.com/2024/02/02/b/" },
  { id: "E3", canonicalUrl: "https://ar5iv.example.org/abs/2001.00001" },
];

describe("verifyCitations", () => {
  it("passes when every citation resolves and every URL is canonical", () => {
    const md = [
      "# Report",
      "",
      "The study documented the effect [1] and was replicated later [2].",
      "The authors host the paper at https://example.com/2024/02/02/b.",
    ].join("\n");
    const result = verifyCitations(md, LEDGER);
    expect(result.pass).toBe(true);
    expect(result.orphanIndices).toEqual([]);
    expect(result.foreignUrls).toEqual([]);
  });

  it("treats normalized URLs as equal (www, trailing slash, fragment, case)", () => {
    const md = "See https://EXAMPLE.com/2024/02/02/b#frag and https://www.example.com/2024/02/02/b .";
    const result = verifyCitations(md, LEDGER);
    expect(result.foreignUrls).toEqual([]);
  });

  it("flags orphan citation indices", () => {
    const md = "Claims exist [1] and more [7] and [99].";
    const result = verifyCitations(md, LEDGER);
    expect(result.pass).toBe(false);
    expect(result.orphanIndices).toEqual(["E7", "E99"]);
  });

  it("flags URLs that are not ledger canonicals", () => {
    const md = "Source: https://example.com/2024/01/01/a and a stranger https://evil.example.net/pwned.";
    const result = verifyCitations(md, LEDGER);
    expect(result.pass).toBe(false);
    expect(result.foreignUrls).toEqual(["https://evil.example.net/pwned"]);
  });

  it("ignores escaped brackets so literal [n] text is not treated as a citation", () => {
    const md = "Literal \[1\] is escaped, real one [1].";
    const result = verifyCitations(md, LEDGER);
    expect(result.pass).toBe(true);
    expect(result.orphanIndices).toEqual([]);
  });

  it("passes with no citations and no urls", () => {
    expect(verifyCitations("Just prose.", LEDGER).pass).toBe(true);
  });

  it("accepts a card's resolved sourceUrl as provenance for that card", () => {
    const ledger = [
      {
        id: "E1",
        canonicalUrl: "https://example.com/article",
        sourceUrl: "https://www.example.com/article?utm_source=news",
        citationAnchor: "[1]",
      },
    ];
    const md = "See https://www.example.com/article?utm_source=news [1].";
    const result = verifyCitations(md, ledger);
    expect(result.pass).toBe(true);
    expect(result.foreignUrls).toEqual([]);
  });
});

describe("resolveCitation", () => {
  it("resolves a 1-based index to its ledger entry", () => {
    expect(resolveCitation(2, LEDGER)?.id).toBe("E2");
  });

  it("returns undefined for unknown indices", () => {
    expect(resolveCitation(42, LEDGER)).toBeUndefined();
  });
});