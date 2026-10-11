import { runWorker, CrawlMetrics } from "./worker";
import { SwarmBlackboard } from "./blackboard";
import { topicNeedsLocalSources } from "../local/gatekeeper";
import { extractUncertaintyQueries } from "./uncertainty-miner";
import {
  buildQueryPlan,
  buildAdaptiveGapFill,
  summariseFindings,
} from "../planning/planner";
import { detectCoveredDimensions, DIMENSIONS, detectGaps } from "../planning/dimensions";
import {
  ResearchConfig,
  SwarmTask,
  WorkerResult,
  CrawledSource,
  WorkerRole,
  AgentMessage,
  StatusFn,
  WarnFn,
  SourceTier,
  ContradictionEntry,
  GradedEvidenceCard,
  CriticSummary,
  SkillPack,
  BlockedUrlEntry,
} from "../types";
import { DepthProfile, CRITIC_RETRY_MAX_TASKS, CRITIC_RETRY_PAGE_BUDGET, UNCERTAINTY_MAX_QUERIES, UNCERTAINTY_PAGE_BUDGET } from "../constants";
import { DdgLimiterPool, resetThrottle } from "../net/ddg";
import { resetArchiveSession, getArchiveState } from "../net/http";
import { VisitedPageCache, normalizeUrl, type VisitedCacheStats } from "./visited-cache";
import { log } from "./logger";
import { buildEvidenceCards } from "../scoring/evidence";
import { runCritic, buildRetryQueries } from "../scoring/critic";
import { SearchHealthTracker, EngineState } from "./health";
import { LlmCallManager, askLoadedModel, hasLoadedModel, setLlmConcurrency } from "../utils/llm";
import { selectSkillForTags, skillLabel } from "../skills/select";
import { getEngineStats, getLearnedHints } from "./learning";
import { persistRunMemory } from "../memory/persist";
import { retrieveMemoryForTopic } from "../memory/retrieve";
import { probeFlareSolverr, resetFsStats } from "../net/waterfallFetcher";
import { resetDecodoSession, setDecodoToken, getDecodoStats } from "../net/decodoApi";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type GapPlanLike = {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
};

function zeroMetrics(): CrawlMetrics {
  return {
    ddgQueries: 0, ddgHits: 0, mutatedQueriesTried: 0, mutationAccepted: 0,
    mutationHits: 0, extraEngineQueries: 0, extraEngineHits: 0, rawHits: 0,
    dedupedHits: 0, rankedCandidates: 0, fetchCandidates: 0, fetchAttempts: 0,
    fetchFailures: 0, acceptedSources: 0, skippedLowWordCount: 0, skippedOffTopic: 0,
    skippedVeryOffTopic: 0, skippedDuplicateContent: 0, skippedVisited: 0,
    skippedDomainCap: 0, skippedAvoided: 0, skippedBlacklisted: 0, skippedNegativeCache: 0,
    cacheChecks: 0,
    cacheHits: 0, cacheAccepted: 0, cacheRejectedDuplicate: 0, cacheRejectedOffTopic: 0,
    cacheRejectedLowWordCount: 0, cacheWrites: 0, followedLinks: 0,
    crossWorkerDiscoveriesUsed: 0, localSourcesAccepted: 0, skippedDomainPolicy: 0,
  };
}

function mergeMetricObjects(base: CrawlMetrics, delta: Partial<CrawlMetrics>): CrawlMetrics {
  const next = { ...base };
  for (const key of Object.keys(next) as Array<keyof CrawlMetrics>) {
    next[key] = (next[key] ?? 0) + (delta[key] ?? 0);
  }
  return next;
}

function formatProgressBar(current: number, total: number, width: number = 20): string {
  if (total <= 0) return `[${"░".repeat(width)}] 0%`;
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  const filled = Math.round((pct / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pct}%`;
}

class MutableCrawlState implements SharedCrawlState {
  private readonly _visitedUrls = new Set<string>();
  private readonly _contentHashes = new Set<string>();
  private readonly _domainCounts = new Map<string, number>();
  private readonly _domainFailures = new Map<string, number>();
  private readonly _blacklistedDomains = new Set<string>();
  private readonly _discoveries: Array<{ url: string; title: string; fromWorker: string }> = [];
  private readonly _failedUrls = new Map<string, { count: number; reason: string; lastFailedAt: string }>();
  private readonly _failedHosts = new Map<string, { count: number; reason: string; lastFailedAt: string }>();
  private readonly visitedCache: VisitedPageCache;
  private _metrics: CrawlMetrics = zeroMetrics();

  constructor(cacheDurationDays: number = 30) {
    this.visitedCache = new VisitedPageCache(cacheDurationDays);
  }

  get visitedUrls(): ReadonlySet<string> { return this._visitedUrls; }
  get contentHashes(): ReadonlySet<string> { return this._contentHashes; }
  get domainCounts(): ReadonlyMap<string, number> { return this._domainCounts; }
  get domainFailures(): ReadonlyMap<string, number> { return this._domainFailures; }

  addVisited(url: string): void { this._visitedUrls.add(normalizeUrl(url)); }
  addHash(hash: string): void { this._contentHashes.add(hash); }
  incrementDomain(url: string): void {
    const host = safeHostname(url);
    if (!host) return;
    this._domainCounts.set(host, (this._domainCounts.get(host) ?? 0) + 1);
  }
  domainCount(url: string): number {
    const host = safeHostname(url);
    return host ? (this._domainCounts.get(host) ?? 0) : 0;
  }

  noteFailure(url: string, reason: string, at: string = new Date().toISOString()): void {
    const normalized = normalizeUrl(url);
    const prevUrl = this._failedUrls.get(normalized);
    this._failedUrls.set(normalized, { count: (prevUrl?.count ?? 0) + 1, reason, lastFailedAt: at });
    const host = safeHostname(normalized);
    if (!host) return;
    const prevHost = this._failedHosts.get(host);
    this._failedHosts.set(host, { count: (prevHost?.count ?? 0) + 1, reason, lastFailedAt: at });
  }

  noteDomainFailure(url: string): void {
    const host = safeHostname(url);
    if (!host) return;
    const count = (this._domainFailures.get(host) ?? 0) + 1;
    this._domainFailures.set(host, count);
    if (count >= 3) this._blacklistedDomains.add(host);
  }

  listBlockedUrls(): ReadonlyArray<BlockedUrlEntry> {
    return Array.from(this._failedUrls.entries())
      .map(([url, info]) => ({
        url,
        reason: info.reason,
        count: info.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);
  }

  isDomainBlacklisted(url: string): boolean {
    const host = safeHostname(url);
    return host ? this._blacklistedDomains.has(host) : false;
  }

  shouldAvoidUrl(url: string): boolean {
    const normalized = normalizeUrl(url);
    if (this._failedUrls.has(normalized)) return true;
    const host = safeHostname(normalized);
    if (!host) return false;
    const hostFailCount = this._failedHosts.get(host)?.count ?? 0;
    return hostFailCount >= 2;
  }

  pushDiscovery(url: string, title: string, fromWorker: string): void {
    const normalized = normalizeUrl(url);
    if (!this._visitedUrls.has(normalized)) {
      this._discoveries.push({ url: normalized, title, fromWorker });
    }
  }

  drainDiscoveries(limit: number): ReadonlyArray<{ url: string; title: string }> {
    const results: Array<{ url: string; title: string }> = [];
    while (results.length < limit && this._discoveries.length > 0) {
      const item = this._discoveries.shift()!;
      if (!this._visitedUrls.has(normalizeUrl(item.url))) {
        results.push({ url: item.url, title: item.title });
      }
    }
    return results;
  }

  isRecentlyVisited(url: string): boolean { return this.visitedCache.hasRecent(url); }
  getCachedSource(url: string): CrawledSource | null { return this.visitedCache.getRecent(url); }
  markVisitedPersistent(source: CrawledSource): void { this.visitedCache.markVisited(source); }
  isRejected(url: string): boolean { return this.visitedCache.isRejected(url); }
  markRejected(url: string, reason?: string): void { this.visitedCache.markRejected(url, reason); }
  pruneVisitedCache(): void { this.visitedCache.prune(); }
  cacheStats(): VisitedCacheStats { return this.visitedCache.stats(); }
  flushCache(): void { this.visitedCache.flush(); }
  getMetricsSnapshot(): Readonly<CrawlMetrics> { return this._metrics; }
  mergeMetrics(delta: Partial<CrawlMetrics>): void { this._metrics = mergeMetricObjects(this._metrics, delta); }
}

const CORE_ROLES: ReadonlyArray<WorkerRole> = ["breadth", "depth", "recency", "academic", "critical"];
const EXTENDED_ROLES: ReadonlyArray<WorkerRole> = ["statistical", "regulatory", "technical", "primary", "comparative"];
const ROLE_LABELS: Readonly<Record<WorkerRole, string>> = {
  breadth: "Breadth", depth: "Depth", recency: "Recency", academic: "Academic", critical: "Critical",
  statistical: "Statistical/Data", regulatory: "Regulatory/Policy", technical: "Technical Deep-Dive",
  primary: "Primary Sources", comparative: "Comparative Analysis",
};

function getEnginesForRole(
  role: WorkerRole,
  cfg: ResearchConfig,
  mode: "adaptive" | "benchmark" | "priority"
): ReadonlyArray<string> {
  const freeEngines: string[] = ["ddg", "bing", "brave"];
  if (cfg.enableReferenceSearch) freeEngines.push("reference");
  if (cfg.enableAcademicAPIs) freeEngines.push("openalex", "crossref", "arxiv");
  if (cfg.enableYouTube) freeEngines.push("youtube");
  if (cfg.rssFeedUrls && cfg.rssFeedUrls.length > 0) freeEngines.push("rss");
  if (cfg.telegramChannels && cfg.telegramChannels.length > 0) freeEngines.push("telegram");
  freeEngines.push("gdelt");

  if (mode === "benchmark") {
    return [...freeEngines, cfg.serperApiKey ? "serper" : "", cfg.braveApiKey ? "brave-api" : ""].filter(Boolean);
  }

  const roleEngines: string[] = [];
  if (cfg.enableReferenceSearch && (role === "breadth" || role === "academic")) roleEngines.push("reference");
  if (cfg.enableYouTube && (role === "breadth" || role === "academic")) roleEngines.push("youtube");
  if (cfg.enableAcademicAPIs && (role === "academic" || role === "technical")) roleEngines.push("openalex", "crossref", "arxiv");
  if (role === "recency" || role === "critical") roleEngines.push("gdelt");

  roleEngines.push("ddg", "bing", "brave");

  if (mode === "priority" && cfg.enableAdaptiveLearning !== false) {
    return getEngineStats().orderEngines(roleEngines);
  }

  return roleEngines;
}

function rolesForProfile(profile: DepthProfile): ReadonlyArray<WorkerRole> {
  if (profile.depthRounds >= 10) return [...CORE_ROLES, ...EXTENDED_ROLES];
  if (profile.depthRounds >= 5) return [...CORE_ROLES, "technical", "comparative", "statistical"];
  return [...CORE_ROLES];
}

function buildTaskBase(
  profile: DepthProfile,
  cfg: ResearchConfig,
): Pick<
  SwarmTask,
  | "contentLimit"
  | "safeSearch"
  | "searchResultsPerQuery"
  | "maxPagesPerDomain"
  | "maxLinksToEvaluate"
  | "maxLinksToFollow"
  | "candidatePoolMultiplier"
  | "workerConcurrency"
  | "minRelevanceScore"
  | "maxOutlinksPerPage"
  | "searchPages"
  | "extraEngines"
  | "linkCrawlDepth"
  | "queryMutationThreshold"
  | "extractPagesPerSource"
  | "evidenceExcerptChars"
  | "enableLocalSources"
  | "localLibraryIds"
  | "timeRange"
  | "roleLibraryMap"
  | "serperApiKey"
  | "braveApiKey"
  | "enableYouTube"
  | "flaresolverrUrl"
  | "rssFeedUrls"
  | "telegramChannels"
  | "enableAdaptiveLearning"
  | "allowedDomains"
  | "blockedDomains"
  | "maxPdfBytes"
> {
  return {
    contentLimit:
      cfg.contentLimitMode === "manual"
        ? cfg.contentLimitPerPage
        : profile.defaultContentLimit,
    safeSearch: cfg.safeSearch,
    searchResultsPerQuery:
      cfg.searchResultsPerQuery && cfg.searchResultsPerQuery > 0
        ? cfg.searchResultsPerQuery
        : profile.searchResultsPerQuery,
    maxPagesPerDomain: profile.maxPagesPerDomain,
    maxLinksToEvaluate: profile.maxLinksToEvaluate,
    maxLinksToFollow: profile.maxLinksToFollow,
    candidatePoolMultiplier: profile.candidatePoolMultiplier,
    workerConcurrency: profile.workerConcurrency,
    minRelevanceScore: profile.minRelevanceScore,
    maxOutlinksPerPage: profile.maxOutlinksPerPage,
    searchPages: profile.searchPages,
    extraEngines: getEnginesForRole("breadth", cfg, cfg.engineSelectionMode ?? "adaptive"),
    linkCrawlDepth: profile.linkCrawlDepth,
    queryMutationThreshold: profile.queryMutationThreshold,
    extractPagesPerSource: profile.extractPagesPerSource,
    evidenceExcerptChars:
      cfg.evidenceExcerptChars && cfg.evidenceExcerptChars > 0
        ? cfg.evidenceExcerptChars
        : profile.evidenceExcerptChars,
    enableLocalSources: cfg.enableLocalSources,
    localLibraryIds: cfg.localLibraryIds,
    timeRange: cfg.timeRange,
    roleLibraryMap: cfg.roleLibraryMap,
    serperApiKey: cfg.serperApiKey,
    braveApiKey: cfg.braveApiKey,
    enableYouTube: cfg.enableYouTube,
    flaresolverrUrl: cfg.flaresolverrUrl,
    rssFeedUrls: cfg.rssFeedUrls,
    telegramChannels: cfg.telegramChannels,
    enableAdaptiveLearning: cfg.enableAdaptiveLearning !== false,
    allowedDomains: cfg.allowedDomains,
    blockedDomains: cfg.blockedDomains,
    maxPdfBytes: cfg.maxPdfBytes && cfg.maxPdfBytes > 0 ? cfg.maxPdfBytes : undefined,
  };
}

function buildStaticTask(
  role: WorkerRole,
  queries: ReadonlyArray<string>,
  profile: DepthProfile,
  cfg: ResearchConfig,
  subIdx: number = 0,
): SwarmTask {
  const followRoles: ReadonlyArray<WorkerRole> = ["depth", "academic", "technical", "primary"];
  const academicTiers: ReadonlyArray<SourceTier> = ["academic", "government", "reference"];
  const enginesForRole = getEnginesForRole(role, cfg, cfg.engineSelectionMode ?? "adaptive");

  return {
    ...buildTaskBase(profile, cfg),
    extraEngines: enginesForRole,
    id: `${role}-s${subIdx}-${Date.now()}`,
    role,
    label: subIdx > 0 ? `${ROLE_LABELS[role]} #${subIdx + 1}` : ROLE_LABELS[role],
    queries: [...queries],
    pageBudget: profile.pageBudgetPerWorker,
    followLinks: cfg.enableLinkFollowing && followRoles.includes(role),
    preferredTiers: role === "academic" || role === "regulatory" ? academicTiers : undefined,
  };
}

function fanOutQueries(
  queries: ReadonlyArray<string>,
  fanOut: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (fanOut <= 1 || queries.length <= 2) return [queries];
  const groups: string[][] = Array.from({ length: fanOut }, () => []);
  for (let i = 0; i < queries.length; i++) {
    groups[i % fanOut].push(queries[i]);
  }
  return groups.filter((g) => g.length > 0);
}

function buildRound1Tasks(
  roles: ReadonlyArray<WorkerRole>,
  queriesByRole: Partial<Record<WorkerRole, ReadonlyArray<string>>>,
  profile: DepthProfile,
  cfg: ResearchConfig,
): SwarmTask[] {
  const allQueries = Array.from(
    new Set(
      Object.values(queriesByRole)
        .flatMap((qs) => qs ?? [])
        .filter((q): q is string => Boolean(q)),
    ),
  );
  const round1Tasks: SwarmTask[] = [];
  for (const role of roles) {
    const roleQueries = (queriesByRole[role] ?? []).filter(Boolean);
    const effectiveQueries = roleQueries.length > 0 ? roleQueries : allQueries;
    const groups = fanOutQueries(effectiveQueries, profile.workerFanOut);
    for (const [subIdx, group] of groups.entries()) {
      if (group.length > 0) {
        round1Tasks.push(buildStaticTask(role, group, profile, cfg, subIdx));
      }
    }
  }
  return round1Tasks;
}

function buildGapTasks(
  gapPlans: ReadonlyArray<GapPlanLike>,
  round: number,
  profile: DepthProfile,
  cfg: ResearchConfig,
): SwarmTask[] {
  const tasks: SwarmTask[] = [];
  const gapEngines: string[] = [];
  if (cfg.serperApiKey) gapEngines.push("serper");
  if (cfg.braveApiKey) gapEngines.push("brave-api");
  if (gapEngines.length === 0) gapEngines.push("ddg", "bing", "brave");

  for (const [subIdx, gapPlan] of gapPlans.entries()) {
    if (gapPlan.queries.length === 0) continue;
    tasks.push({
      ...buildTaskBase(profile, cfg),
      extraEngines: gapEngines,
      id: `gap-${gapPlan.role}-r${round}-s${subIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: gapPlan.role,
      label: subIdx > 0 ? `${gapPlan.label} #${subIdx + 1}` : gapPlan.label,
      queries: [...gapPlan.queries],
      pageBudget: profile.pageBudgetPerGapWorker,
      followLinks: cfg.enableLinkFollowing && gapPlan.followLinks,
      preferredTiers: gapPlan.preferredTiers,
    });
  }
  return tasks;
}

async function runTaskGroup(
  tasks: ReadonlyArray<SwarmTask>,
  state: SharedCrawlState,
  pool: DdgLimiterPool,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  topicKeywords: ReadonlyArray<string>,
  health: SearchHealthTracker,
  llmManager: LlmCallManager
): Promise<WorkerResult[]> {
  const combined = combineAbortSignals(signal, llmManager.signal);

  const watchdog = setInterval(() => {
    if (llmManager.checkStall() && !llmManager.signal.aborted) {
      llmManager.abort();
      warn("[WATCHDOG] Stall detected (no accepted sources for 2 minutes). Flushing partial results to synthesis.");
    }
  }, 10_000);

  try {
    return await Promise.all(
      tasks.map((task) => {
        const limiter = pool.next();
        return runWorker(
          task,
          state,
          combined,
          status,
          warn,
          topicKeywords,
          limiter,
          health,
          llmManager
        ).catch((err: unknown) => {
          if (!isAbortError(err)) {
            warn(`[${task.label}] crashed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return {
            taskId: task.id,
            role: task.role,
            label: task.label,
            sources: [],
            queries: [],
            errors: [String(err)],
          } satisfies WorkerResult;
        });
      }),
    );
  } finally {
    clearInterval(watchdog);
  }
}

export interface OrchestratorResult {
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly workerErrors: ReadonlyArray<string>;
  readonly usedAI: boolean;
  readonly topicKeywords: ReadonlyArray<string>;
  /** Critic-graded evidence ledger (pass + fail cards) when the critic ran. */
  readonly gradedCards?: ReadonlyArray<GradedEvidenceCard>;
  readonly criticSummary?: CriticSummary;
  /** Planner domain tags, used for skill-pack auto-selection (item 8). */
  readonly domainTags?: ReadonlyArray<string>;
  /** Auto-selected skill pack applied to critic + synthesis prompts. */
  readonly skill?: SkillPack;
  /** Raw ` thinking` reasoning trace captured from the planner. */
  readonly plannerReasoning?: string;
  /** Unresolved questions mined from the planner trace and searched in Round 2. */
  readonly minedUncertaintyQueries?: ReadonlyArray<string>;
  readonly blackboardSnapshot?: import("./blackboard").BlackboardSnapshot;
  readonly runStats?: {
    readonly ddgState: EngineState;
    readonly ddgQueries: number;
    readonly ddgBlocks: number;
    readonly pagesArchived: number;
    readonly archiveSubmitFailures: number;
    readonly llmCallsUsed: number;
    readonly llmCallBudget: number;
    readonly runtimeElapsedMs: number;
    readonly sessionLimitMs: number;
    readonly effectiveRuntimeMs: number;
    readonly cacheEntries: number;
    readonly cacheNegativeEntries: number;
    readonly cacheFile: string;
    readonly cacheMaxAgeDays: number;
    readonly cacheMaxEntries: number;
    readonly criticCallsUsed: number;
    readonly criticRetrySourcesAdded: number;
  };
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
  pruneVisitedCache(): void;
  cacheStats(): VisitedCacheStats;
  flushCache(): void;
  getMetricsSnapshot(): Readonly<CrawlMetrics>;
  mergeMetrics(delta: Partial<CrawlMetrics>): void;
}

export async function runSwarm(
  cfg: ResearchConfig,
  profile: DepthProfile,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  const fileStatus: StatusFn = (msg: string) => { log(msg); status(msg); };
  const fileWarn: WarnFn = (msg: string) => { log(`[WARN] ${msg}`); warn(msg); };

  const state = new MutableCrawlState(cfg.cacheDuration ? parseInt(cfg.cacheDuration, 10) : 30);
  state.pruneVisitedCache();
  const allSources: CrawledSource[] = [];
  const allQueries: string[] = [];
  const allErrors: string[] = [];
  
  const health = new SearchHealthTracker();
  const llmManager = new LlmCallManager(cfg.llmCallMode ?? "standard", cfg.contextIsolation ?? "strict");
  resetArchiveSession();
  resetFsStats();
  resetDecodoSession();
  setDecodoToken(cfg.decodoApiToken);
  const runStartedAt = Date.now();

  // item 5: bound parallel LLM predictions (default 1 — a single kv-cache slot).
  setLlmConcurrency(cfg.llmConcurrency && cfg.llmConcurrency > 0 ? cfg.llmConcurrency : 1);

  // ==========================================
  // FLARESOLVERR PRE-FLIGHT PROBE
  // ==========================================
  {
    const fsUrl = cfg.flaresolverrUrl?.trim() ?? "";
    if (fsUrl) {
      fileStatus(`[FLARESOLVERR] Probing ${fsUrl} ...`);
      const fs = await probeFlareSolverr(fsUrl, llmManager.signal);
      if (fs.reachable) {
        fileStatus(`[FLARESOLVERR] Reachable — Tier B (Cloudflare bypass) enabled for blocked pages.`);
      } else {
        fileWarn(`[FLARESOLVERR] Unreachable (${fs.probeError ?? "no response"}) — falling back to Wayback tier for blocked pages.`);
      }
    } else {
      resetFsStats();
      fileStatus(`[FLARESOLVERR] Not configured — anti-bot bypass disabled (falling back to Wayback).`);
    }
  }

  // ==========================================
  // DECODO PRE-FLIGHT
  // ==========================================
  {
    const dd = getDecodoStats();
    if (dd.configured) {
      fileStatus(`[DECODO] Web Scraping API configured — server-side fetch tier enabled for TCP-blocked engines (e.g. DDG).`);
    } else {
      fileStatus(`[DECODO] Not configured — server-side fetch tier disabled.`);
    }
  }

  fileStatus(`\n🚀 DEEP RESEARCH SWARM LAUNCHED (Strict Priority Mode)\n`);
  fileStatus(`[RUN CONTROL] Budget: ${llmManager.budget.maxGlobalCalls} calls | Timeout: ${llmManager.budget.maxRuntimeMs / 60000}m | Isolation: ${llmManager.isolationMode}`);

  const plan = await buildQueryPlan(
    cfg.topic,
    cfg.enableAdaptiveLearning !== false
      ? [...cfg.focusAreas, ...getLearnedHints().all().slice(0, 5)]
      : cfg.focusAreas,
    cfg.enableAIPlanning,
    fileStatus,
    profile,
  );
  const memoryContext = retrieveMemoryForTopic({
  topic: cfg.topic,
  topicKeywords: plan.topicKeywords,
});
void memoryContext;
  const roles = rolesForProfile(profile);
  const pool = new DdgLimiterPool(profile.searchLanes, profile.ddgRateLimitMs);

  // item 8: auto-select a skill pack from the planner's domain tags and apply
  // it to the critic + synthesis prompts. Available without LLM calls.
  const skill = selectSkillForTags(plan.domainTags ?? []) ?? undefined;
  if (skill) {
    fileStatus(
      `[SKILL] Auto-selected pack "${skill.name}" v${skill.version} from tags: ${(plan.domainTags ?? []).join(", ")}${skill.userOverride ? " (user override)" : " (bundled)"}`,
    );
  }

  // Time budget: keep min(session, LLM mode cap) for a finite session. A value
  // of 0 means "no session limit" for crawling (LLM calls remain bounded by the
  // mode budget). The effective runtime is enforced by a real wall-clock timer.
  const sessionLimitMs =
    cfg.maxSessionMs && cfg.maxSessionMs > 0 ? cfg.maxSessionMs : Infinity;
  const modeRuntimeCapMs = llmManager.budget.maxRuntimeMs;
  const effectiveRuntimeMs =
    sessionLimitMs === Infinity ? Infinity : Math.min(sessionLimitMs, modeRuntimeCapMs);
  const fmtMin = (ms: number) => (ms === Infinity ? "unlimited" : `${Math.round(ms / 60000)}m`);
  const startTime = Date.now();
  const crawlDeadline =
    effectiveRuntimeMs === Infinity ? Infinity : startTime + effectiveRuntimeMs * 0.80; // Reserve 20% for synthesis

  // item 5: the shared blackboard — plan, gaps, cards, blocked_urls, time_left.
  const blackboard = new SwarmBlackboard(() => state.listBlockedUrls(), crawlDeadline);
  blackboard.attachPlan(plan.researchPlan ?? null);

  // ==========================================
  // LAYER 1: THE AI RAG GATEKEEPER
  // ==========================================
  let shouldSearchLocal = cfg.enableLocalSources;

  if (shouldSearchLocal && plan.usedAI) {
    fileStatus(`\n🤖 PRE-FLIGHT: Validating if topic requires local RAG...`);
    const gate = await topicNeedsLocalSources({
      topic: cfg.topic,
      signal,
    });
    if (gate === "no") {
      fileWarn(`[RAG GATE] Topic does not require local files. Bypassing Layer 1 to save context budget.`);
      shouldSearchLocal = false;
    } else if (gate === "error") {
      fileWarn(`[RAG GATE] LLM check failed, defaulting to web-only.`);
      shouldSearchLocal = false;
    }
  }

  if (shouldSearchLocal) {
    fileStatus(`\n📚 LAYER 1: Searching Local RAG Libraries...`);
    const localTasks = buildRound1Tasks(roles, plan.queriesByRole, profile, cfg);
    const localOnlyTasks = localTasks.map(t => ({ ...t, extraEngines: [] as ReadonlyArray<string> }));
    const localResults = await runTaskGroup(localOnlyTasks, state, pool, signal, fileStatus, fileWarn, plan.topicKeywords, health, llmManager);
    aggregateResults(localResults, allSources, allQueries, allErrors);
    
    health.localChunksRetrieved = allSources.length;
    health.localChunksAccepted = allSources.length;
    fileStatus(`✅ Layer 1 Complete. Found ${allSources.length} local sources.`);
  } else {
    fileStatus(`\n⚠️ Local sources disabled or bypassed. Proceeding to web search.`);
  }

  // ==========================================
  // LAYERS 2-5: EXTERNAL GAP-DRIVEN SEARCH
  // ==========================================
  fileStatus(`\n🌐 LAYERS 2-5: External Gap-Driven Search...`);
  
  const coveredIds = detectCoveredDimensions(allSources.map(s => s.text));
  const gaps = detectGaps(coveredIds);
  
  for (const gap of gaps) {
    if (signal.aborted) break;
    blackboard.addGap(gap.label);
    health.gaps.push({
      id: `gap-${gap.id}`,
      topic: cfg.topic,
      missingClaim: gap.label,
      whyInsufficient: `Dimension ${gap.label} not covered by local sources`,
      freshnessRequired: gap.id === 'current' || gap.id === 'future',
      preferredTier: null,
      searchLayerAuthorized: "DDG",
      resolved: false
    });
  }

  let externalTasks = buildGapTasks(gaps.map(g => ({
    role: "breadth", 
    label: `Gap: ${g.label}`,
    queries: g.queries(cfg.topic),
    followLinks: true
  })) as ReadonlyArray<GapPlanLike>, 1, profile, cfg).map(task => {
    // ENCYCLOPEDIA FORCING: Append site operators for academic/breadth roles
    if (cfg.enableReferenceSearch && (task.role === "academic" || task.role === "breadth")) {
      return {
        ...task,
        queries: task.queries.map(q => `${q} (site:wikipedia.org OR site:britannica.com OR site:encyclopedia.com)`)
      };
    }
    return task;
  });

  fileStatus(
    `[RUN CONTROL] Session limit: ${fmtMin(sessionLimitMs)} | LLM mode cap: ${fmtMin(modeRuntimeCapMs)} | Effective runtime: ${fmtMin(effectiveRuntimeMs)} (crawl stops at 80%)`,
  );

  // Hard wall-clock enforcement: abort the whole swarm when the effective
  // runtime elapses, so a slow layer can't silently overrun the budget.
  let hardStopTimer: NodeJS.Timeout | null = null;
  if (effectiveRuntimeMs !== Infinity) {
    hardStopTimer = setTimeout(() => {
      if (!llmManager.signal.aborted) {
        fileWarn(
          `[TIME LIMIT] Effective runtime reached (${fmtMin(effectiveRuntimeMs)}). ` +
          `Aborting workers and flushing partial results to synthesis.`,
        );
        llmManager.abort();
      }
    }, effectiveRuntimeMs);
    if (typeof hardStopTimer.unref === "function") hardStopTimer.unref();
  }

  // Dedicated feeds pass: when RSS feeds / Telegram channels are configured,
  // query them once for the topic (plus the top planned queries) instead of
  // adding them to every worker's engine set.
  if (
    !signal.aborted &&
    !llmManager.signal.aborted &&
    Date.now() < crawlDeadline &&
    (cfg.rssFeedUrls?.length || cfg.telegramChannels?.length)
  ) {
    const feedEngines: string[] = [];
    if (cfg.rssFeedUrls && cfg.rssFeedUrls.length > 0) feedEngines.push("rss");
    if (cfg.telegramChannels && cfg.telegramChannels.length > 0) feedEngines.push("telegram");

    const plannedQueries = Object.values(plan.queriesByRole)
      .flatMap((qs) => qs ?? [])
      .filter(Boolean) as ReadonlyArray<string>;
    const feedQueries = [cfg.topic, ...plannedQueries]
      .filter((q, i, arr) => arr.indexOf(q) === i)
      .slice(0, 3);

    fileStatus(`\n📡 FEEDS: Querying ${feedEngines.join(", ")} for ${feedQueries.length} quer${feedQueries.length === 1 ? "y" : "ies"}...`);
    const feedTask: SwarmTask = {
      ...buildStaticTask("breadth", feedQueries, profile, cfg),
      label: "Feeds",
      extraEngines: feedEngines,
    };
    const feedResults = await runTaskGroup(
      [feedTask], state, pool, signal, fileStatus, fileWarn, plan.topicKeywords, health, llmManager,
    );
    const prevFeedCount = allSources.length;
    aggregateResults(feedResults, allSources, allQueries, allErrors);
    fileStatus(`✅ Feeds pass complete. Added ${allSources.length - prevFeedCount} source(s).`);
  }

  for (const layer of ["DDG", "SEARXNG", "DIRECT", "API"]) {
    if (Date.now() >= crawlDeadline || signal.aborted || llmManager.signal.aborted || externalTasks.length === 0) {
      fileWarn(`[TIME ALLOCATION] Crawl budget elapsed, swarm stalled, or tasks finished. Transitioning to verification & synthesis.`);
      break;
    }

    // Fragile HTML-scrape engines (bing, brave, google, scholar, searxng,
    // mojeek, yandex, youtube) have per-engine health cooldowns, so the DIRECT
    // layer fans out to every available free engine instead of just a couple.
    const trackedEngines = new Set(["bing", "brave", "google", "scholar", "searxng", "mojeek", "yandex", "youtube"]);

    let layerEngines: string[] = [];
    if (layer === "DDG" && health.isDdgAvailable()) layerEngines = ["ddg"];
    else if (layer === "SEARXNG" && !health.isDdgAvailable()) layerEngines = ["searxng"];
    else if (layer === "DIRECT") {
      const free = ["bing", "brave", "google", "scholar", "mojeek", "yandex", "youtube", "reference", "gdelt"];
      layerEngines = free.filter(
        (engine) => !trackedEngines.has(engine) || health.isOtherEngineAvailable(engine),
      );
    }
    else if (layer === "API" && health.canUseApi() && (cfg.serperApiKey || cfg.braveApiKey)) {
      const apiEngines: string[] = [];
      if (cfg.serperApiKey) apiEngines.push("serper");
      if (cfg.braveApiKey) apiEngines.push("brave-api");
      layerEngines = apiEngines;
    }

    if (layerEngines.length === 0) continue;

    fileStatus(`\n🔍 Executing Layer: ${layer} (${layerEngines.join(", ")})`);
    const layerTasks = externalTasks.map(t => ({ ...t, extraEngines: layerEngines }));
    const layerResults = await runTaskGroup(layerTasks, state, pool, signal, fileStatus, fileWarn, plan.topicKeywords, health, llmManager);
    
    const prevSourceCount = allSources.length;
    aggregateResults(layerResults, allSources, allQueries, allErrors);
    const newSources = allSources.length - prevSourceCount;

    // Mark gaps resolved for the report whenever a layer contributed sources,
    // but do NOT clear the task list: later layers still get to run so we
    // harvest results from every healthy engine set (bounded by crawlDeadline).
    if (newSources > 0) {
      health.gaps.forEach(g => { g.resolved = true; });
    }
    if (layer === "API") health.apiCallsMade++;
  }

  // ==========================================
  // EPISTEMIC UNCERTAINTY MINING (DeepThink)
  // ==========================================
  // The planner runs with reasoning enabled. Mine the unresolved questions it
  // flagged in its ` thinking` trace, dedupe them against everything already
  // searched, and run one bounded extra search wave before the final cap and
  // the critic so the new sources are graded into the same ledger.
  const plannerReasoning = plan.plannerReasoning ?? "";
  let minedUncertaintyQueries: ReadonlyArray<string> = [];
  if (
    plannerReasoning &&
    !signal.aborted &&
    !llmManager.signal.aborted &&
    Date.now() < crawlDeadline
  ) {
    const alreadySearched = new Set(allQueries.map((q) => q.toLowerCase()));
    minedUncertaintyQueries = extractUncertaintyQueries(
      plannerReasoning,
      cfg.topic,
    )
      .filter((q) => !alreadySearched.has(q.toLowerCase()))
      .slice(0, UNCERTAINTY_MAX_QUERIES);

    if (minedUncertaintyQueries.length > 0) {
      fileStatus(
        `\n🧠 EPISTEMIC UNCERTAINTY: planner flagged ${minedUncertaintyQueries.length} unresolved question(s) — launching targeted mining round...`,
      );
      const uncertaintyTasks = buildGapTasks(
        [
          {
            role: "critical",
            label: `Uncertainty Mining: ${minedUncertaintyQueries[0].slice(0, 60)}`,
            queries: minedUncertaintyQueries,
            followLinks: false,
          } satisfies GapPlanLike,
        ],
        2,
        profile,
        cfg,
      ).map((t) => ({ ...t, pageBudget: UNCERTAINTY_PAGE_BUDGET }));

      const beforeMining = allSources.length;
      const miningResults = await runTaskGroup(
        uncertaintyTasks,
        state,
        pool,
        signal,
        fileStatus,
        fileWarn,
        plan.topicKeywords,
        health,
        llmManager,
      );
      aggregateResults(miningResults, allSources, allQueries, allErrors);
      const miningAdded = allSources.length - beforeMining;
      fileStatus(
        miningAdded > 0
          ? `✅ [UNCERTAINTY] Mining round added ${miningAdded} new source(s).`
          : `[UNCERTAINTY] Mining round found no new sources.`,
      );
    }
  }

  // Cap Sources to Top-N before logging and passing to synthesis
  const sortedSources = [...allSources].sort((a, b) => {
    const scoreA = (a.domainScore * 0.4) + (a.relevanceScore * 100 * 0.6);
    const scoreB = (b.domainScore * 0.4) + (b.relevanceScore * 100 * 0.6);
    return scoreB - scoreA;
  });

  // Reassign allSources to the filtered top results
  allSources.length = 0; 
  allSources.push(...sortedSources.slice(0, profile.synthesisMaxSources || 25));

  // ==========================================
  // CRITIC / VERIFIER PHASE (evaluator-optimizer)
  // ==========================================
  // Grade the evidence cards produced by the crawl workers with a dedicated,
  // non-searching critic. Only FAILING claims trigger one targeted retry round
  // (cheaper than another full research round). The synthesis downstream reads
  // this graded ledger instead of raw worker prose.
  let gradedCards: ReadonlyArray<GradedEvidenceCard> = [];
  let criticCallsUsed = 0;
  let criticRetrySourcesAdded = 0;
  let criticFailCount = 0;
  let criticRetryTasksSpawned = false;

  if (
    !signal.aborted &&
    !llmManager.signal.aborted &&
    Date.now() < crawlDeadline &&
    !llmManager.shouldStop()
  ) {
    const ledgerCards = buildEvidenceCards(allSources, profile);
    const gradable = ledgerCards.filter((c) => c.verificationTier !== "REJECTED");

    const criticResult = await runCritic({
      cards: gradable,
      topic: cfg.topic,
      topicKeywords: plan.topicKeywords,
      llmManager,
      status: fileStatus,
      warn: fileWarn,
      signal,
      skill,
    });
    criticCallsUsed = criticResult.callsUsed;
    criticFailCount = criticResult.failed.length;
    gradedCards = [...criticResult.graded, ...criticResult.failed];

    if (
      criticResult.failed.length > 0 &&
      !signal.aborted &&
      !llmManager.signal.aborted &&
      Date.now() < crawlDeadline &&
      !llmManager.shouldStop()
    ) {
      const retryQueries = buildRetryQueries(criticResult.failed, cfg.topic, CRITIC_RETRY_MAX_TASKS);
      if (retryQueries.length > 0) {
        const retryTasks = buildGapTasks(
          [
            {
              role: "breadth",
              label: `Critic Retry: ${retryQueries[0].slice(0, 60)}`,
              queries: retryQueries,
              followLinks: false,
            } satisfies GapPlanLike,
          ],
          2,
          profile,
          cfg,
        ).map((t) => ({ ...t, pageBudget: CRITIC_RETRY_PAGE_BUDGET }));

        criticRetryTasksSpawned = true;
        fileStatus(
          `🔎 [CRITIC] ${criticResult.failed.length} failing claim(s) trigger a targeted retry round (${retryQueries.length} query/w).`,
        );
        const beforeSources = allSources.length;
        const retryResults = await runTaskGroup(
          retryTasks,
          state,
          pool,
          signal,
          fileStatus,
          fileWarn,
          plan.topicKeywords,
          health,
          llmManager,
        );
        aggregateResults(retryResults, allSources, allQueries, allErrors);
        criticRetrySourcesAdded = allSources.length - beforeSources;
        if (criticRetrySourcesAdded > 0) {
          fileStatus(`✅ [CRITIC] Retry round added ${criticRetrySourcesAdded} new source(s).`);

          // Incrementally grade only the NEW cards against the accepted
          // ledger, then rebuild the graded list aligned to final source order.
          const rebuiltCards = buildEvidenceCards(allSources, profile);
          const verdicts = new Map(gradedCards.map((g) => [g.id, g.critic]));
          const newCards = rebuiltCards.filter(
            (c) => !verdicts.has(c.id) && c.verificationTier !== "REJECTED",
          );
          if (newCards.length > 0) {
            const acceptedPrior = gradedCards.filter((g) => g.critic.pass);
            const retryCritic = await runCritic({
              cards: newCards,
              topic: cfg.topic,
              topicKeywords: plan.topicKeywords,
              llmManager,
              status: fileStatus,
              warn: fileWarn,
              signal,
              priorAccepted: acceptedPrior,
              skill,
            });
            criticCallsUsed += retryCritic.callsUsed;
            criticFailCount += retryCritic.failed.length;
            for (const gc of [...retryCritic.graded, ...retryCritic.failed]) {
              verdicts.set(gc.id, gc.critic);
            }
          }
          gradedCards = rebuiltCards
            .filter((c) => verdicts.has(c.id))
            .map((c) => ({ ...c, critic: verdicts.get(c.id)! }));
        }
      }
    }
  }

  // item 5: publish the merged evidence cards + graded ledger onto the shared
  // blackboard so downstream readers use one coordination surface.
  {
    const publishedCards = buildEvidenceCards(allSources, profile);
    blackboard.mergeCards(publishedCards);
    blackboard.mergeGraded(gradedCards);
  }

  // ==========================================
  // FILE LOGGING
  // ==========================================
  const logDir = path.join(os.homedir(), ".deep-swarm-research", "logs");
  const logFile = path.join(logDir, `run_log_${Date.now()}.txt`);
  
  let logContent = `RUN ID: ${Date.now()}\nTOPIC: ${cfg.topic}\n\n`;
  logContent += `[SKILL] ${skill ? `${skill.name} v${skill.version}${skill.userOverride ? " (override)" : ""}` : "none — no domain tags or pack match"}\n`;
  if (plan.domainTags?.length) logContent += `[SKILL] Domain tags: ${plan.domainTags.join(", ")}\n`;
  logContent += health.generateReport();
  logContent += llmManager.getReport();
  logContent += "\n\nSEARCH ENGINE ATTRIBUTION\n";
  logContent += `- Requested Route: DDG / SearxNG / Direct\n`;
  logContent += `- Actual Backend: DDG / Yandex / Bing / Google\n`;
  logContent += `- Result Domains: Tracked in worker metrics\n`;
  logContent += `\nVERIFICATION TIERS\n`;
  logContent += `- Tier A (Canonically verified): ${allSources.filter((s: CrawledSource) => s.domainScore >= 90).length}\n`;
  logContent += `- Tier B (Independently validated): ${allSources.filter((s: CrawledSource) => s.domainScore >= 80 && s.domainScore < 90).length}\n`;
  logContent += `- Tier C (Relevant candidate): ${allSources.filter((s: CrawledSource) => s.domainScore < 80).length}\n`;

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFile, logContent, "utf-8");
    fileStatus(`[LOG] Full run report saved to ${logFile}`);
  } catch (e) {
    fileWarn(`[LOG] Failed to write run log: ${e}`);
  }

  // ==========================================
  // FINAL HEALTH REPORT
  // ==========================================
  fileStatus(health.generateReport());
  fileStatus(llmManager.getReport());

  if (hardStopTimer) {
    clearTimeout(hardStopTimer);
    hardStopTimer = null;
  }
  state.flushCache();
    try {
      const failState = state as unknown as {
        _failedUrls: Map<string, unknown>;
        _failedHosts: Map<string, unknown>;
      };
      await persistRunMemory({
        runId: String(runStartedAt),
        topic: cfg.topic,
        topicKeywords: plan.topicKeywords,
        depthPreset: cfg.depthPreset,
        focusAreas: cfg.focusAreas,
        queriesUsed: allQueries,
        sourceCount: allSources.length,
        engineHits: [
          { engine: "ddg", hits: health.ddg.validResults },
          { engine: "searxng", hits: health.searxng.validResults },
          ...Object.entries(health.otherEngines).map(([engine, e]) => ({
            engine,
            hits: e.validResults,
          })),
        ],
        failedUrls: Array.from(failState._failedUrls.keys()),
        failedHosts: Array.from(failState._failedHosts.keys()),
        ledger: gradedCards.map((g) => ({
          id: g.id,
          claim: g.relevantClaim,
          verdict: g.critic.pass ? ("pass" as const) : ("fail" as const),
          contradiction: Boolean(
            (g.critic as { contradiction?: boolean }).contradiction,
          ),
        })),
        llmCallsUsed: llmManager.watchdog.llmCallsMade,
        criticCallsUsed,
        runtimeSec: Math.round(effectiveRuntimeMs / 1000),
        usedAI: plan.usedAI,
      });
    } catch (err) {
      console.warn("[memory] persistRunMemory failed", err);
    }

  return {
    sources: allSources,
    queriesUsed: [...new Set(allQueries)],
    workerErrors: allErrors,
    usedAI: plan.usedAI,
    topicKeywords: plan.topicKeywords,
    gradedCards,
    criticSummary:
      criticCallsUsed > 0 || criticFailCount > 0
        ? {
            graded: gradedCards.length,
            failed: criticFailCount,
            callsUsed: criticCallsUsed,
            retryRoundSpawned: criticRetryTasksSpawned,
            retrySourcesAdded: criticRetrySourcesAdded,
          }
        : undefined,
    runStats: buildRunStats(health, llmManager, state, runStartedAt, sessionLimitMs, effectiveRuntimeMs, criticCallsUsed, criticRetrySourcesAdded),
    domainTags: plan.domainTags,
    skill,
    plannerReasoning: plannerReasoning || undefined,
    minedUncertaintyQueries:
      minedUncertaintyQueries.length > 0 ? minedUncertaintyQueries : undefined,
    blackboardSnapshot: blackboard.snapshot(),
  };
}

/**
 * Self-improvement (F4): ask the loaded model to reflect on the strongest
 * sources from this run and persist generalizable search-strategy hints that
 * future runs fold into their query planning. Best-effort and non-blocking.
 */
async function maybeLearnFromRun(
  cfg: ResearchConfig,
  sources: ReadonlyArray<CrawledSource>,
  status: StatusFn,
): Promise<void> {
  try {
    if (!(await hasLoadedModel())) return;

    const topSources = [...sources]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 8)
      .map((s) => `- ${s.title} (${safeHostname(s.url)}, rel=${s.relevanceScore.toFixed(2)})`)
      .join("\n");

    const prompt = `You are tuning a web-research agent. Topic: "${cfg.topic}".
Best sources found:
${topSources || "(none)"}

Provide up to 3 short, generalizable search-strategy hints for future runs on similar topics.
One hint per line, no numbering, no preamble, max 160 chars each.`;

    const result = await askLoadedModel(prompt, {
      maxTokens: 220,
      temperature: 0.4,
      timeoutMs: 20_000,
    });
    if (!result) return;

    const hints = result
      .split("\n")
      .map((line) => line.replace(/^[\s\-*\d.)]+/, "").trim())
      .filter((line) => line.length > 0);
    if (hints.length > 0) {
      getLearnedHints().addHints(hints.slice(0, 3));
      status(`[LEARN] Stored ${Math.min(hints.length, 3)} strategy hint(s) for future runs.`);
    }
  } catch {
    /* best-effort */
  }
}

function buildRunStats(
  health: SearchHealthTracker,
  llmManager: LlmCallManager,
  state: SharedCrawlState,
  runStartedAt: number,
  sessionLimitMs: number,
  effectiveRuntimeMs: number,
  criticCallsUsed: number = 0,
  criticRetrySourcesAdded: number = 0,
): NonNullable<OrchestratorResult["runStats"]> {
  const archive = getArchiveState();
  const cache = state.cacheStats();
  return {
    ddgState: health.ddg.state,
    ddgQueries: health.ddg.searchesAttempted,
    ddgBlocks: health.ddg.blocks,
    pagesArchived: archive.submitted,
    archiveSubmitFailures: archive.failed + archive.skipped,
    llmCallsUsed: llmManager.watchdog.llmCallsMade,
    llmCallBudget: llmManager.budget.maxGlobalCalls,
    runtimeElapsedMs: Date.now() - runStartedAt,
    sessionLimitMs,
    effectiveRuntimeMs,
    cacheEntries: cache.entries,
    cacheNegativeEntries: cache.negativeEntries,
    cacheFile: cache.file,
    cacheMaxAgeDays: cache.maxAgeDays,
    cacheMaxEntries: cache.maxEntries,
    criticCallsUsed,
    criticRetrySourcesAdded,
  };
}

function logAggregateMetrics(
  state: SharedCrawlState,
  status: StatusFn,
  label: string,
): void {
  const m = state.getMetricsSnapshot();
  const cacheHitRate = percent(m.cacheHits, m.cacheChecks);
  const cacheAcceptRate = percent(m.cacheAccepted, m.cacheHits);
  const fetchSuccessRate = percent(m.acceptedSources - m.cacheAccepted, m.fetchAttempts);
  const dedupeRate = percent(m.rawHits - m.dedupedHits, m.rawHits);
  
  const totalSourceChars = state.getMetricsSnapshot().acceptedSources * 4000;
  const estTokensSent = state.getMetricsSnapshot().fetchAttempts * 800;
  const evidenceYield = estTokensSent > 0 ? (m.acceptedSources / estTokensSent) * 100 : 0;

  status(`[${label}] search ddg_queries=${m.ddgQueries} ddg_hits=${m.ddgHits} mutation_accepted=${m.mutationAccepted} mutation_hits=${m.mutationHits} extra_hits=${m.extraEngineHits}`);
  status(`[${label}] quality raw_hits=${m.rawHits} deduped_hits=${m.dedupedHits} dedupe_rate=${dedupeRate}% ranked=${m.rankedCandidates} accepted=${m.acceptedSources} fetch_success=${fetchSuccessRate}%`);
  status(`[${label}] cache checks=${m.cacheChecks} hits=${m.cacheHits} hit_rate=${cacheHitRate}% accepted=${m.cacheAccepted} accept_rate=${cacheAcceptRate}% writes=${m.cacheWrites}`);
  status(`[${label}] skips visited=${m.skippedVisited} dup=${m.skippedDuplicateContent} off_topic=${m.skippedOffTopic} very_off_topic=${m.skippedVeryOffTopic} low_words=${m.skippedLowWordCount} domain_cap=${m.skippedDomainCap} avoided=${m.skippedAvoided} blacklisted=${m.skippedBlacklisted} neg_cache=${m.skippedNegativeCache}`);
  status(`[${label}] 📊 DIAGNOSTICS evidence_yield=${evidenceYield.toFixed(2)}% (accepted_sources/est_llm_tokens)`);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctor = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal };
  if (typeof ctor.any === "function") {
    try {
      return ctor.any([a, b]);
    } catch {
      // fall through to manual composition
    }
  }
  const composite = new AbortController();
  const onAbort = () => composite.abort();
  if (a.aborted || b.aborted) {
    composite.abort();
  } else {
    a.addEventListener("abort", onAbort);
    b.addEventListener("abort", onAbort);
  }
  composite.signal.addEventListener("abort", () => {
    a.removeEventListener("abort", onAbort);
    b.removeEventListener("abort", onAbort);
  });
  return composite.signal;
}

function aggregateResults(
  results: ReadonlyArray<WorkerResult>,
  sources: CrawledSource[],
  queries: string[],
  errors: string[],
): void {
  for (const result of results) {
    sources.push(...result.sources);
    queries.push(...result.queries);
    errors.push(...result.errors);
  }
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}