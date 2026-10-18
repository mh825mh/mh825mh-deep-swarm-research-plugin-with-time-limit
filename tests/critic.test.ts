import { describe, it, expect } from "vitest";
import { getDepthProfile } from "../src/constants";
import { buildEvidenceCards } from "../src/scoring/evidence";
import {
  parseCriticLines,
  parseVerdicts,
  gradeCardFallback,
  buildRetryQueries,
} from "../src/scoring/critic";
import { deriveContradictions } from "../src/synthesis/ai";
import { CrawledSource, EvidenceCard, GradedEvidenceCard } from "../src/types";

function makeSource(overrides: Partial<CrawledSource> = {}): CrawledSource {
  return {
    url: "https://example.com/2024/01/01/title",
    finalUrl: "https://example.com/2024/01/01/title",
    title: "Example Article",
    description: "A report on reincarnation case studies.",
    published: "2024-01-01",
    text:
      "This article examines the evidence collected from reincarnation studies by child subjects. " +
      "Researchers documented a peer-reviewed controlled study with detailed case accounts.",
    wordCount: 60,
    outlinks: [],
    sourceQuery: "reincarnation evidence",
    workerRole: "breadth",
    workerLabel: "Breadth",
    domainScore: 80,
    freshnessScore: 80,
    tier: "news",
    relevanceScore: 0.7,
    origin: "web",
    ...overrides,
  };
}

function makeCard(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    id: "E1",
    entityType: "web",
    title: "Example Article",
    authorOrHost: "example.com",
    canonicalUrl: "https://example.com/2024/01/01/title",
    sourceTier: "news",
    relevantClaim: "Reincarnation case studies were documented by researchers.",
    supportingExcerpt: "Researchers documented a peer-reviewed controlled study.",
    confidence: "High",
    claimStrength: "disputed",
    freshness: "2024-01-01",
    worker: "Breadth",
    verificationTier: "B",
    metadataConfidence: 0.6,
    topicFit: 0.7,
    recommendationStrength: 0.5,
    entityMetadata: { publisher: "example.com", officialUrl: "https://example.com/2024/01/01/title" },
    ...overrides,
  };
}

describe("buildEvidenceCards", () => {
  const profile = getDepthProfile("standard");

  it("assigns E{k+1} ids aligned to source order", () => {
    const cards = buildEvidenceCards([makeSource(), makeSource({ url: "https://two.com/article" })], profile);
    expect(cards.map((c) => c.id)).toEqual(["E1", "E2"]);
  });

  it("marks low-relevance sources as REJECTED", () => {
    const cards = buildEvidenceCards([makeSource({ relevanceScore: 0.2 })], profile);
    expect(cards[0].verificationTier).toBe("REJECTED");
  });

  it("promotes official academic sources to tier A with strong recommendation strength", () => {
    const cards = buildEvidenceCards(
      [makeSource({ domainScore: 95, tier: "academic", relevanceScore: 0.9 })],
      profile,
    );
    expect(cards[0].verificationTier).toBe("A");
  });

  it("tags peer-reviewed claims as documented", () => {
    const cards = buildEvidenceCards(
      [makeSource({ domainScore: 95, tier: "academic" })],
      profile,
    );
    expect(cards[0].claimStrength).toBe("documented");
  });
});

describe("parseCriticLines", () => {
  it("parses strict verdict lines and skips malformed input", () => {
    const raw = [
      "CARD: E1 | ONTOPIC: YES | DATE: 2024-03-15 | NATURE: PRIMARY | CONFLICTS: NONE | STRENGTH: documented | PASS: YES | NOTE: original trial",
      "CARD: E2 | ONTOPIC: NO | DATE: NONE | NATURE: SECONDARY | CONFLICTS: E1 | STRENGTH: disputed | PASS: NO | NOTE: editorial",
      "this line is not a card",
      "CARD: E3 | ONTOPIC: YES | DATE: 2019 | NATURE: UNKNOWN | CONFLICTS: E1;E2 | STRENGTH: anecdote | PASS: NO | NOTE: old",
    ].join("\n");

    const parsed = parseCriticLines(raw);

    expect(parsed.get("E1")).toMatchObject({
      onTopic: true,
      dated: "dated",
      sourceNature: "primary",
      contradicts: [],
      claimStrength: "documented",
      pass: true,
    });
    expect(parsed.get("E2")).toMatchObject({
      onTopic: false,
      dated: "undated",
      sourceNature: "secondary",
      contradicts: ["E1"],
      pass: false,
    });
    expect(parsed.get("E3")).toMatchObject({ dated: "stale", contradicts: ["E1", "E2"] });
    expect(parsed.size).toBe(3);
  });
});

describe("gradeCardFallback", () => {
  it("grades undated news cards as secondary / undated but passing by default", () => {
    const graded = gradeCardFallback(makeCard(), ["reincarnation"]);
    expect(graded.critic.sourceNature).toBe("secondary");
    expect(graded.critic.dated).toBe("dated");
    expect(graded.critic.onTopic).toBe(true);
    expect(graded.critic.pass).toBe(true);
  });

  it("marks old sources as stale", () => {
    const graded = gradeCardFallback(
      makeCard({ freshness: "2015-06-01", canonicalUrl: "https://example.com/2015/06/report" }),
    );
    expect(graded.critic.dated).toBe("stale");
  });

  it("keeps academic sources primary", () => {
    const graded = gradeCardFallback(makeCard({ sourceTier: "academic" }));
    expect(graded.critic.sourceNature).toBe("primary");
  });

  it("fails cards that share no topic keywords when keywords are provided", () => {
    const card = makeCard({ relevantClaim: "Quantum computing benchmarks and gate fidelity." });
    const graded = gradeCardFallback(card, ["reincarnation", "past-life"]);
    expect(graded.critic.onTopic).toBe(false);
    expect(graded.critic.pass).toBe(false);
  });
});

describe("deriveContradictions", () => {
  it("maps critic conflicts to contradiction entries with 1-based indices", () => {
    const a: GradedEvidenceCard = {
      ...makeCard({ id: "E1", claimStrength: "documented", relevantClaim: "The effect is real." }),
      critic: {
        cardId: "E1", onTopic: true, dated: "dated", sourceNature: "primary",
        contradicts: [], claimStrength: "documented", pass: true, note: "",
      },
    };
    const b: GradedEvidenceCard = {
      ...makeCard({ id: "E2", title: "Skeptic Review", claimStrength: "disputed", relevantClaim: "The effect does not replicate." }),
      critic: {
        cardId: "E2", onTopic: true, dated: "dated", sourceNature: "secondary",
        contradicts: ["E1"], claimStrength: "disputed", pass: false, note: "conflicts E1",
      },
    };

    const entries = deriveContradictions([a, b]);
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceA.index).toBe(2);
    expect(entries[0].sourceB.index).toBe(1);
    expect(entries[0].severity).toBe("major");
  });

  it("emits each contradiction pair once and skips unknown ids", () => {
    const a: GradedEvidenceCard = {
      ...makeCard({ id: "E1" }),
      critic: {
        cardId: "E1", onTopic: true, dated: "dated", sourceNature: "primary",
        contradicts: ["E2", "E9"], claimStrength: "documented", pass: false, note: "",
      },
    };
    const b: GradedEvidenceCard = {
      ...makeCard({ id: "E2" }),
      critic: {
        cardId: "E2", onTopic: true, dated: "dated", sourceNature: "secondary",
        contradicts: ["E1"], claimStrength: "documented", pass: false, note: "",
      },
    };

    const entries = deriveContradictions([a, b]);
    expect(entries).toHaveLength(1);
  });
});

describe("buildRetryQueries", () => {
  it("only failing claims trigger queries, deduped and capped", () => {
    const failed = [
      { relevantClaim: "Reincarnation claims lack controlled data." },
      { relevantClaim: "Reincarnation claims lack controlled data." },
      { relevantClaim: "" },
      { relevantClaim: "Critics dispute the documented methodology." },
      { relevantClaim: "A fifth entirely different focus object." },
    ];
    const queries = buildRetryQueries(failed, "reincarnation", 3);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("reincarnation");
    expect(queries[0]).toContain("controlled data");
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe("parseVerdicts (item 4 structured output)", () => {
  it("maps the flat wire verdict onto the internal verdict fragment", () => {
    const raw = JSON.stringify({
      verdicts: [
        {
          cardId: "E1",
          onTopic: true,
          hasDate: true,
          contradictsLedger: true,
          claimStrength: "high",
          extractedClaim: "The trial documented a controlled effect.",
          sourceUrl: "https://example.com/a",
        },
      ],
    });
    // `contradictsLedger` is attributed to the accepted ledger window ids.
    const map = parseVerdicts(raw, ["E2", "E3"]);
    expect(map.size).toBe(1);
    const v = map.get("E1");
    expect(v?.pass).toBe(false);
    expect(v?.contradicts).toEqual(["E2", "E3"]);
    expect(v?.dated).toBe("dated");
    expect(v?.claimStrength).toBe("documented");
    expect(v?.extractedClaim).toBe("The trial documented a controlled effect.");
    expect(v?.sourceUrl).toBe("https://example.com/a");
  });

  it("maps low/high flat claim strength onto the internal enum", () => {
    const raw = JSON.stringify({
      verdicts: [
        {
          cardId: "E4",
          onTopic: true,
          hasDate: false,
          contradictsLedger: false,
          claimStrength: "low",
        },
      ],
    });
    const v = parseVerdicts(raw).get("E4");
    expect(v?.dated).toBe("undated");
    expect(v?.claimStrength).toBe("speculation");
    expect(v?.pass).toBe(true);
  });

  it("accepts a bare array of flat verdicts", () => {
    const raw = JSON.stringify([
      {
        cardId: "E7",
        onTopic: true,
        hasDate: false,
        contradictsLedger: false,
        claimStrength: "medium",
      },
    ]);
    const map = parseVerdicts(raw);
    expect(map.get("E7")?.onTopic).toBe(true);
  });

  it("strips markdown fences before JSON parsing", () => {
    const raw = "```json\n{\"verdicts\": []}\n```";
    expect(parseVerdicts(raw).size).toBe(0);
  });

  it("falls back to the CARD: line parser when output is not JSON", () => {
    const raw = [
      "CARD: E3 | ONTOPIC: YES | DATE: 2024 | NATURE: PRIMARY | CONFLICTS: NONE | STRENGTH: DOCUMENTED | PASS: YES | NOTE: clean",
    ].join("\n");
    const map = parseVerdicts(raw);
    expect(map.get("E3")?.pass).toBe(true);
  });

  it("returns an empty map for garbage output", () => {
    expect(parseVerdicts("no structured data here").size).toBe(0);
  });
});