export type DepthPreset = "shallow" | "standard" | "deep" | "deeper" | "exhaustive";

export interface DepthProfile {
  readonly depthRounds: number;
  readonly pageBudgetPerWorker: number;
  readonly pageBudgetPerGapWorker: number;
  readonly defaultContentLimit: number;
  readonly searchResultsPerQuery: number;
  readonly maxQueriesPerWorker: number;
  readonly maxPagesPerDomain: number;
  readonly maxLinksToEvaluate: number;
  readonly maxLinksToFollow: number;
  readonly maxOutlinksPerPage: number;
  readonly candidatePoolMultiplier: number;
  readonly workerConcurrency: number;
  readonly maxDecompositionWorkers: number;
  readonly maxGapFillQueries: number;
  readonly ddgRateLimitMs: number;
  readonly minRelevanceScore: number;
  readonly synthesisMaxSources: number;
  readonly synthesisSourceChars: number;
  readonly synthesisMaxTokens: number;
  readonly contradictionMaxSources: number;
  readonly stagnationThreshold: number;
  readonly searchPages: number;
  readonly searchLanes: number;
  readonly workerFanOut: number;
  readonly extraEngines: ReadonlyArray<string>;
  readonly linkCrawlDepth: number;
  readonly queryMutationThreshold: number;
  /** How many content chunks (of `defaultContentLimit` chars each) to extract per source. */
  readonly extractPagesPerSource: number;
  /** Characters of each source fed into the AI evidence ledger for synthesis. */
  readonly evidenceExcerptChars: number;
}

export const DEPTH_PROFILES: Readonly<Record<DepthPreset, DepthProfile>> = {
  shallow: {
    depthRounds: 1, pageBudgetPerWorker: 5, pageBudgetPerGapWorker: 4, defaultContentLimit: 5_000,
    searchResultsPerQuery: 8, maxQueriesPerWorker: 3, maxPagesPerDomain: 3, maxLinksToEvaluate: 20,
    maxLinksToFollow: 2, maxOutlinksPerPage: 20, candidatePoolMultiplier: 2, workerConcurrency: 3,
    maxDecompositionWorkers: 6, maxGapFillQueries: 4, ddgRateLimitMs: 3_000, minRelevanceScore: 0.15,
    synthesisMaxSources: 15, synthesisSourceChars: 500, synthesisMaxTokens: 3_000, contradictionMaxSources: 10,
    stagnationThreshold: 1, searchPages: 1, searchLanes: 2, workerFanOut: 1,
    extraEngines: ["bing", "brave"], linkCrawlDepth: 1, queryMutationThreshold: 2,
    extractPagesPerSource: 1, evidenceExcerptChars: 300,
  },
  standard: {
    depthRounds: 3, pageBudgetPerWorker: 8, pageBudgetPerGapWorker: 6, defaultContentLimit: 6_000,
    searchResultsPerQuery: 10, maxQueriesPerWorker: 4, maxPagesPerDomain: 4, maxLinksToEvaluate: 30,
    maxLinksToFollow: 4, maxOutlinksPerPage: 30, candidatePoolMultiplier: 2, workerConcurrency: 3,
    maxDecompositionWorkers: 8, maxGapFillQueries: 5, ddgRateLimitMs: 3_000, minRelevanceScore: 0.13,
    synthesisMaxSources: 20, synthesisSourceChars: 500, synthesisMaxTokens: 4_000, contradictionMaxSources: 15,
    stagnationThreshold: 1, searchPages: 1, searchLanes: 2, workerFanOut: 1,
    extraEngines: ["bing", "brave", "searxng"], linkCrawlDepth: 1, queryMutationThreshold: 2,
    extractPagesPerSource: 1, evidenceExcerptChars: 400,
  },
  deep: {
    depthRounds: 5, pageBudgetPerWorker: 10, pageBudgetPerGapWorker: 8, defaultContentLimit: 8_000,
    searchResultsPerQuery: 12, maxQueriesPerWorker: 5, maxPagesPerDomain: 5, maxLinksToEvaluate: 40,
    maxLinksToFollow: 6, maxOutlinksPerPage: 40, candidatePoolMultiplier: 3, workerConcurrency: 4,
    maxDecompositionWorkers: 10, maxGapFillQueries: 6, ddgRateLimitMs: 3_000, minRelevanceScore: 0.1,
    synthesisMaxSources: 30, synthesisSourceChars: 400, synthesisMaxTokens: 5_000, contradictionMaxSources: 20,
    stagnationThreshold: 2, searchPages: 2, searchLanes: 3, workerFanOut: 2,
    extraEngines: ["bing", "brave", "searxng"], linkCrawlDepth: 2, queryMutationThreshold: 3,
    extractPagesPerSource: 2, evidenceExcerptChars: 600,
  },
  deeper: {
    depthRounds: 8, pageBudgetPerWorker: 15, pageBudgetPerGapWorker: 12, defaultContentLimit: 10_000,
    searchResultsPerQuery: 15, maxQueriesPerWorker: 6, maxPagesPerDomain: 6, maxLinksToEvaluate: 50,
    maxLinksToFollow: 8, maxOutlinksPerPage: 50, candidatePoolMultiplier: 3, workerConcurrency: 4,
    maxDecompositionWorkers: 12, maxGapFillQueries: 8, ddgRateLimitMs: 3_000, minRelevanceScore: 0.08,
    synthesisMaxSources: 40, synthesisSourceChars: 400, synthesisMaxTokens: 6_000, contradictionMaxSources: 25,
    stagnationThreshold: 2, searchPages: 2, searchLanes: 3, workerFanOut: 2,
    extraEngines: ["bing", "scholar", "brave", "searxng"], linkCrawlDepth: 2, queryMutationThreshold: 3,
    extractPagesPerSource: 2, evidenceExcerptChars: 800,
  },
  exhaustive: {
    depthRounds: 12, pageBudgetPerWorker: 20, pageBudgetPerGapWorker: 15, defaultContentLimit: 12_000,
    searchResultsPerQuery: 18, maxQueriesPerWorker: 8, maxPagesPerDomain: 8, maxLinksToEvaluate: 60,
    maxLinksToFollow: 10, maxOutlinksPerPage: 60, candidatePoolMultiplier: 4, workerConcurrency: 5,
    maxDecompositionWorkers: 14, maxGapFillQueries: 10, ddgRateLimitMs: 3_000, minRelevanceScore: 0.06,
    synthesisMaxSources: 50, synthesisSourceChars: 300, synthesisMaxTokens: 8_000, contradictionMaxSources: 30,
    stagnationThreshold: 3, searchPages: 3, searchLanes: 4, workerFanOut: 3,
    extraEngines: ["bing", "scholar", "brave", "searxng"], linkCrawlDepth: 3, queryMutationThreshold: 4,
    extractPagesPerSource: 3, evidenceExcerptChars: 1000,
  },
};

export function getDepthProfile(preset: DepthPreset): DepthProfile {
  return DEPTH_PROFILES[preset];
}

export const DDG_RATE_LIMIT_MS = 2_000;
/**
 * Hard per-request timeout for the Tier-1 direct fetch. Kept deliberately tight
 * (4.5s) so a dead or throttled host fails over to the Tier-2 waterfall
 * (`got-scraping`) or an alternate engine long before the 2-minute stall
 * watchdog can trip.
 */
export const FETCH_TIMEOUT_MS = 4_500;
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;
export const FETCH_MAX_RETRIES = 3;
export const FETCH_RETRY_DELAY_MS = 1500;
export const BATCH_INTER_FETCH_DELAY_MS = 300;
export const CACHE_FALLBACK_TIMEOUT_MS = 10_000;
export const WORKER_CONCURRENCY = 3;
export const MAX_PAGES_PER_DOMAIN = 3;
export const MIN_USEFUL_WORD_COUNT = 50;
export const MAX_LINKS_TO_EVALUATE = 40;
export const MAX_LINKS_TO_FOLLOW = 4;
export const MIN_RELEVANCE_SCORE = 0.15;
export const RELEVANCE_KEYWORD_FRACTION = 0.25;
/** Minimum fraction of distinctive topic keywords that must match for a
 * source to be accepted at all. Stops a single generic shared word (e.g.
 * "evidence") from admitting off-topic pages. */
export const RELEVANCE_KEYWORD_MIN_FRACTION = 0.6;
export const RELEVANCE_TITLE_BONUS = 0.15;
export const RELEVANCE_SNIPPET_BONUS = 0.08;
export const FINGERPRINT_HEAD_WORDS = 30;
export const FINGERPRINT_MID_WORDS = 20;
export const FINGERPRINT_TAIL_WORDS = 20;
export const SCORE_WEIGHT_DOMAIN = 0.55;
export const SCORE_WEIGHT_URL_QUALITY = 0.25;
export const SCORE_WEIGHT_FRESHNESS = 0.2;
export const MIN_CANDIDATE_SCORE = 12;
export const MIN_URL_QUALITY = 8;
export const LINK_KEYWORD_BONUS = 20;
export const MAX_SENTENCE_CHARS = 600;
export const IDEAL_SENTENCE_LENGTH = 150;
export const CONSENSUS_OVERLAP_FRACTION = 0.4;
export const MAX_CONSENSUS_PHRASES = 10;
export const KEY_SENTENCES_PER_SOURCE = 3;
export const MAX_SOURCES_PER_DIMENSION = 5;
export const REPORT_SOURCE_PREVIEW_CHARS = 1500;
export const MULTI_READ_BATCH_DELAY_MS = 500;
export const DIMENSION_COVERAGE_MIN_HITS = 3;
export const DIMENSION_COVERAGE_MIN_CHARS = 200;
/**
 * When the LLM planner is unavailable, gap-fill is deterministic and derived
 * from DIMENSIONS (ordered by priority). Cap it to the top N core dimensions
 * instead of fanning out to all ~12, which produces a low-signal task wave.
 */
export const FALLBACK_CORE_DIMENSIONS = 4;
export const AI_SYNTHESIS_MAX_TOKENS = 3_000;
export const AI_SYNTHESIS_TEMPERATURE = 0.35;
export const AI_SYNTHESIS_TIMEOUT_MS = 30_000;
export const SYNTHESIS_SOURCE_CHARS = 600;
export const SYNTHESIS_MAX_SOURCES = 20;
export const AI_CONTRADICTION_MAX_TOKENS = 1_500;
export const AI_CONTRADICTION_TEMPERATURE = 0.15;
export const AI_CONTRADICTION_TIMEOUT_MS = 15_000;
export const CONTRADICTION_MAX_SOURCES = 15;
export const CONTRADICTION_SOURCE_CHARS = 400;
export const CRITIC_CARDS_PER_BATCH = 6;
export const CRITIC_MAX_GRADE_BATCHES = 4;
export const CRITIC_LEDGER_CONTEXT_CARDS = 8;
export const CRITIC_RETRY_MAX_TASKS = 3;
export const CRITIC_RETRY_PAGE_BUDGET = 4;
export const CRITIC_MAX_TOKENS = 900;
export const CRITIC_TEMPERATURE = 0.1;
export const CRITIC_TIMEOUT_MS = 30_000;
export const AI_PLANNING_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Cross-run layered memory (src/memory/)
// ---------------------------------------------------------------------------
export const MEMORY_RETAIN_RUNS_DEFAULT = 6;
export const MEMORY_MAX_FACTS = 40;
export const MEMORY_MAX_PROCEDURES = 30;
export const MEMORY_TOPIC_MIN_SIM = 0.15;
export const MEMORY_RECALL_RUNS = 3;
export const MEMORY_RECALL_QUERIES = 8;
export const MEMORY_RECALL_FAILED_URLS = 10;
export const MEMORY_RECALL_FAILED_HOSTS = 8;
export const MEMORY_RECALL_GOOD_ENGINES = 4;
export const MEMORY_RECALL_FACTS = 12;
export const MEMORY_RECALL_PROCEDURES = 5;
export const MEMORY_LEDGER_SNAPSHOT_CARDS = 12;
export const MEMORY_CONTEXT_MAX_CHARS = 1_500;
export const MEMORY_EMBEDDING_DETECT_TIMEOUT_MS = 3_000;
export const MEMORY_EMBED_MAX_TEXTS = 200;
export const AI_PLANNING_MAX_TOKENS = 500;
export const AI_PLANNING_TEMPERATURE = 0.4;
export const AI_MIN_ACCEPTABLE_QUERIES = 4;
export const QUERY_LINE_MIN_LEN = 3;
export const QUERY_LINE_MAX_LEN = 250;
export const AI_DECOMPOSITION_MAX_TOKENS = 1_200;
export const AI_DECOMPOSITION_TEMPERATURE = 0.3;
export const AI_DECOMPOSITION_TIMEOUT_MS = 15_000;
export const DECOMPOSITION_MIN_WORKERS = 3;
export const DECOMPOSITION_MAX_WORKERS = 8;
export const AI_FINDINGS_SUMMARY_MAX_TOKENS = 600;
export const AI_FINDINGS_SUMMARY_TEMPERATURE = 0.2;
export const FINDINGS_SUMMARY_SOURCE_CHARS = 300;
export const DESCRIPTION_FALLBACK_CHARS = 250;
export const MIN_READABILITY_TEXT_LEN = 100;
export const OUTLINK_TEXT_MIN_LEN = 3;
export const OUTLINK_TEXT_MAX_LEN = 120;
export const DNS_RESOLVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"];
export const CONTENT_LIMIT_MIN = 1_000;
export const CONTENT_LIMIT_MAX = 20_000;
export const CONTENT_LIMIT_EXTENDED = 20_000;
export const CONTENT_LIMIT_DEFAULT = 4_000;
export const MAX_SOURCES_MIN = 5;
export const MAX_SOURCES_MAX = 200;
export const MAX_SOURCES_DEFAULT = 25;
export const SEARCH_RESULTS_MIN = 1;
export const SEARCH_RESULTS_MAX = 20;
export const SEARCH_RESULTS_DEFAULT = 10;
/** Hard safety cap on results fetched *per engine* from the extra/fallback engines. */
export const EXTRA_ENGINE_MAX_RESULTS = 24;

// ---------------------------------------------------------------------------
// Search-routing hardening
// ---------------------------------------------------------------------------
/** One local SearXNG query must settle within this window (was 30s). */
export const SEARXNG_QUERY_TIMEOUT_MS = 12_000;
/** Maximum concurrent requests to the local SearXNG instance. */
export const SEARXNG_MAX_CONCURRENCY = 2;
/** Deterministic/worker queries never exceed this many keywords. */
export const MAX_GENERATED_QUERY_WORDS = 8;
/** Standard depth: active gap workers are capped to this many. */
export const STANDARD_MAX_GAP_WORKERS = 5;
/** Standard depth: queries per active gap worker. */
export const STANDARD_MAX_GAP_QUERIES = 2;
/** DDG is circuit-broken after this many consecutive empty/blocked results. */
export const DDG_MAX_CONSECUTIVE_FAILURES = 2;
/** A 202/rate-limit block disables DDG for the rest of the run. */
export const DDG_RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Source diversity / fetch guards
// ---------------------------------------------------------------------------
/** Max accepted pages from one host per worker. */
export const MAX_PAGES_PER_HOST_PER_WORKER = 2;
/** Max accepted pages from one host across the whole run. */
export const MAX_PAGES_PER_HOST_GLOBAL = 3;
/** Standard/shallow runs only spider one level and only below this source count. */
export const MAX_LINK_FOLLOW_SOURCES_STANDARD = 4;

// ---------------------------------------------------------------------------
// Layer short-circuiting
// ---------------------------------------------------------------------------
/** Skip a worker in later layers once it has this fraction of its page budget. */
export const LAYER_WORKER_BUDGET_FRACTION = 0.5;
/** Exit the layer loop after SearXNG once this many sources exist. */
export const LAYER_EARLY_EXIT_MIN_SOURCES = 12;
/** Or when this fraction of workers has >= 2 sources. */
export const LAYER_EARLY_EXIT_COVERAGE_FRACTION = 0.75;
export const LAYER_COVERAGE_MIN_SOURCES_PER_WORKER = 2;

// ---------------------------------------------------------------------------
// Qwen reasoning hardening: evidence-chunk bounding + heuristic pre-filter
// ---------------------------------------------------------------------------
/** Hard cap on a single evidence chunk fed to the LLM (~1,500 tokens). */
export const EVIDENCE_CHUNK_MAX_CHARS = 6_000;
/** Minimum excerpt length before an evidence card is worth grading. */
export const HEURISTIC_MIN_TEXT_LEN = 180;
/**
 * Minimum query-keyword overlap ratio a snippet must reach to be graded.
 * Long research prompts dilute overlap across many terms; 0.08 lets a valid
 * 11%-overlap passage reach the LLM instead of being auto-rejected.
 */
export const HEURISTIC_MIN_KEYWORD_OVERLAP = 0.08;
/** Reference/encyclopedia/patristic sources often use different vocabulary. */
export const HEURISTIC_MIN_KEYWORD_OVERLAP_REFERENCE = 0.05;
/** Lexical score at/above which a card is "high tier" (retry-worthy). */
export const HEURISTIC_HIGH_TIER_SCORE = 0.55;
/** Lexical score at/above which a card is "medium tier". */
export const HEURISTIC_MEDIUM_TIER_SCORE = 0.3;
/** Boilerplate / paywall signatures that make a snippet worthless to grade. */
export const BOILERPLATE_SIGNATURE_RE =
  /access denied|403 forbidden|please enable javascript|sign in to continue/i;
/** Max characters of a model-extracted critic claim kept on the card. */
export const CRITIC_EXTRACTED_CLAIM_MAX_CHARS = 240;

export const SYSTEM_INSTRUCTIONS = `You are a core component of the Deep Swarm Research engine.
Your goal is to provide precise, high-quality research planning, task decomposition, and findings synthesis.
Be analytical and objective. Avoid conversational filler. Follow the requested output format strictly.
When generating search queries, ensure they are diverse, targeted, and effective for finding high-authority information.`;

/**
 * Cognitive-scaffolding rubric injected into system prompts for phases that run
 * with reasoning enabled (planner, synthesis). It guides the model's ` thinking`
 * trace through source auditing, falsification, corroboration, and outlining so
 * the reasoning is structured rather than free-form.
 */
export const THINKING_PROTOCOL = `[THINKING PROTOCOL]
Before producing your final answer, reason through these milestones in order:
1. SOURCE CREDIBILITY & RECENCY AUDIT - weigh each source's authority, methodology, and publication date; discount undated or low-tier claims.
2. FALSIFICATION & COUNTER-CLAIM CHECKING - actively look for evidence that contradicts the emerging answer, including failed replications and dissenting experts.
3. CORROBORATION VERIFICATION - require that load-bearing claims appear in multiple independent domains, not a single cluster of mutually-citing pages.
4. REPORT STRUCTURE OUTLINE - plan the final structure (summary, sections, reference appendix) before writing.`;

/** Max unresolved questions mined from the planner's reasoning trace per run. */
export const UNCERTAINTY_MAX_QUERIES = 3;
/** Per-worker page budget for the epistemic-uncertainty mining round. */
export const UNCERTAINTY_PAGE_BUDGET = 4;
/**
 * Skip uncertainty mining once this fraction of the hard runtime limit has
 * elapsed (leaves a 15% buffer before the 80% synthesis cutoff).
 */
export const UNCERTAINTY_MAX_ELAPSED_FRACTION = 0.65;
/** LLM calls that must remain after mining, on top of the active worker count. */
export const UNCERTAINTY_LLM_RESERVE_CALLS = 3;
/** Jaccard token-overlap at/above which two queries are near-duplicates. */
export const UNCERTAINTY_JACCARD_THRESHOLD = 0.75;