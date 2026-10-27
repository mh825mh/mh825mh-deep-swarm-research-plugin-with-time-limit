export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly discoveredBy?: string;
  readonly requestedRoute?: string;
  readonly actualBackend?: string;
  readonly resultDomain?: string;
}

export type VerificationTier = "A" | "B" | "C" | "REJECTED";
export type ClaimStrength = "documented" | "disputed" | "anecdote" | "speculation";

export interface Outlink {
  readonly text: string;
  readonly href: string;
}

export interface ExtractedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
  readonly page?: number;
  readonly totalPages?: number;
}

export interface EntityMetadata {
  canonicalEntities?: ReadonlyArray<string>;
  author?: string;
  publisher?: string;
  officialUrl?: string;
  isSkepticOrReplication?: boolean;
}

export interface EvidenceCard {
  readonly id: string;
  readonly entityType: "book" | "podcast" | "standard" | "article" | "local document" | "web";
  readonly title: string;
  readonly authorOrHost: string;
  readonly canonicalUrl: string;
  readonly sourceTier: SourceTier;
  readonly relevantClaim: string;
  readonly supportingExcerpt: string;
  /**
   * Resolved (post-redirect) URL the card text was extracted from. Carried into
   * the verified ledger so citation verification never has to guess provenance.
   */
  readonly sourceUrl?: string;
  /** The `[n]` anchor the synthesis must use for this card. */
  readonly citationAnchor?: string;
  readonly confidence: "High" | "Medium" | "Low";
  readonly claimStrength: ClaimStrength;
  readonly freshness: string | null;
  readonly worker: string;
  readonly verificationTier: VerificationTier;
  readonly metadataConfidence: number;
  readonly topicFit: number;
  readonly recommendationStrength: number;
  readonly entityMetadata: EntityMetadata;
}

export type SourceNature = "primary" | "secondary" | "unknown";
export type Datedness = "dated" | "undated" | "stale";

/**
 * Grading produced by the critic/verifier worker. The critic is a second,
 * non-searching worker that only grades evidence cards produced by the crawl
 * workers (evaluator–optimizer split), so the synthesis never trusts raw worker
 * prose.
 */
export interface CriticVerdict {
  readonly cardId: string;
  readonly onTopic: boolean;
  readonly dated: Datedness;
  readonly sourceNature: SourceNature;
  /** Ids of ledger cards this card's claim conflicts with. */
  readonly contradicts: ReadonlyArray<string>;
  readonly claimStrength: ClaimStrength;
  /** PASS means the card may enter the synthesis ledger. */
  readonly pass: boolean;
  readonly note: string;
}

export interface GradedEvidenceCard extends EvidenceCard {
  readonly critic: CriticVerdict;
}

export interface CriticSummary {
  readonly graded: number;
  readonly failed: number;
  readonly callsUsed: number;
  readonly retryRoundSpawned: boolean;
  readonly retrySourcesAdded: number;
}

// ---------------------------------------------------------------------------
// Cross-run layered memory (src/memory/)
// ---------------------------------------------------------------------------

export type MemoryRanker = "embeddings" | "bm25";

/** Compact per-card view of the graded ledger stored in episodic memory. */
export interface LedgerSnapshotCard {
  readonly id: string;
  readonly claim: string;
  readonly verdict: "pass" | "fail";
  readonly contradiction: boolean;
}

/** Episodic layer — what happened on a past run. */
export interface RunSummary {
  readonly runId: string;
  readonly topic: string;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly depthPreset: string;
  readonly focusAreas: ReadonlyArray<string>;
  readonly timestamp: string;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly sourceCount: number;
  readonly engineHits: ReadonlyArray<{ readonly engine: string; readonly hits: number }>;
  readonly failedUrls: ReadonlyArray<string>;
  readonly failedHosts: ReadonlyArray<string>;
  readonly ledger: ReadonlyArray<LedgerSnapshotCard>;
  readonly llmCallsUsed: number;
  readonly criticCallsUsed: number;
  readonly runtimeSec: number;
  readonly usedAI: boolean;
}

/** Semantic layer — durable facts ("source X is consistently off-topic", ...). */
export interface SemanticFact {
  readonly factId: string;
  readonly kind: "offtopic_domain" | "preference" | "glossary" | "note";
  readonly text: string;
  readonly source: string;
  readonly score: number;
  readonly timestamp: string;
  readonly topic?: string;
}

/** Procedural layer — winning query mutations, skill files, plugin tools. */
export interface ProceduralMemory {
  readonly procedureId: string;
  readonly kind: "mutation" | "skill" | "plugin_tool";
  readonly label: string;
  readonly score: number;
  readonly topic?: string;
  readonly timestamp: string;
}

/** Persisted shape of the layered memory store. */
export interface MemoryLayers {
  readonly version: 1;
  readonly runs: ReadonlyArray<RunSummary>;
  readonly facts: ReadonlyArray<SemanticFact>;
  readonly procedures: ReadonlyArray<ProceduralMemory>;
}

/**
 * Retrieved prior-run context injected into a new run before decomposition.
 * Built by retrieveMemory() and consumed by the planner + swarm bootstrap.
 */
export interface MemoryContext {
  readonly runs: ReadonlyArray<RunSummary>;
  readonly facts: ReadonlyArray<SemanticFact>;
  readonly procedures: ReadonlyArray<ProceduralMemory>;
  readonly goodEngines: ReadonlyArray<string>;
  readonly failedUrls: ReadonlyArray<string>;
  readonly failedHosts: ReadonlyArray<string>;
  readonly ranker: MemoryRanker;
}

export interface CompiledReport {
  readonly markdown: string;
  readonly sources: ReadonlyArray<ReportSource>;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly coveredDims: ReadonlyArray<string>;
  readonly gapDims: ReadonlyArray<string>;
  readonly aiSynthesis?: string;
  readonly contradictions: ReadonlyArray<ContradictionEntry>;
  readonly isPartialRun?: boolean;
  readonly timeoutReason?: string;
  /** pass^k-lite: whether every citation index in the synthesis maps to a ledger card. */
  readonly citationPass?: boolean;
  /** pass^k-lite: whether a single synthesis retry was performed. */
  readonly retryUsed?: boolean;
  /** Number of contradiction entries surfaced in the report. */
  readonly contradictionCount?: number;
  /** Skill pack auto-selected from planner domain tags, e.g. "academic v1". */
  readonly skillUsed?: string;
  /**
   * Raw ` thinking` trace captured from the synthesis completion. Kept out of the
   * rendered narrative and surfaced only in the audit sidecar.
   */
  readonly reasoningTrace?: string;
}

/**
 * Result of the independent citation verifier. The LLM never invents URLs:
 * every `[n]` citation index in the synthesized markdown must map to a ledger
 * card, and any URL written in the synthesis must equal a card's canonical URL.
 */
export interface CitationCheckResult {
  readonly pass: boolean;
  readonly orphanIndices: ReadonlyArray<string>;
  readonly foreignUrls: ReadonlyArray<string>;
}

/** Skill pack loaded from the bundled pack dir or ~/.deep-swarm-research/skills. */
export interface SkillPack {
  readonly name: string;
  readonly version: string;
  readonly domainTags: ReadonlyArray<string>;
  readonly description: string;
  readonly content: string;
  readonly filePath: string;
  /** True when the file came from the user override dir (wins over bundled). */
  readonly userOverride: boolean;
}

/** A URL the swarm refused or failed to fetch, surfaced on the blackboard. */
export interface BlockedUrlEntry {
  readonly url: string;
  readonly reason: string;
  readonly count: number;
}

export type SourceTier =
  | "academic"
  | "government"
  | "reference"
  | "news"
  | "professional"
  | "general"
  | "low";

export interface ScoredCandidate {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly query: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly urlQuality: number;
  readonly totalScore: number;
  readonly tier: SourceTier;
  readonly discoveredBy?: string; 
}

export type WorkerRole =
  | "breadth"
  | "depth"
  | "recency"
  | "academic"
  | "critical"
  | "statistical"
  | "regulatory"
  | "technical"
  | "primary"
  | "comparative";

export interface DynamicWorkerSpec {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly budgetWeight: number;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
}

export interface SwarmTask {
  readonly id: string;
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly pageBudget: number;
  readonly contentLimit: number;
  readonly followLinks: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
  readonly searchResultsPerQuery: number;
  readonly maxPagesPerDomain: number;
  readonly maxLinksToEvaluate: number;
  readonly maxLinksToFollow: number;
  readonly candidatePoolMultiplier: number;
  readonly workerConcurrency: number;
  readonly minRelevanceScore: number;
  readonly maxOutlinksPerPage: number;
  readonly searchPages: number;
  readonly extraEngines: ReadonlyArray<string>;
  readonly linkCrawlDepth: number;
  readonly queryMutationThreshold: number;
  /** Content chunks to extract per source (see DepthProfile.extractPagesPerSource). */
  readonly extractPagesPerSource?: number;
  /** Chars per source fed to the AI evidence ledger. */
  readonly evidenceExcerptChars?: number;
  readonly enableLocalSources: boolean;
  readonly enableYouTube?: boolean;
  readonly localLibraryIds?: ReadonlyArray<string>;
  readonly roleLibraryMap?: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly timeRange?: "all" | "year" | "month" | "week" | "day";
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
  readonly decodoApiToken?: string;
  readonly flaresolverrUrl?: string;
  readonly searxngUrl?: string;
  readonly rssFeedUrls?: ReadonlyArray<string>;
  readonly telegramChannels?: ReadonlyArray<string>;
  /** When false, no persistent heuristic learning is recorded. Default: true. */
  readonly enableAdaptiveLearning?: boolean;
  /** Deterministic domain allow-list (hosts only; subdomains of a listed parent
   * count as allowed). Empty array = no allow restriction. */
  readonly allowedDomains?: ReadonlyArray<string>;
  /** Deterministic domain deny-list — always wins over the allow-list. */
  readonly blockedDomains?: ReadonlyArray<string>;
  /** Hard cap on accepted PDF bytes (0 or undefined = unbounded). */
  readonly maxPdfBytes?: number;
}


export interface WorkerResult {
  readonly taskId: string;
  readonly role: WorkerRole;
  readonly label: string;
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queries: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export interface CrawledSource {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
  readonly sourceQuery: string;
  readonly workerRole: WorkerRole;
  readonly workerLabel: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
  readonly origin: SourceOrigin;
  readonly discoveredBy?: string; // ADDED: Engine attribution
  readonly page?: number;
  readonly totalPages?: number;
}

export interface AgentMessage {
  readonly fromWorker: string;
  readonly keyFindings: ReadonlyArray<string>;
  readonly suggestedFollowUps: ReadonlyArray<string>;
}

export interface ContradictionEntry {
  readonly claim: string;
  readonly sourceA: {
    readonly index: number;
    readonly title: string;
    readonly stance: string;
  };
  readonly sourceB: {
    readonly index: number;
    readonly title: string;
    readonly stance: string;
  };
  readonly severity: "minor" | "moderate" | "major";
}

export interface ResearchDimension {
  readonly id: string;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly queries: (topic: string) => ReadonlyArray<string>;
}

export interface QueryPlan {
  readonly queriesByRole: Readonly<Record<WorkerRole, ReadonlyArray<string>>>;
  readonly usedAI: boolean;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly dynamicSpecs?: ReadonlyArray<DynamicWorkerSpec>;
  /** Structured plan (item 4) when the planner ran with structured output. */
  readonly researchPlan?: ResearchPlan;
  /** Domain classification tags used for skill-pack auto-selection (item 8). */
  readonly domainTags?: ReadonlyArray<string>;
  /**
   * Raw ` thinking` trace captured from the planner's reasoning-enabled call.
   * Mined for unresolved questions that seed an extra search round.
   */
  readonly plannerReasoning?: string;
}

/**
 * First-class structured research plan (item 4). Produced by the planner via
 * LM Studio structured output (JSON schema); every field is deterministic —
 * workers, open questions, stop conditions, the estimated time budget left,
 * and the citation policy ("index-only": citations are keys into the ledger,
 * the model never invents URLs).
 */
export interface ResearchPlan {
  readonly workers: ReadonlyArray<DynamicWorkerSpec>;
  readonly questions: ReadonlyArray<string>;
  readonly stopConditions: ReadonlyArray<string>;
  readonly estimatedRemainingMs: number;
  readonly citationPolicy: "index-only";
  readonly domainTags: ReadonlyArray<string>;
}

export interface AdaptiveGapPlan {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
}

export type SourceOrigin = "web" | "local";

export interface ReportSource {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly sourceQuery: string;
  readonly workerRole: WorkerRole;
  readonly workerLabel: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
  readonly origin: SourceOrigin;
  readonly page?: number;
  readonly totalPages?: number;
}


export interface ResearchConfig {
    readonly contextBudgetMode?: "auto" | "conservative" | "manual";
  readonly manualContextLimit?: number;
  readonly maxSynthesisInputTokens?: number;
  readonly topic: string;
  readonly focusAreas: ReadonlyArray<string>;
  readonly depthPreset: import("./constants").DepthPreset;
  /**
   * Controls `contentLimitPerPage`. "auto" scales the per-page character budget
   * with the depth preset; "manual" uses `contentLimitPerPage` verbatim.
   */
  readonly contentLimitMode?: "auto" | "manual";
  readonly contentLimitPerPage: number;
  /**
   * Optional override for results fetched per query. Omit or 0 to use the depth preset.
   */
  readonly searchResultsPerQuery?: number;
  /**
   * Optional override for chars per source fed into AI synthesis. Omit or 0 to use the preset.
   */
  readonly evidenceExcerptChars?: number;
  readonly contextIsolation?: ContextIsolationMode;
  readonly llmCallMode?: "compact" | "standard" | "deep" | "extended";
  readonly enableLinkFollowing: boolean;
  readonly enableAIPlanning: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";

  /**
   * Enables indexed local RAG libraries as research evidence.
   */
  readonly enableLocalSources: boolean;

  /**
   * Optional allow-list of RAG library UUIDs.
   * When omitted, role-based routing or progressive retrieval is used.
   */
  readonly localLibraryIds?: ReadonlyArray<string>;

  /**
   * Optional worker-role-to-library-ID routing map.
   * Example: { academic: ["uuid"], technical: ["uuid"] }.
   */
  readonly roleLibraryMap?: ReadonlyMap<string, ReadonlyArray<string>>;

  /**
   * Maximum session duration in milliseconds.
   * Omit or set to 0 for no explicit orchestrator time limit.
   */
  readonly maxSessionMs?: number;

  readonly timeRange?: "all" | "year" | "month" | "week" | "day";

  readonly engineSelectionMode?: "adaptive" | "benchmark" | "priority";
  readonly cacheDuration?: string;
  readonly flaresolverrUrl?: string;

  /**
   * Local SearXNG instance base URL tried before the public instance.
   * Blank/undefined = public instance only.
   */
  readonly searxngUrl?: string;
  readonly crossrefMailto?: string;
  readonly enableYouTube?: boolean;
  readonly enableAcademicAPIs?: boolean;
  readonly enableReferenceSearch?: boolean;
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
  readonly decodoApiToken?: string;
  readonly rssFeedUrls?: ReadonlyArray<string>;
  readonly telegramChannels?: ReadonlyArray<string>;

  /**
   * Comma-separated identifiers of other enabled LM Studio plugins whose tools
   * may be invoked (e.g. "lmstudio/rag-v1"). Empty disables cross-plugin tools.
   */
  readonly externalPluginTools?: ReadonlyArray<string>;

  /**
   * Persistent heuristic learning (engine priority stats, mutation stats,
   * domain adjustments, LLM hints). Default: on.
   */
  readonly enableAdaptiveLearning?: boolean;

  /**
   * Cross-run layered memory (~/.deep-swarm-research/memory/run-memory.json):
   * episodic run summaries, derived semantic facts, and procedural winners are
   * written at the end of every run and recalled before decomposition on the
   * next run. Default: on.
   */
  readonly enableRunMemory?: boolean;

  /** Max number of episodic run summaries retained. Default: preset cap (6). */
  readonly memoryRetainRuns?: number;

  /**
   * Deterministic guardrails (item 7). Optional allow/deny domain lists applied
   * to every candidate, page fetch, and outlink evaluation.
   */
  readonly allowedDomains?: ReadonlyArray<string>;
  readonly blockedDomains?: ReadonlyArray<string>;
  /** Hard cap on PDF bytes accepted for extraction (0 = no explicit cap). */
  readonly maxPdfBytes?: number;
  /** Hard cap on cross-plugin `Use Plugin Tool` invocations per run. */
  readonly maxExternalToolCalls?: number;
  /**
   * When true, write-capable operations (RAG Add/Remove/Save/Load, external
   * plugin tools) require an explicit `confirmed: true` argument — the model
   * must obtain user consent in the conversation before any write happens.
   */
  readonly requireApprovalForWrites?: boolean;
  /** Max simultaneous in-flight LLM predictions (0 = default of 1). */
  readonly llmConcurrency?: number;
  /**
   * When true (default), append a collapsible "Swarm Reasoning & Verification
   * Trace" section to the final report.
   */
  readonly includeReasoningAudit?: boolean;
}

export interface ResearchResult {
  readonly report: CompiledReport;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly totalSources: number;
  readonly totalRounds: number;
  /** Machine-readable audit record (reasoning traces) for the run. */
  readonly metadata?: IResearchRunRecord;
}

/**
 * Reasoning traces preserved from a run's reasoning-enabled LLM calls. These are
 * the auditable "why" behind the plan and the synthesis, kept out of the report
 * narrative itself.
 */
export interface ReasoningTrace {
  /** Reasoning surfaced by the planner before crawling. */
  readonly planner?: string;
  /** Reasoning surfaced by the synthesis stage. */
  readonly synthesis?: string;
  /** Unresolved questions mined from the planner trace and searched in Round 2. */
  readonly minedQueries?: ReadonlyArray<string>;
}

/** Audit ledger metadata object attached to a completed research run. */
export interface IResearchRunRecord {
  readonly runId: string;
  readonly topic: string;
  readonly timestamp: string;
  readonly reasoningTrace?: ReasoningTrace;
}

export interface ContextBudget {
  readonly mode: "auto" | "conservative" | "manual";
  readonly modelContextLimit: number;
  readonly outputReserve: number;
  readonly safetyMargin: number;
  readonly maxSynthesisInput: number;
}
export type ContextIsolationMode = "strict" | "worker_reuse" | "advanced_reuse";

export interface LlmCallBudget {
  readonly mode: "compact" | "standard" | "deep" | "extended";
  readonly maxGlobalCalls: number;
  readonly maxCallsPerWorker: number;
  readonly maxRuntimeMs: number;
  readonly warningThresholdMs: number;
}

export interface RunWatchdog {
  llmCallsMade: number;
  workerCalls: Map<string, number>;
  startTime: number;
  stalled: boolean;
  lastProgressTime: number;
}

export type StatusFn = (message: string) => void;
export type WarnFn = (message: string) => void;