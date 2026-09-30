// src/swarm/worker.ts
import { LlmCallManager, askLoadedModel, hasLoadedModel } from "../utils/llm";
import { logLlmDiagnostics } from "../utils/tokens";
import { fetchWithWaterfall } from "../net/waterfallFetcher";
import {
  isYouTubeUrl,
  extractYouTubeTranscript,
  buildYouTubePage,
} from "../net/youtube-extractor";
import {
  searchSerper,
  searchBraveApi,
  searchOpenAlex,
  searchCrossref,
  searchArxiv,
  searchGdelt,
  searchReferenceSites,
} from "../net/api-engines";
import {
  searchDDG,
  searchDDGPaginated,
  DdgRateLimiter,
  sharedDdgLimiter,
  wasLastSearchRateLimited,
} from "../net/ddg";
import { multiEngineSearch, SearchEngine } from "../net/search-engines";
import { SearchHealthTracker } from "./health";
import { fetchPage, sleep, maybeArchivePage } from "../net/http";
import {
  extractPage,
  contentFingerprint,
  computeRelevance,
} from "../net/extractor";
import {
  isPdfUrl,
  isPdfContentType,
  extractPdf,
} from "../net/pdf-extractor";
import { scoreCandidate, rankCandidates, scoreOutlinks } from "../scoring/authority";
import {
  buildDomainPolicyFromTask,
  urlAllowed,
} from "../net/domain-policy";
import {
  SwarmTask,
  WorkerResult,
  CrawledSource,
  ScoredCandidate,
  SourceTier,
  StatusFn,
  WarnFn,
  SearchHit,
  ExtractedPage,
} from "../types";
import { harvestLocalSources } from "../local/search";
import { BlockedUrlEntry } from "../types";
import {
  BATCH_INTER_FETCH_DELAY_MS,
  MIN_USEFUL_WORD_COUNT,
  EXTRA_ENGINE_MAX_RESULTS,
} from "../constants";
import { normalizeUrl } from "./visited-cache";
import { getEngineStats, getMutationStats, getDomainAdjustments } from "./learning";

export interface CrawlMetrics {
  ddgQueries: number;
  ddgHits: number;
  mutatedQueriesTried: number;
  mutationAccepted: number;
  mutationHits: number;
  extraEngineQueries: number;
  extraEngineHits: number;
  rawHits: number;
  dedupedHits: number;
  rankedCandidates: number;
  fetchCandidates: number;
  fetchAttempts: number;
  fetchFailures: number;
  acceptedSources: number;
  skippedLowWordCount: number;
  skippedOffTopic: number;
  skippedVeryOffTopic: number;
  skippedDuplicateContent: number;
  skippedVisited: number;
  skippedDomainCap: number;
  skippedAvoided: number;
  skippedBlacklisted: number;
  skippedNegativeCache: number;
  cacheChecks: number;
  cacheHits: number;
  cacheAccepted: number;
  cacheRejectedDuplicate: number;
  cacheRejectedOffTopic: number;
  cacheRejectedLowWordCount: number;
  cacheWrites: number;
  followedLinks: number;
  crossWorkerDiscoveriesUsed: number;
  localSourcesAccepted: number;
  skippedDomainPolicy: number;
}

export interface SharedCrawlState {
  readonly visitedUrls: ReadonlySet<string>;
  readonly contentHashes: ReadonlySet<string>;
  readonly domainCounts: ReadonlyMap<string, number>;
  readonly domainFailures: ReadonlyMap<string, number>;
  addVisited(url: string): void;
  addHash(hash: string): void;
  incrementDomain(url: string): void;
  domainCount(url: string): number;
  noteFailure(url: string, reason: string): void;
  noteDomainFailure(url: string): void;
  isDomainBlacklisted(url: string): boolean;
  shouldAvoidUrl(url: string): boolean;
  listBlockedUrls(): ReadonlyArray<BlockedUrlEntry>;
  pushDiscovery(url: string, title: string, fromWorker: string): void;
  drainDiscoveries(limit: number): ReadonlyArray<{ url: string; title: string }>;
  isRecentlyVisited(url: string): boolean;
  getCachedSource(url: string): CrawledSource | null;
  markVisitedPersistent(source: CrawledSource): void;
  isRejected(url: string): boolean;
  markRejected(url: string, reason?: string): void;
  getMetricsSnapshot(): Readonly<CrawlMetrics>;
  mergeMetrics(delta: Partial<CrawlMetrics>): void;
}

const MUTATION_STRATEGIES: ReadonlyArray<(q: string) => string> = [
  (q) => `"${q}"`,
  (q) => `${q} explained`,
  (q) => `${q} guide overview`,
  (q) => `${q} research`,
  (q) => q.split(" ").slice(0, 10).join(" "),
  (q) => q.replace(/\b(how|what|why|when)\b/gi, " ").trim(),
];

/** Bound on the whole mutation phase for a single query (many of these
 * strategies re-run DDG sequentially). Prevents a blocked engine from eating
 * the entire watchdog budget inside one query. */
const MUTATION_PHASE_CAP_MS = 30_000;

type SearchHitLike = {
  url: string;
  title: string;
  snippet: string;
  query: string;
  discoveredBy?: string;
  requestedRoute?: string; // <--- ADD THIS
  actualBackend?: string;  // <--- ADD THIS
  resultDomain?: string;   // <--- ADD THIS
};

function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  );
}

function zeroMetrics(): CrawlMetrics {
  return {
    ddgQueries: 0, ddgHits: 0, mutatedQueriesTried: 0, mutationAccepted: 0,
    mutationHits: 0, extraEngineQueries: 0, extraEngineHits: 0, rawHits: 0,
    dedupedHits: 0, rankedCandidates: 0, fetchCandidates: 0, fetchAttempts: 0,
    fetchFailures: 0, acceptedSources: 0, skippedLowWordCount: 0, skippedOffTopic: 0,
    skippedVeryOffTopic: 0, skippedDuplicateContent: 0, skippedVisited: 0, skippedDomainCap: 0,
    skippedAvoided: 0, skippedBlacklisted: 0, skippedNegativeCache: 0, cacheChecks: 0, cacheHits: 0, cacheAccepted: 0,
    cacheRejectedDuplicate: 0, cacheRejectedOffTopic: 0, cacheRejectedLowWordCount: 0,
    cacheWrites: 0, followedLinks: 0, crossWorkerDiscoveriesUsed: 0, localSourcesAccepted: 0,
    skippedDomainPolicy: 0,
  };
}

export async function runWorker(
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  topicKws: ReadonlyArray<string> = [],
  limiter: DdgRateLimiter = sharedDdgLimiter,
  health: SearchHealthTracker,
  llmManager: LlmCallManager
): Promise<WorkerResult> {
  const sources: CrawledSource[] = [];
  const errors: string[] = [];
  const queriesExecuted: string[] = [];
  const roleTag = `[${task.label}]`;
  const metrics = zeroMetrics();

  status(`${roleTag} Starting - ${task.queries.length} queries, budget=${task.pageBudget}, links=${task.followLinks ? "on" : "off"}`);

  if (task.enableLocalSources) {
    const localBudget = Math.max(2, Math.ceil(task.pageBudget * 0.3));
    const localSources = harvestLocalSources(
      task.queries, task.role, task.label, localBudget, task.contentLimit, task.localLibraryIds, task.roleLibraryMap,
    );

    if (localSources.length > 0) {
      for (const src of localSources) {
        state.addVisited(src.url);
        state.addHash(contentFingerprint(src.text));
        sources.push(src);
      }
      metrics.localSourcesAccepted += localSources.length;
      status(`${roleTag} Local sources: ${localSources.length} chunks`);
    }
  }

  const allHits: SearchHitLike[] = [];
  let ddgBlocked = false;

  for (const query of task.queries) {
    if (signal.aborted) break;

    // 9. QUERY PLANNING RULES - Reject bad queries
    // Relaxed Query Quality Check: Reject only empty, corrupt, or absurdly long query strings
    const qTrimmed = query.trim();
    if (!qTrimmed || qTrimmed.length < 3 || qTrimmed.length > 250) {
      warn(`[Query Quality] Rejected out-of-bounds query length (${qTrimmed.length} chars): "${qTrimmed.slice(0, 50)}..."`);
      continue;
    }

    let ddgHits: ReadonlyArray<SearchHit> = [];
    let effectiveHitCount = 0;

        // 4. DDG FAILURE DEFINITION & HEALTH TRACKING
    if (task.extraEngines.includes("ddg") && health.isDdgAvailable()) {
      metrics.ddgQueries++;
      try {
        // Random human-like pause before querying DDG (2-8 seconds)
        const humanDelay = Math.floor(Math.random() * 6000) + 2000;
        await sleep(humanDelay);

        if (task.searchPages > 1) {
          ddgHits = await searchDDGPaginated(query, task.searchResultsPerQuery, task.searchPages, task.safeSearch, signal, limiter, task.timeRange ?? "all", task.flaresolverrUrl);
        } else {
          ddgHits = await searchDDG(query, task.searchResultsPerQuery, task.safeSearch, signal, limiter, task.timeRange ?? "all", task.flaresolverrUrl);
        }

        // LOWERED TRIPWIRE: If it finds even 1 result, that is a success.
        if (ddgHits.length === 0) {
          throw new Error(wasLastSearchRateLimited() ? "DDG_RATE_LIMITED (202)" : "INVALID_RESULT_SET (0 results)");
        }

        health.recordDdgSuccess(ddgHits.length);
        metrics.ddgHits += ddgHits.length;
        effectiveHitCount = ddgHits.length;
        llmManager.recordProgress(); // Search activity is progress, not a stall.
        if (task.enableAdaptiveLearning !== false) getEngineStats().record("ddg", ddgHits.length);

        // Track Attribution
        for (const h of ddgHits) {
          let domain = "";
          try { domain = new URL(h.url).hostname.replace(/^www\./, ""); } catch {}
          allHits.push({ 
            ...h, 
            query, 
            requestedRoute: "DDG",
            actualBackend: "DDG",
            resultDomain: domain
          });
        }
        
        queriesExecuted.push(query);
        status(`${roleTag} DDG: "${query}" -> ${ddgHits.length} results`);
      } catch (err: unknown) {
        if (isAbortError(err)) break;
        const msg = errorMessage(err);
        health.recordDdgFailure(msg);
        warn(`${roleTag} DDG failed (${health.ddg.consecutiveFailures}/5): ${msg}`);
        llmManager.recordProgress(); // A capped, completed search attempt is not a hang.
        
        // Massive exponential backoff penalty if a block is detected (10-15 seconds)
        if (msg.includes("403") || msg.includes("Blocked")) {
           const penalty = Math.floor(Math.random() * 5000) + 10000;
           warn(`${roleTag} Applying ${penalty/1000}s penalty pause to clear WAF...`);
           await sleep(penalty);
           ddgBlocked = true; 
        }
      }
    }

   // Query Mutation (LLM)
    const isHighlyRestrictive = query.includes("site:");
    
    if (
      ddgHits.length < task.queryMutationThreshold &&
      !signal.aborted &&
      !ddgBlocked &&
      !isHighlyRestrictive
    ) {
      let llmMutated: string | null = null;
      if (llmManager.canCall(task.id)) {
        // Only charge the LLM budget when a model is actually loaded, so a run
        // without LM Studio doesn't waste budget slots on no-op mutations.
        const modelReady = await hasLoadedModel();
        if (modelReady) {
          llmManager.recordCall(task.id);
          const contextSnippets = allHits.filter((h) => h.query === query).slice(0, 3).map((h) => h.snippet);
          llmMutated = await getLLMQueryMutation(query, contextSnippets, signal);
        }
      } else {
        warn(`${roleTag} LLM call budget exhausted, skipping LLM mutation (heuristics still run).`);
      }
      
      const strategyIndices = task.enableAdaptiveLearning !== false
        ? getMutationStats().rankIndices(MUTATION_STRATEGIES.length, task.role)
        : MUTATION_STRATEGIES.map((_, i) => i);
      const mutationsToTry: Array<{ text: string; strategyIndex: number | null }> = [
        ...(llmMutated ? [{ text: llmMutated, strategyIndex: null }] : []),
        ...strategyIndices.map((i) => ({ text: MUTATION_STRATEGIES[i](query), strategyIndex: i })),
      ].filter((m) => !!m.text && m.text !== query);

      let bestMutation: { query: string; hits: ReadonlyArray<SearchHit>; strategyIndex: number | null } | null = null;
      const baseline = mutationQuality(ddgHits, query);
      const mutationDeadline = Date.now() + MUTATION_PHASE_CAP_MS;

      for (const { text: mutated, strategyIndex } of mutationsToTry) {
        if (signal.aborted || Date.now() >= mutationDeadline) break;
        metrics.mutatedQueriesTried++;
        metrics.ddgQueries++;

        try {
          const mutHits = await searchDDG(mutated, task.searchResultsPerQuery, task.safeSearch, signal, limiter, task.timeRange ?? "all", task.flaresolverrUrl);
          metrics.ddgHits += mutHits.length;
          llmManager.recordProgress(); // Completed mutation searches are activity, not a stall.

          const improved = mutationQuality(mutHits, query) > baseline;
          if (strategyIndex !== null && task.enableAdaptiveLearning !== false) {
            getMutationStats().record(strategyIndex, improved, task.role);
          }
          if (improved) {
            if (!bestMutation || mutationQuality(mutHits, query) > mutationQuality(bestMutation.hits, query)) {
              bestMutation = { query: mutated, hits: mutHits, strategyIndex };
            }
          }
        } catch (err) {
          const msg = errorMessage(err);
          if (isRateLimitError(msg)) {
            ddgBlocked = true;
            warn(`${roleTag} Mutation RATE LIMIT (429)! Falling back...`);
            break;
          }
        }
      }

      if (bestMutation) {
        metrics.mutationAccepted++;
        metrics.mutationHits += bestMutation.hits.length;
        for (const h of bestMutation.hits) {
          let domain = "";
          try { domain = new URL(h.url).hostname.replace(/^www\./, ""); } catch {}
          allHits.push({ ...h, query: bestMutation.query, requestedRoute: "DDG-MUTATION", actualBackend: "DDG", resultDomain: domain, discoveredBy: "ddg-mutation" });
        }
        queriesExecuted.push(bestMutation.query);
        effectiveHitCount = Math.max(effectiveHitCount, bestMutation.hits.length);

        // Feed the accepted mutation through the extra engines too, so the
        // improved phrasing can surface results beyond DDG.
        if (task.extraEngines.length > 0 && !signal.aborted) {
          const trackedEngines = new Set<SearchEngine>(["bing", "brave", "google", "scholar", "searxng", "mojeek", "yandex", "youtube"]);
          const usableEngines = (task.extraEngines as ReadonlyArray<SearchEngine>).filter(
            (engine) => !trackedEngines.has(engine) || health.isOtherEngineAvailable(engine),
          );
          if (usableEngines.length > 0) {
            try {
              const mutExtraHits = await multiEngineSearch(
                bestMutation.query,
                Math.min(task.searchResultsPerQuery, EXTRA_ENGINE_MAX_RESULTS) * Math.max(1, usableEngines.length),
                usableEngines,
                signal, () => limiter, task.timeRange ?? "all",
                { serperApiKey: (task as any).serperApiKey, braveApiKey: (task as any).braveApiKey, rssFeedUrls: (task as any).rssFeedUrls, telegramChannels: (task as any).telegramChannels, flaresolverrUrl: (task as any).flaresolverrUrl }
              );
              metrics.extraEngineHits += mutExtraHits.length;
              for (const h of mutExtraHits) allHits.push({ ...h, query: bestMutation.query });
              llmManager.recordProgress(); // Completed mutation extra-engine search is not a stall.
              if (mutExtraHits.length > 0) status(`${roleTag} Mutation extra engines -> ${mutExtraHits.length} results`);
              for (const engine of usableEngines) {
                if (!trackedEngines.has(engine)) continue;
                const engineHits = mutExtraHits.filter((h) => h.discoveredBy === engine).length;
                health.recordOtherEngineHit(engine, engineHits);
                if (task.enableAdaptiveLearning !== false) getEngineStats().record(engine, engineHits);
              }
            } catch {}
          }
        }
      }
    }


    // Fallback to SearxNG or API if DDG is dead or hit 0
    const shouldUseExtraEngines = task.extraEngines.length > 0 && !signal.aborted && (ddgBlocked || effectiveHitCount < Math.ceil(task.searchResultsPerQuery * 0.6) || task.role === "academic" || task.role === "primary" || task.role === "regulatory");

    if (shouldUseExtraEngines) {
      metrics.extraEngineQueries++;
      try {
        // Per-engine health gating: only fragile HTML-scrape engines that were
        // built for no-key scraping get cooled down. Tracked set keeps reliable
        // API/reference engines (serper, brave-api, openalex, crossref, arxiv,
        // gdelt, reference, rss, telegram, ddg) running unconditionally.
        const trackedEngines = new Set<SearchEngine>(["bing", "brave", "google", "scholar", "searxng", "mojeek", "yandex", "youtube"]);
        const usableEngines = (task.extraEngines as ReadonlyArray<SearchEngine>).filter(
          (engine) => !trackedEngines.has(engine) || health.isOtherEngineAvailable(engine),
        );

        // API-as-second-fallback: when the free engines under-deliver (blocked,
        // rate-limited, or fewer than 60% of expected hits), lend serper/brave-api
        // an attempt if a key is configured and the API budget is still available.
        const freeResultsWeak = ddgBlocked || effectiveHitCount < Math.ceil(task.searchResultsPerQuery * 0.6);
        if (freeResultsWeak && health.canUseApi()) {
          const apiKeys = {
            serper: (task as any).serperApiKey as string | undefined,
            "brave-api": (task as any).braveApiKey as string | undefined,
          };
          for (const [engine, key] of Object.entries(apiKeys)) {
            if (key && !usableEngines.includes(engine as SearchEngine)) {
              usableEngines.push(engine as SearchEngine);
              health.apiCallsMade++;
            }
          }
        }

        if (usableEngines.length === 0) {
          warn(`${roleTag} All extra engines in cooldown, skipping extra-engine search.`);
        } else {
          const extraHits = await multiEngineSearch(
            query,
            Math.min(task.searchResultsPerQuery, EXTRA_ENGINE_MAX_RESULTS) * Math.max(1, usableEngines.length),
            usableEngines,
            signal, () => limiter, task.timeRange ?? "all",
            { serperApiKey: (task as any).serperApiKey, braveApiKey: (task as any).braveApiKey, rssFeedUrls: (task as any).rssFeedUrls, telegramChannels: (task as any).telegramChannels, flaresolverrUrl: (task as any).flaresolverrUrl }
          );
          metrics.extraEngineHits += extraHits.length;
          for (const h of extraHits) allHits.push({ ...h, query });
          llmManager.recordProgress(); // Completed extra-engine search is activity, not a stall.
          if (extraHits.length > 0) status(`${roleTag} -> ${extraHits.length} extra results`);

          // Record per-engine outcomes for health gating (empty counts as a miss)
          for (const engine of usableEngines) {
            if (!trackedEngines.has(engine)) continue;
            const engineHits = extraHits.filter((h) => h.discoveredBy === engine).length;
            health.recordOtherEngineHit(engine, engineHits);
            if (task.enableAdaptiveLearning !== false) getEngineStats().record(engine, engineHits);
          }
        }
      } catch {}
    }
  }

  metrics.rawHits = allHits.length;

  if (signal.aborted || allHits.length === 0) {
    metrics.acceptedSources = sources.length;
    state.mergeMetrics(metrics);
    return { taskId: task.id, role: task.role, label: task.label, sources, queries: queriesExecuted, errors };
  }

  const deduped = deduplicateByUrl(allHits);
  metrics.dedupedHits = deduped.length;

  const scored = deduped.map((h) => {
    const sc = scoreCandidate(h, h.query);
    return { ...sc, discoveredBy: h.discoveredBy };
  });
  
  const filtered = task.preferredTiers ? scored.filter((c) => task.preferredTiers!.includes(c.tier)) : scored;
  const poolSize = task.pageBudget * task.candidatePoolMultiplier;
  const ranked = rankCandidates(filtered.length > 0 ? filtered : scored, poolSize);
  const candidates = capCandidatesPerHost(ranked, 2);

  metrics.rankedCandidates = candidates.length;
  metrics.fetchCandidates = candidates.length;

  await fetchBatch(candidates, task, state, signal, status, warn, sources, errors, roleTag, topicKws, metrics, llmManager);
  
  if (task.followLinks && sources.length > 0 && sources.length < task.pageBudget) {
    for (let depth = 1; depth <= task.linkCrawlDepth; depth++) {
      if (sources.length >= task.pageBudget || signal.aborted) break;
      const budget = Math.min(task.pageBudget - sources.length, task.maxLinksToFollow);
      if (budget <= 0) break;

      const sourcesForLinks = depth === 1 ? sources : sources.slice(-budget * 2);
      const newCount = await followLinks(sourcesForLinks, task, state, signal, status, warn, sources, errors, roleTag, budget, topicKws, depth, metrics, llmManager);
      metrics.followedLinks += newCount;
      if (newCount === 0) break;
    }
  }

  for (const src of sources) {
    for (const link of src.outlinks.slice(0, 5)) {
      state.pushDiscovery(link.href, link.text, task.label);
    }
  }

  metrics.acceptedSources = sources.length;
  state.mergeMetrics(metrics);
  status(`✅ ${roleTag} Mission Complete - ${sources.length} high-quality sources collected!`);

  return { taskId: task.id, role: task.role, label: task.label, sources, queries: queriesExecuted, errors };
}

async function fetchBatch(
  candidates: ReadonlyArray<ScoredCandidate>,
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  results: CrawledSource[],
  errors: string[],
  tag: string,
  topicKws: ReadonlyArray<string>,
  metrics: CrawlMetrics,
  llmManager: LlmCallManager
): Promise<void> {
  let idx = 0;
  const concurrency = task.workerConcurrency;
  const domainCap = task.maxPagesPerDomain;
  const minRelevance = task.minRelevanceScore;
  const domainPolicy = buildDomainPolicyFromTask(task);

  while (results.length < task.pageBudget && idx < candidates.length && !signal.aborted) {
    const slice = candidates.slice(idx, idx + concurrency);
    idx += concurrency;

    const batch: ScoredCandidate[] = [];
    for (const c of slice) {
      const policy = urlAllowed(c.url, domainPolicy);
      if (!policy.allowed) { metrics.skippedDomainPolicy++; continue; }
      const normalized = normalizeUrl(c.url);
      if (state.visitedUrls.has(normalized)) { metrics.skippedVisited++; continue; }
      if (state.domainCount(c.url) >= domainCap) { metrics.skippedDomainCap++; continue; }
      if (state.shouldAvoidUrl(c.url)) { metrics.skippedAvoided++; continue; }
      if (state.isDomainBlacklisted(c.url)) { metrics.skippedBlacklisted++; continue; }
      if (state.isRejected(c.url)) { metrics.skippedNegativeCache++; continue; }
      batch.push(c);
    }

    if (batch.length === 0) continue;

    for (const c of batch) state.addVisited(c.url);

    const settled = await Promise.allSettled(
      batch.map((c) => resolveCandidate(c, task, state, topicKws, signal, metrics)),
    );

    for (let i = 0; i < settled.length; i++) {
      const candidate = batch[i];
      const settledResult = settled[i];

      if (signal.aborted) return;

      if (settledResult.status === "rejected") {
        if (!isAbortError(settledResult.reason)) {
          const msg = errorMessage(settledResult.reason);
          metrics.fetchFailures++;
          state.noteFailure(candidate.url, msg);
          state.noteDomainFailure(candidate.url);
          state.markRejected(candidate.url, msg);
          warn(`${tag} Failed: ${truncUrl(candidate.url)} - ${msg}`);
          errors.push(`fetch:${candidate.url}: ${msg}`);
        }
        continue;
      }

      const { page, fromCache } = settledResult.value;

      if (page.wordCount < MIN_USEFUL_WORD_COUNT) { metrics.skippedLowWordCount++; if (fromCache) metrics.cacheRejectedLowWordCount++; else state.markRejected(candidate.url, "low-word-count"); continue; }
      if (page.relevanceScore < minRelevance * 0.5) { metrics.skippedVeryOffTopic++; if (fromCache) metrics.cacheRejectedOffTopic++; else { state.noteDomainFailure(candidate.url); state.markRejected(candidate.url, "very-off-topic"); } if (task.enableAdaptiveLearning !== false) getDomainAdjustments().record(safeHostname(candidate.url), false); continue; }
      if (page.relevanceScore < minRelevance) { metrics.skippedOffTopic++; if (fromCache) metrics.cacheRejectedOffTopic++; if (task.enableAdaptiveLearning !== false) getDomainAdjustments().record(safeHostname(candidate.url), false); continue; }

      const fp = contentFingerprint(page.text);
      if (state.contentHashes.has(fp)) { metrics.skippedDuplicateContent++; if (fromCache) metrics.cacheRejectedDuplicate++; continue; }

      state.addHash(fp);
      state.incrementDomain(candidate.url);

      if (fromCache) {
        metrics.cacheAccepted++;
      } else {
        state.markVisitedPersistent(page);
        metrics.cacheWrites++;
      }

      results.push(page);
      llmManager.recordProgress(); // Tell the watchdog we found something!
      if (task.enableAdaptiveLearning !== false) getDomainAdjustments().record(safeHostname(candidate.url), true);

      status(`${tag} [${results.length}/${task.pageBudget}] ${fromCache ? "[cache] " : ""}(rel=${page.relevanceScore.toFixed(2)}) ${page.title.slice(0, 60)}`);

      if (results.length >= task.pageBudget) return;
    }

    if (idx < candidates.length && results.length < task.pageBudget) {
      await sleep(BATCH_INTER_FETCH_DELAY_MS);
    }
  }
}

async function resolveCandidate(
  candidate: ScoredCandidate,
  task: SwarmTask,
  state: SharedCrawlState,
  topicKws: ReadonlyArray<string>,
  signal: AbortSignal,
  metrics: CrawlMetrics,
): Promise<{ page: CrawledSource; fromCache: boolean }> {
  metrics.cacheChecks++;

  const cached = state.getCachedSource(candidate.url);
  if (cached) {
    metrics.cacheHits++;
    return {
      page: adaptCachedSourceForTask(cached, candidate.query, candidate.snippet, task, topicKws),
      fromCache: true,
    };
  }

  metrics.fetchAttempts++;
  return {
    page: await fetchAndExtract(candidate.url, candidate.query, candidate.snippet, task, topicKws, signal, candidate.discoveredBy),
    fromCache: false,
  };
}

function adaptCachedSourceForTask(
  cached: CrawledSource,
  query: string,
  snippet: string,
  task: SwarmTask,
  topicKws: ReadonlyArray<string>,
): CrawledSource {
  const { domainScore, freshnessScore, tier } = scoreCandidate({ url: cached.url, title: cached.title, snippet: cached.description }, query);
  const relevanceScore = computeRelevance(cached.text, cached.title, snippet, topicKws);
  return {
    ...cached,
    url: normalizeUrl(cached.url),
    finalUrl: normalizeUrl(cached.finalUrl ?? cached.url),
    sourceQuery: query,
    workerRole: task.role,
    workerLabel: task.label,
    domainScore,
    freshnessScore,
    tier: tier as SourceTier,
    relevanceScore,
  };
}

async function followLinks(
  existingSources: ReadonlyArray<CrawledSource>,
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  results: CrawledSource[],
  errors: string[],
  tag: string,
  budget: number,
  topicKws: ReadonlyArray<string>,
  depth: number,
  metrics: CrawlMetrics,
  llmManager: LlmCallManager
): Promise<number> {
  const allLinks = existingSources.flatMap((s) => s.outlinks);
  const linkKws = task.queries.join(" ").toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 12);
  const domainPolicy = buildDomainPolicyFromTask(task);

  const scored = scoreOutlinks(allLinks, linkKws, state.visitedUrls, task.maxLinksToEvaluate);
  const toFollow = scored
    .filter((l) => urlAllowed(l.href, domainPolicy).allowed)
    .slice(0, task.maxLinksToFollow);

  if (toFollow.length === 0) return 0;

  status(`${tag} Following ${toFollow.length} link(s) (depth ${depth})…`);

  const before = results.length;
  const linkCandidates = toFollow.map((l) => scoreCandidate({ url: l.href, title: "", snippet: "" }, task.queries[0] ?? ""));

  await fetchBatch(linkCandidates, { ...task, pageBudget: results.length + budget }, state, signal, status, warn, results, errors, tag, topicKws, metrics, llmManager);

  return results.length - before;
}

async function fetchAndExtract(
  url: string,
  query: string,
  snippet: string,
  task: SwarmTask,
  topicKws: ReadonlyArray<string>,
  signal: AbortSignal,
  discoveredBy?: string,
): Promise<CrawledSource> {
  let page: ExtractedPage;

  if (isYouTubeUrl(url)) {
    const ytData = await extractYouTubeTranscript(url, signal, task.contentLimit);
    if (!ytData) throw new Error("YouTube transcript extraction failed");
    page = buildYouTubePage(url, ytData, task.contentLimit, 1);
  } else {
    const fetchResult = await fetchWithWaybackFallback(url, signal, task);
    const { finalUrl } = fetchResult;
    const maxChunks = Math.max(1, task.extractPagesPerSource ?? 1);

    const isPdf = (fetchResult.rawBuffer && isPdfContentType(fetchResult.contentType)) || (!fetchResult.rawBuffer && isPdfUrl(url));

    const pdfBuffer = isPdf && fetchResult.rawBuffer ? fetchResult.rawBuffer : undefined;
    if (pdfBuffer && task.maxPdfBytes && pdfBuffer.byteLength > task.maxPdfBytes) {
      throw new Error(
        `PDF exceeds maxPdfBytes (${pdfBuffer.byteLength} > ${task.maxPdfBytes}) — skipped.`,
      );
    }

    const extractChunk = async (pageNo: number): Promise<ExtractedPage> => {
      if (isPdf && fetchResult.rawBuffer) {
        return extractPdf(fetchResult.rawBuffer, url, finalUrl, task.contentLimit, false, 20, pageNo);
      }
      if (isPdf && fetchResult.html && fetchResult.html.startsWith("%PDF")) {
        const buf = Buffer.from(fetchResult.html, "binary");
        return extractPdf(buf, url, finalUrl, task.contentLimit, false, 20, pageNo);
      }
      return extractPage(fetchResult.html, url, finalUrl, task.contentLimit, task.maxOutlinksPerPage, pageNo);
    };

    page = await extractChunk(1);

    // Deep extraction: `extractPage`/`extractPdf` return only `contentLimit`
    // chars per chunk (page 1). For deeper presets, stitch the next chunks of the
    // SAME document so long articles/papers are captured in full.
    const availableChunks = page.totalPages ?? 1;
    if (maxChunks > 1 && availableChunks > 1) {
      const total = Math.min(maxChunks, availableChunks);
      const chunks: string[] = [page.text];
      for (let p = 2; p <= total; p++) {
        if (signal.aborted) break;
        try {
          const next = await extractChunk(p);
          if (next.text.trim()) chunks.push(next.text);
        } catch {
          break;
        }
      }
      const merged = chunks.join("\n\n").trim();
      page = {
        ...page,
        text: merged.slice(0, task.contentLimit * total),
        wordCount: merged.split(/\s+/).filter(Boolean).length,
        totalPages: total,
      };
    }
  }

  const { domainScore, freshnessScore, tier } = scoreCandidate({ url, title: page.title, snippet: page.description }, query);
  const relevanceScore = computeRelevance(page.text, page.title, snippet, topicKws);

  return {
    url: normalizeUrl(page.url),
    finalUrl: normalizeUrl(page.finalUrl),
    title: page.title,
    description: page.description,
    published: page.published,
    text: page.text,
    wordCount: page.wordCount,
    outlinks: page.outlinks,
    sourceQuery: query,
    workerRole: task.role,
    workerLabel: task.label,
    domainScore,
    freshnessScore,
    tier: tier as SourceTier,
    relevanceScore,
    origin: "web" as const,
    discoveredBy: discoveredBy ?? "unknown",
    page: page.page,
    totalPages: page.totalPages,
  };
}

async function getLLMQueryMutation(
  query: string,
  topSnippets: string[],
  signal: AbortSignal,
): Promise<string | null> {
  const prompt = `You are a deep research assistant. The initial query "${query}" yielded these snippets:\n${topSnippets.slice(0, 3).join("\n")}\n\nGenerate ONE highly specific, alternative search query to find missing technical details or counter-arguments. Return ONLY the raw query string, no quotes or explanations.`;

  logLlmDiagnostics("getLLMQueryMutation", prompt);

  if (signal.aborted) return null;
  const mutated = await askLoadedModel(prompt, {
    maxTokens: 40,
    temperature: 0.7,
    timeoutMs: 15_000,
    signal,
  });
  return mutated ? mutated.replace(/^["']|["']$/g, "") : null;
}

async function fetchWithWaybackFallback(
  url: string,
  signal: AbortSignal,
  task: SwarmTask,
): Promise<Awaited<ReturnType<typeof fetchPage>>> {
  try {
    // TIER 1: Standard Fetch (keeps raw PDF buffer support)
    return await fetchPage(url, signal);
  } catch (err: any) {
    if (isAbortError(err)) throw err;

    // TIER 2: Multi-tier waterfall (got-scraping -> FlareSolverr -> Wayback Machine)
    try {
      const html = await fetchWithWaterfall(url, signal, task.flaresolverrUrl);
      if (html) {
        return {
          html,
          finalUrl: url,
          contentType: "text/html",
          rawBuffer: undefined, // Waterfall returns HTML only, not raw PDFs
        };
      }
    } catch (waterfallErr: unknown) {
      if (isAbortError(waterfallErr)) throw waterfallErr;
    }
    maybeArchivePage(url, "Fetch + waterfall both failed; preserving for later retrieval", signal, err?.message);
    throw err;
  }
}

function uniqueHostCount(hits: ReadonlyArray<{ url: string }>): number {
  const hosts = new Set<string>();
  for (const h of hits) {
    try {
      hosts.add(new URL(h.url).hostname.replace(/^www\./, ""));
    } catch {
      // ignore
    }
  }
  return hosts.size;
}

type RelevantHit = { url: string; title?: string; snippet?: string };

function tokenizeQuery(query: string): Set<string> {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "how", "what", "why", "when", "are", "was", "were", "you", "your", "this", "its", "them", "they", "about", "into", "which", "their", "there", "where", "will", "would", "can", "could", "does", "doing", "over", "under", "also", "how", "much", "many", "more", "than", "then", "his", "her", "him", "who", "an", "or", "but", "not", "be", "is", "it", "to", "via", "vs", "per", "of", "in", "on", "at", "by", "as", "if", "its", "vs", "etc"]);
  return new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9+\s]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !stop.has(t)),
  );
}

function relevanceOverlap(hits: ReadonlyArray<RelevantHit>, query: string): number {
  const terms = tokenizeQuery(query);
  if (terms.size === 0) return uniqueHostCount(hits);
  return hits.reduce((acc, h) => {
    const haystack = `${h.url} ${h.title ?? ""} ${h.snippet ?? ""}`.toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term)) return acc + 1;
    }
    return acc;
  }, 0);
}

function mutationQuality(hits: ReadonlyArray<RelevantHit>, query: string): number {
  // Reward both result diversity AND topical relevance to the original query so
  // an off-topic mutation can't "win" purely on host count.
  const diversity = uniqueHostCount(hits);
  const relevance = Math.min(relevanceOverlap(hits, query), hits.length);
  return relevance * 20 + diversity * 10 + Math.min(hits.length, 10);
}

function deduplicateByUrl<T extends { url: string }>(items: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function capCandidatesPerHost(
  candidates: ReadonlyArray<ScoredCandidate>,
  maxPerHost: number,
): ScoredCandidate[] {
  const perHost = new Map<string, number>();
  const kept: ScoredCandidate[] = [];

  for (const c of candidates) {
    const host = safeHostname(c.url);
    const count = perHost.get(host) ?? 0;
    if (count >= maxPerHost) continue;
    perHost.set(host, count + 1);
    kept.push(c);
  }

  return kept;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function truncUrl(url: string, max = 70): string {
  return url.length > max ? url.slice(0, max) + "…" : url;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown");
}