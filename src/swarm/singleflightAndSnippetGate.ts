// src/swarm/singleflightAndSnippetGate.ts
// Sprint-3 run-shape helpers (only dependency: the deterministic query hygiene
// helpers used by selectAdaptiveFallbackDimensions):
//   1. SingleflightUrlFetcher — guarantees a URL is only ever fetched once
//      concurrently across all workers (saves FlareSolverr / Decodo quota).
//   2. shouldFetchSerpCandidate — rejects junk/login-wall results by title +
//      snippet BEFORE any expensive page fetch.
//   3. selectAdaptiveFallbackDimensions — replaces the blind 12-dimension
//      fallback dump with the top 4 topic-matched dimensions.
//   4. buildKvCachePinnedMessages — keeps the system prompt byte-identical
//      across planner / critic / synthesis calls so LM Studio's prefix KV cache
//      is reused instead of invalidated between sequential calls.

import { buildCoreTopicQuery, capQueryKeywords } from "../utils/topicQuery";

export interface SerpCandidate {
  url: string;
  title: string;
  snippet: string;
  engine: string;
}

/**
 * 1. In-Flight Singleflight URL Deduplicator
 * Prevents 12 parallel workers from simultaneously hitting Direct HTTP / FlareSolverr / Decodo
 * for the exact same URL before the visited-page cache updates.
 */
export class SingleflightUrlFetcher<TResult> {
  private inFlight = new Map<string, Promise<TResult>>();
  private completedCache = new Map<string, TResult>();
  private dedupedSaves = 0;

  public normalizeUrl(rawUrl: string): string {
    try {
      const u = new URL(rawUrl.trim());
      u.hash = "";
      for (const param of [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "ref",
      ]) {
        u.searchParams.delete(param);
      }
      return u.toString().replace(/\/+$/, "").toLowerCase();
    } catch {
      return rawUrl.trim().toLowerCase();
    }
  }

  public async fetchOnce(
    url: string,
    fetcher: (normalizedUrl: string) => Promise<TResult>,
  ): Promise<TResult> {
    const key = this.normalizeUrl(url);

    if (this.completedCache.has(key)) {
      this.dedupedSaves++;
      return this.completedCache.get(key)!;
    }

    const existingPromise = this.inFlight.get(key);
    if (existingPromise) {
      this.dedupedSaves++;
      return existingPromise;
    }

    const promise = fetcher(key)
      .then((res) => {
        if (res !== null && res !== undefined) {
          this.completedCache.set(key, res);
        }
        return res;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  public getStats(): { cachedUrls: number; dedupedRequestsSaved: number } {
    return {
      cachedUrls: this.completedCache.size,
      dedupedRequestsSaved: this.dedupedSaves,
    };
  }

  /**
   * Drops the per-run in-flight + completed caches so the fetcher can be reused
   * across runs without serving a stale page (the extra method is what lets the
   * orchestrator reset the shared instance at the start of every run).
   */
  public reset(): void {
    this.inFlight.clear();
    this.completedCache.clear();
    this.dedupedSaves = 0;
  }
}

/**
 * 2. Pre-Fetch SERP Snippet Gate
 * Rejects junk, login walls, and zero-overlap search results BEFORE making expensive
 * page fetches (saving FlareSolverr & Decodo quota).
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "about", "that", "this", "from", "what", "how",
  "why", "are", "was", "were", "have", "has", "had", "into", "over", "more",
]);

export function shouldFetchSerpCandidate(
  candidate: SerpCandidate,
  topic: string,
  gapName: string,
  minTermOverlap = 0.2,
): { allow: boolean; score: number; reason?: string } {
  const urlLower = candidate.url.toLowerCase();

  // Fast reject login, cart, tag-cloud, and binary media pages
  if (
    /\b(\/login|\/signin|\/signup|\/cart|\/checkout|\/tag\/|\/search\?|pinterest\.com|instagram\.com\/p\/)\b/.test(
      urlLower,
    )
  ) {
    return { allow: false, score: 0, reason: "low_value_url_pattern" };
  }

  const topicTerms = Array.from(
    new Set(
      `${topic} ${gapName}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  );

  if (topicTerms.length === 0) return { allow: true, score: 1 };

  const hay = `${candidate.title} ${candidate.snippet} ${candidate.url}`.toLowerCase();
  let matched = 0;
  for (const term of topicTerms) {
    if (hay.includes(term)) matched++;
  }

  // Require at least 1 core topic word to appear in the title/snippet
  const coreTopicTerms = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
  const hasCoreHit =
    coreTopicTerms.length === 0 || coreTopicTerms.some((t) => hay.includes(t));

  if (!hasCoreHit) {
    return { allow: false, score: 0, reason: "missing_core_topic_term" };
  }

  const overlap = matched / topicTerms.length;
  // Boost authoritative domains (.edu, .gov, .org, doi.org, arxiv.org, nih.gov)
  const domainBoost =
    /\.(gov|edu|ac\.uk)\b|doi\.org|arxiv\.org|ncbi\.nlm\.nih\.gov|scholar|wikipedia\.org/.test(
      urlLower,
    )
      ? 0.18
      : 0;

  const finalScore = overlap + domainBoost;
  return {
    allow: finalScore >= minTermOverlap,
    score: Number(finalScore.toFixed(3)),
    reason: finalScore >= minTermOverlap ? undefined : "low_snippet_overlap",
  };
}

/**
 * 3. Topic-Adaptive Deterministic Fallback Planner
 * Replaces the blind 12-dimension dump when LLM planning is unavailable.
 * Selects only the 4 highest-signal dimensions matching the topic intent.
 */
export interface AdaptiveDimension {
  id: string;
  name: string;
  queries: string[];
}

export function selectAdaptiveFallbackDimensions(
  topic: string,
  maxDimensions = 4,
): AdaptiveDimension[] {
  const fullTopic = topic.trim();
  const lower = fullTopic.toLowerCase();
  // Keep the intent classifier on the full topic, but build every deterministic
  // query from the 3-4 core entity keywords. Passing the whole 25+ word prompt
  // to DDG/SearXNG produced boolean strings that returned nothing.
  const core = buildCoreTopicQuery(fullTopic, 4);

  const isEmpiricalOrScientific =
    /\b(evidence|study|studies|science|scientific|proof|research|clinical|psychology|history|phenomenon|reincarnation|consciousness|medical)\b/.test(
      lower,
    );
  const isTechnicalOrSoftware =
    /\b(code|architecture|api|plugin|sdk|android|kotlin|llm|database|performance|bug|framework|docker|server)\b/.test(
      lower,
    );
  const isMarketOrBusiness =
    /\b(market|company|pricing|competitor|valuation|tax|ltd|sro|revenue|finance|cost|buyout)\b/.test(
      lower,
    );

  const selected: AdaptiveDimension[] = [
    {
      id: "dim_overview",
      name: "Overview & Core Mechanisms",
      queries: [`${core} overview definition`, `${core} key concepts explained`],
    },
  ];

  if (isEmpiricalOrScientific) {
    selected.push(
      {
        id: "dim_evidence",
        name: "Research Evidence & Peer-Reviewed Data",
        queries: [
          `${core} peer reviewed study empirical data`,
          `${core} academic research findings cases`,
        ],
      },
      {
        id: "dim_criticism",
        name: "Methodological Criticism & Counter-Arguments",
        queries: [
          `${core} skepticism methodological flaws criticism`,
          `${core} alternative explanations scientific consensus`,
        ],
      },
      {
        id: "dim_history",
        name: "Historical Context & Major Investigations",
        queries: [`${core} history major researchers cases`],
      },
    );
  } else if (isTechnicalOrSoftware) {
    selected.push(
      {
        id: "dim_how_it_works",
        name: "Architecture & Implementation",
        queries: [`${core} architecture implementation guide`, `${core} benchmarks`],
      },
      {
        id: "dim_limitations",
        name: "Bottlenecks, Bugs & Edge Cases",
        queries: [`${core} common issues limitations troubleshooting`],
      },
      {
        id: "dim_alternatives",
        name: "Comparisons & Trade-offs",
        queries: [`${core} vs alternatives comparison`],
      },
    );
  } else if (isMarketOrBusiness) {
    selected.push(
      {
        id: "dim_economics",
        name: "Economics, Pricing & Legal Structure",
        queries: [`${core} cost pricing structure regulations`],
      },
      {
        id: "dim_comparisons",
        name: "Competitors & Alternatives",
        queries: [`${core} comparison pros cons`],
      },
      {
        id: "dim_risks",
        name: "Compliance & Operational Risks",
        queries: [`${core} risks requirements compliance`],
      },
    );
  } else {
    selected.push(
      {
        id: "dim_evidence",
        name: "Key Evidence & Primary Sources",
        queries: [`${core} primary sources evidence analysis`],
      },
      {
        id: "dim_perspectives",
        name: "Expert Analysis & Competing Views",
        queries: [`${core} expert analysis debate controversy`],
      },
      {
        id: "dim_developments",
        name: "Current State & Recent Developments",
        queries: [`${core} recent developments updates`],
      },
    );
  }

  return selected
    .map((dimension) => ({
      ...dimension,
      queries: dimension.queries.map((query) => capQueryKeywords(query, 10)),
    }))
    .slice(0, maxDimensions);
}

/**
 * 4. LM Studio KV-Cache Prefix Pinner
 * Keeps the System Prompt 100% static across Planner, Critic, and Synthesis calls
 * so llama.cpp never invalidates the prefix KV cache between sequential calls.
 */
const STATIC_SWARM_SYSTEM_PREFIX =
  "You are the core reasoning engine for Deep Swarm Research. " +
  "Follow the requested output schema strictly, rely solely on provided evidence, and never fabricate citations.";

export function buildKvCachePinnedMessages(
  skillPackContent: string | undefined,
  taskRoleHeader: string,
  dynamicPayload: string,
  noThinkMode = false,
): { system: string; user: string } {
  const skillBlock = skillPackContent
    ? `\n\n[DOMAIN RUBRIC]\n${skillPackContent.trim()}`
    : "";

  // Byte-identical across every LLM call in the session -> 100% KV-cache hit in LM Studio
  const system = `${STATIC_SWARM_SYSTEM_PREFIX}${skillBlock}`;

  // All task-specific instructions & dynamic cards go into the User message tail
  const thinkSuffix = noThinkMode ? " /no_think" : "";
  const user = `### TASK MODE: ${taskRoleHeader}\n\n${dynamicPayload.trim()}${thinkSuffix}`;

  return { system, user };
}
