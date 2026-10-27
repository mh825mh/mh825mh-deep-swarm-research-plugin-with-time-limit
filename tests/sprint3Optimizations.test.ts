import { describe, it, expect, afterEach, vi } from "vitest";
import {
  optimizeForQwen38,
  extractTopBm25Windows,
  resolveSkillPackWithFallback,
} from "../src/utils/qwenOptimizer";
import {
  SingleflightUrlFetcher,
  shouldFetchSerpCandidate,
  selectAdaptiveFallbackDimensions,
  buildKvCachePinnedMessages,
} from "../src/swarm/singleflightAndSnippetGate";
import { seedFromTierZeroJsonApis } from "../src/net/tierZeroJsonSeeder";
import { buildQueryPlan } from "../src/planning/planner";
import { getDepthProfile } from "../src/constants";

describe("optimizeForQwen38", () => {
  it("suppresses reasoning on micro-calls with prefill + /no_think", () => {
    const cfg = optimizeForQwen38("gatekeeper", "classify", "topic?");
    expect(cfg.assistantPrefill).toBe("<think>\n</think>\n");
    expect(cfg.temperature).toBe(0);
    expect(cfg.maxTokens).toBe(32);
    expect(cfg.systemPrompt.endsWith("/no_think")).toBe(true);
    expect(cfg.userPrompt.endsWith("/no_think")).toBe(true);
  });

  it("keeps full reasoning for planner / synthesizer calls", () => {
    const plan = optimizeForQwen38("planner", "sys", "user", 2048);
    expect(plan.assistantPrefill).toBeUndefined();
    expect(plan.maxTokens).toBe(2048);
    const synth = optimizeForQwen38("synthesizer", "sys", "user", 4096);
    expect(synth.assistantPrefill).toBeUndefined();
    expect(synth.maxTokens).toBe(4096);
  });
});

describe("extractTopBm25Windows", () => {
  it("returns content unchanged when it already fits", () => {
    const text = "short paragraph about reincarnation";
    expect(extractTopBm25Windows(text, "reincarnation", 500)).toBe(text);
  });

  it("keeps the query-relevant paragraph and drops the rest", () => {
    const filler = Array.from(
      { length: 8 },
      (_, i) => `Recipe block ${i}: mix flour, sugar and butter for a cake.`,
    ).join("\n\n");
    const relevant =
      "Reincarnation evidence: peer-reviewed case studies document children recalling past lives.";
    const text = `${filler}\n\n${relevant}`;
    const out = extractTopBm25Windows(text, "reincarnation evidence", 120);
    expect(out).toContain("Reincarnation evidence");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("resolveSkillPackWithFallback", () => {
  it("classifies market, policy, and academic topics", () => {
    expect(resolveSkillPackWithFallback("SaaS pricing and competitor analysis")).toBe("market");
    expect(resolveSkillPackWithFallback("GDPR compliance and regulation")).toBe("policy");
    expect(resolveSkillPackWithFallback("evidence about reincarnation")).toBe("academic");
    expect(resolveSkillPackWithFallback("anything at all", ["history"])).toBe("academic");
  });
});

describe("SingleflightUrlFetcher", () => {
  it("collapses concurrent fetches of the same normalized URL into one call", async () => {
    const sf = new SingleflightUrlFetcher<number>();
    let calls = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((res) => {
      release = res;
    });
    const fetcher = () => {
      calls++;
      return gate;
    };

    const a = sf.fetchOnce("https://Example.com/Path?utm_source=x", fetcher);
    const b = sf.fetchOnce("https://example.com/path/", fetcher);
    release(7);

    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(calls).toBe(1);
    expect(sf.getStats().dedupedRequestsSaved).toBe(1);
  });

  it("serves repeated (sequential) fetches from the completed cache", async () => {
    const sf = new SingleflightUrlFetcher<string>();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "body";
    };
    await sf.fetchOnce("https://a.test/x", fetcher);
    await sf.fetchOnce("https://a.test/x", fetcher);
    expect(calls).toBe(1);
    expect(sf.getStats()).toEqual({ cachedUrls: 1, dedupedRequestsSaved: 1 });
  });

  it("reset() drops in-flight + completed state for the next run", async () => {
    const sf = new SingleflightUrlFetcher<string>();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "body";
    };
    await sf.fetchOnce("https://a.test/x", fetcher);
    sf.reset();
    expect(sf.getStats()).toEqual({ cachedUrls: 0, dedupedRequestsSaved: 0 });
    await sf.fetchOnce("https://a.test/x", fetcher);
    expect(calls).toBe(2);
  });
});

describe("shouldFetchSerpCandidate", () => {
  it("rejects login / low-value URL patterns before any fetch", () => {
    const gate = shouldFetchSerpCandidate(
      { url: "https://x.com/login", title: "Sign in", snippet: "", engine: "ddg" },
      "reincarnation evidence",
      "Gap: Overview",
    );
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("low_value_url_pattern");
  });

  it("rejects candidates with no core topic term in title/snippet", () => {
    const gate = shouldFetchSerpCandidate(
      { url: "https://sports.example.com/scores", title: "Football scores", snippet: "Latest match results", engine: "ddg" },
      "reincarnation evidence",
      "Gap: Evidence",
    );
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("missing_core_topic_term");
  });

  it("allows on-topic candidates and boosts authoritative domains", () => {
    const good = shouldFetchSerpCandidate(
      { url: "https://www.nih.gov/reincarnation-evidence", title: "Reincarnation evidence study", snippet: "peer reviewed", engine: "ddg" },
      "reincarnation evidence",
      "Gap: Evidence",
    );
    expect(good.allow).toBe(true);
    expect(good.score).toBeGreaterThan(0.18);
  });
});

describe("selectAdaptiveFallbackDimensions", () => {
  it("caps to the requested dimension count", () => {
    expect(selectAdaptiveFallbackDimensions("x", 2)).toHaveLength(2);
  });

  it("picks scientific dimensions for empirical topics", () => {
    const dims = selectAdaptiveFallbackDimensions("evidence about reincarnation", 4);
    expect(dims).toHaveLength(4);
    expect(dims.map((d) => d.id)).toContain("dim_evidence");
    expect(dims[0].id).toBe("dim_overview");
  });

  it("picks technical and market dimensions by topic intent", () => {
    const tech = selectAdaptiveFallbackDimensions("kotlin android plugin architecture");
    expect(tech.map((d) => d.id)).toContain("dim_how_it_works");
    const biz = selectAdaptiveFallbackDimensions("acme ltd market pricing");
    expect(biz.map((d) => d.id)).toContain("dim_economics");
  });

  it("keeps long-topic fallback queries short and free of years/operators", () => {
    const topic =
      "What are the core mechanisms, evidence, and primary sources of the " +
      "Orthodox Church Fathers' theology of deification (theosis) according to tradition?";
    const dims = selectAdaptiveFallbackDimensions(topic, 4);
    const queries = dims.flatMap((d) => d.queries);

    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.split(/\s+/).length).toBeLessThanOrEqual(10);
      expect(q).not.toMatch(/\bsite:/);
      expect(q).not.toMatch(/\b2025\b|\b2026\b/);
      expect(q.toLowerCase()).toContain("orthodox");
    }
  });
});

describe("deterministic planner query hygiene", () => {
  it("caps fallback queries at 10 keywords without years or site operators", async () => {
    const topic =
      "What are the core mechanisms, evidence, and primary sources of the " +
      "Orthodox Church Fathers' theology of deification (theosis) according to tradition?";
    const plan = await buildQueryPlan(
      topic,
      [],
      false,
      () => {},
      getDepthProfile("standard"),
    );
    const queries = Object.values(plan.queriesByRole).flatMap((qs) => qs ?? []);

    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(10);
      expect(q).not.toMatch(/\bsite:/);
      expect(q).not.toMatch(/\b2025\b|\b2026\b/);
    }
  });
});

describe("buildKvCachePinnedMessages", () => {
  it("keeps the system prefix byte-identical across calls with the same rubric", () => {
    const a = buildKvCachePinnedMessages("RUBRIC BODY", "CRITIC", "payload 1");
    const b = buildKvCachePinnedMessages("RUBRIC BODY", "CRITIC", "payload 2");
    expect(a.system).toBe(b.system);
    expect(a.system).toContain("[DOMAIN RUBRIC]");
    expect(a.user).not.toBe(b.user);
  });

  it("omits the rubric when no skill pack is supplied", () => {
    const { system } = buildKvCachePinnedMessages(undefined, "PLANNER", "");
    expect(system).not.toContain("[DOMAIN RUBRIC]");
  });

  it("appends /no_think in no-think mode", () => {
    const { user } = buildKvCachePinnedMessages(undefined, "CRITIC", "payload", true);
    expect(user.endsWith("/no_think")).toBe(true);
  });
});

describe("seedFromTierZeroJsonApis", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses OpenAlex + Wikipedia REST hits into verified seed cards", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes("api.openalex.org")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "https://openalex.org/W1",
                doi: null,
                title: "Reincarnation Studies",
                publication_year: 2019,
                abstract_inverted_index: {
                  Reincarnation: [0], evidence: [1], has: [2], been: [3],
                  documented: [4], in: [5], peer: [6], reviewed: [7],
                  literature: [8], across: [9], multiple: [10], cultures: [11],
                },
                primary_location: { landing_page_url: "https://example.org/w1" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes("w/api.php")) {
        return new Response(
          JSON.stringify({ query: { search: [{ title: "Reincarnation" }] } }),
          { status: 200 },
        );
      }
      if (u.includes("/page/summary/")) {
        return new Response(
          JSON.stringify({
            title: "Reincarnation",
            extract: "x".repeat(150),
            content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Reincarnation" } },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const cards = await seedFromTierZeroJsonApis("reincarnation evidence");
    expect(cards.length).toBe(2);

    const openalex = cards.find((c) => c.engine === "openalex");
    expect(openalex?.url).toBe("https://example.org/w1");
    expect(openalex?.content).toContain("Reincarnation evidence");

    const wiki = cards.find((c) => c.engine === "wikipedia");
    expect(wiki?.url).toBe("https://en.wikipedia.org/wiki/Reincarnation");
    expect(wiki?.sourceTier).toBe("REFERENCE");
  });

  it("shortens a long research prompt to 3-4 core keywords before querying", async () => {
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      requested.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const longTopic =
      "What are the core mechanisms, evidence, and primary sources of the " +
      "Orthodox Church Fathers' theology of deification (theosis) according to tradition?";
    await seedFromTierZeroJsonApis(longTopic);

    const queryUrls = requested.filter((u) => u.includes("search=") || u.includes("srsearch="));
    expect(queryUrls.length).toBeGreaterThan(0);
    for (const raw of queryUrls) {
      const url = new URL(raw);
      const q = decodeURIComponent(
        url.searchParams.get("search") ?? url.searchParams.get("srsearch") ?? "",
      );
      expect(q.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(4);
      expect(q).not.toContain("site:");
    }
  });

  it("returns [] (never throws) when every JSON API fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(seedFromTierZeroJsonApis("anything")).resolves.toEqual([]);
  });
});
