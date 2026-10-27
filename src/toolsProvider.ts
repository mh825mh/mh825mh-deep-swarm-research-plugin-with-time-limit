import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { multiEngineSearch, type SearchEngine } from "./net/search-engines";
import { DdgRateLimiter } from "./net/ddg";
import { scoreCandidate, rankCandidates } from "./scoring/authority";
import { fetchPage } from "./net/http";
import { extractPage } from "./net/extractor";
import { extractPdf } from "./net/pdf-extractor";
import {
  isYouTubeUrl,
  extractYouTubeTranscript,
  buildYouTubePage,
} from "./net/youtube-extractor";
import {
  getGlobalStore,
  saveGlobalStoreIndex,
  type LibraryPriority,
  type LibraryTag,
} from "./local/store";
import { readSkillFile } from "./skills/loader";
import {
  SEARCH_RESULTS_MIN,
  SEARCH_RESULTS_MAX,
  CONTENT_LIMIT_MIN,
  CONTENT_LIMIT_EXTENDED,
  MULTI_READ_BATCH_DELAY_MS,
} from "./constants";
import { sleep } from "./net/http";
import { runDeepResearch } from "./researcher";
import { loadUserKeys, keysFilePath } from "./config/keys";
import { configSchematics, globalConfigSchematics } from "./config";
import { setDecodoToken } from "./net/decodoApi";

// Local type definition to satisfy `satisfies` keyword without breaking compilation
type ToolCallResult = { error: boolean; output: string };
type PdfImage = any;

// Ceiling for the raw transcript fetch. A long podcast runs to 100k+ chars;
// we fetch enough for several contentLimit-sized pages and let buildYouTubePage
// slice the rest.
const YT_MAX_TRANSCRIPT_CHARS = CONTENT_LIMIT_EXTENDED * 10;

// Local helper functions for missing exports
function isPdfContentType(ct: string | undefined): boolean {
  return !!ct && ct.toLowerCase().includes("application/pdf");
}
function isPdfUrl(url: string): boolean {
  return /\.pdf(\?|$)/i.test(url);
}

function readConfig(ctl: any) {
  const fallback = {
    researchDepth: "standard",
    contentLimitMode: "auto" as "auto" | "manual",
    contentLimitPerPage: 4000,
    searchResultsPerQuery: 0,
    evidenceExcerptChars: 0,
    enableAdaptiveLearning: true,
    enableLinkFollowing: true,
    enableAIPlanning: true,
    safeSearch: "off",
    timeRange: "all",
    engineSelectionMode: "adaptive",
    maxSessionMinutes: 30,
    enableAcademicAPIs: false,
	enableYouTube: false,
    enableReferenceSearch: true,
    enableLocalSources: false,                // NEW
    serperApiKey: undefined as string | undefined,
    braveApiKey: undefined as string | undefined,
    decodoApiToken: undefined as string | undefined,
    cacheDuration: "30",
    contextBudgetMode: "auto",
    manualContextLimit: 8192,
    maxSynthesisInputTokens: 18000,
    contextIsolation: "strict",
    llmCallMode: "standard",
    flaresolverrUrl: "",
    searxngUrl: "",
    crossrefMailto: "",
    rssFeedUrls: [] as string[],
    telegramChannels: [] as string[],
    externalPluginTools: [] as string[],
    allowedDomains: [] as string[],
    blockedDomains: [] as string[],
    maxPdfBytes: 0,
    maxExternalToolCalls: 0,
    requireApprovalForWrites: false,
    llmConcurrency: 1,
    includeReasoningAudit: true,
      };

  const tryGet = (p: any, key: string): unknown => {
    try {
      return p?.get?.(key);
    } catch {
      // Key not present in this schematics (e.g. a field moved to global or
      // intentionally removed from the per-chat UI). Treat as unset.
      return undefined;
    }
  };

  try {
    // Read per-chat config via the official SDK accessor. Older/alternate runtime
    // objects may expose `ctl.config`; fall back gracefully to either.
    let raw: Record<string, unknown> = {};
    try {
      const parsed = ctl?.getPluginConfig?.(configSchematics);
      if (parsed) {
        raw = {
          researchDepth: tryGet(parsed, "researchDepth"),
          contentLimitMode: tryGet(parsed, "contentLimitMode"),
          contentLimitPerPage: tryGet(parsed, "contentLimitPerPage"),
          searchResultsPerQuery: tryGet(parsed, "searchResultsPerQuery"),
          evidenceExcerptChars: tryGet(parsed, "evidenceExcerptChars"),
          enableAdaptiveLearning: tryGet(parsed, "enableAdaptiveLearning"),
          enableLinkFollowing: tryGet(parsed, "enableLinkFollowing"),
          enableAIPlanning: tryGet(parsed, "enableAIPlanning"),
          safeSearch: tryGet(parsed, "safeSearch"),
          timeRange: tryGet(parsed, "timeRange"),
          engineSelectionMode: tryGet(parsed, "engineSelectionMode"),
          maxSessionMinutes: tryGet(parsed, "maxSessionMinutes"),
          enableAcademicAPIs: tryGet(parsed, "enableAcademicAPIs"),
          enableYouTube: tryGet(parsed, "enableYouTube"),
          enableReferenceSearch: tryGet(parsed, "enableReferenceSearch"),
          enableLocalSources: tryGet(parsed, "enableLocalSources"),
          cacheDuration: tryGet(parsed, "cacheDuration"),
          contextBudgetMode: tryGet(parsed, "contextBudgetMode"),
          manualContextLimit: tryGet(parsed, "manualContextLimit"),
          maxSynthesisInputTokens: tryGet(parsed, "maxSynthesisInputTokens"),
          contextIsolation: tryGet(parsed, "contextIsolation"),
          llmCallMode: tryGet(parsed, "llmCallMode"),
          decodoApiToken: tryGet(parsed, "decodoApiToken"),
          flaresolverrUrl: tryGet(parsed, "flaresolverrUrl"),
          allowedDomains: tryGet(parsed, "allowedDomains"),
          blockedDomains: tryGet(parsed, "blockedDomains"),
          maxPdfBytes: tryGet(parsed, "maxPdfBytes"),
          maxExternalToolCalls: tryGet(parsed, "maxExternalToolCalls"),
          requireApprovalForWrites: tryGet(parsed, "requireApprovalForWrites"),
          llmConcurrency: tryGet(parsed, "llmConcurrency"),
          includeReasoningAudit: tryGet(parsed, "includeReasoningAudit"),
        };
      }
    } catch {
      raw = {};
    }

    // Secrets / machine-local infra live in the application-wide global config.
    // Fall back to any legacy per-chat value so tokens are not lost on upgrade.
    let globalRaw: Record<string, unknown> = {};
    try {
      const gParsed = ctl?.getGlobalPluginConfig?.(globalConfigSchematics);
      if (gParsed) {
        globalRaw = {
          decodoApiToken: tryGet(gParsed, "decodoApiToken"),
          flaresolverrUrl: tryGet(gParsed, "flaresolverrUrl"),
          searxngUrl: tryGet(gParsed, "searxngUrl"),
        };
      }
    } catch {
      globalRaw = {};
    }

    const cfg = { ...raw, ...(ctl?.config ?? {}) };

    const on = (v: unknown, def: boolean) =>
      v === "on" || v === true ? true :
      v === "off" || v === false ? false : def;

    const list = (v: unknown): string[] => {
      if (Array.isArray(v)) {
        return v.map(String).map((s) => s.trim()).filter(Boolean);
      }
      if (typeof v === "string" && v.trim()) {
        return v.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return [];
    };

    const fileKeys = loadUserKeys();

    const serperKey =
      (typeof cfg.serperApiKey === "string" && cfg.serperApiKey.trim()) ||
      process.env.SERPER_API_KEY?.trim() ||
      fileKeys.serperApiKey ||
      undefined;

    const braveKey =
      (typeof cfg.braveApiKey === "string" && cfg.braveApiKey.trim()) ||
      process.env.BRAVE_API_KEY?.trim() ||
      fileKeys.braveApiKey ||
      undefined;

    const decodoToken =
      (typeof globalRaw.decodoApiToken === "string" && globalRaw.decodoApiToken.trim()) ||
      (typeof cfg.decodoApiToken === "string" && cfg.decodoApiToken.trim()) ||
      process.env.DECODO_API_TOKEN?.trim() ||
      fileKeys.decodoApiToken ||
      undefined;

    
    // NEW: read the Local Document Sources select field
    const enableLocalSourcesSelect =
      typeof cfg.enableLocalSources === "string"
        ? cfg.enableLocalSources
        : "off";

    return {
      researchDepth: cfg.researchDepth ?? fallback.researchDepth,
      contentLimitMode:
        cfg.contentLimitMode === "manual" ? "manual" : "auto",
      contentLimitPerPage: Number(
        cfg.contentLimitPerPage ?? fallback.contentLimitPerPage,
      ),
      searchResultsPerQuery: Number(
        cfg.searchResultsPerQuery ?? fallback.searchResultsPerQuery,
      ),
      evidenceExcerptChars: Number(
        cfg.evidenceExcerptChars ?? fallback.evidenceExcerptChars,
      ),
      enableAdaptiveLearning: on(
        cfg.enableAdaptiveLearning,
        fallback.enableAdaptiveLearning,
      ),
      enableLinkFollowing: on(cfg.enableLinkFollowing, fallback.enableLinkFollowing),
      enableAIPlanning: on(cfg.enableAIPlanning, fallback.enableAIPlanning),
      safeSearch: cfg.safeSearch ?? fallback.safeSearch,
      timeRange: cfg.timeRange ?? fallback.timeRange,
      engineSelectionMode: cfg.engineSelectionMode ?? fallback.engineSelectionMode,
      maxSessionMinutes: Number(
        cfg.maxSessionMinutes ?? fallback.maxSessionMinutes,
      ),
      enableAcademicAPIs: on(cfg.enableAcademicAPIs, fallback.enableAcademicAPIs),
	  enableYouTube: on(cfg.enableYouTube, fallback.enableYouTube), 
      enableReferenceSearch: on(cfg.enableReferenceSearch, fallback.enableReferenceSearch),
      
      // NEW: any non-"off" value turns local sources on
      enableLocalSources: enableLocalSourcesSelect !== "off",

      serperApiKey: serperKey,
      braveApiKey: braveKey,
      decodoApiToken: decodoToken,

      externalPluginTools: list(cfg.externalPluginTools),

      cacheDuration: typeof cfg.cacheDuration === "string" && cfg.cacheDuration.trim()
        ? cfg.cacheDuration
        : fallback.cacheDuration,

      contextBudgetMode:
        cfg.contextBudgetMode === "conservative" || cfg.contextBudgetMode === "manual"
          ? cfg.contextBudgetMode
          : fallback.contextBudgetMode,

      manualContextLimit: Number(
        cfg.manualContextLimit ?? fallback.manualContextLimit,
      ),

      maxSynthesisInputTokens: Number(
        cfg.maxSynthesisInputTokens ?? fallback.maxSynthesisInputTokens,
      ),

      contextIsolation:
        cfg.contextIsolation === "worker_reuse" || cfg.contextIsolation === "advanced_reuse"
          ? cfg.contextIsolation
          : fallback.contextIsolation,

      llmCallMode:
        cfg.llmCallMode === "compact" || cfg.llmCallMode === "deep" || cfg.llmCallMode === "extended"
          ? cfg.llmCallMode
          : fallback.llmCallMode,

      flaresolverrUrl:
        typeof globalRaw.flaresolverrUrl === "string" && globalRaw.flaresolverrUrl.trim()
          ? globalRaw.flaresolverrUrl.trim()
          : typeof cfg.flaresolverrUrl === "string" && cfg.flaresolverrUrl.trim()
            ? cfg.flaresolverrUrl.trim()
            : "",

      searxngUrl:
        typeof globalRaw.searxngUrl === "string" && globalRaw.searxngUrl.trim()
          ? globalRaw.searxngUrl.trim()
          : typeof cfg.searxngUrl === "string" && cfg.searxngUrl.trim()
            ? cfg.searxngUrl.trim()
            : "",

      crossrefMailto: fileKeys.crossrefMailto || "",

      rssFeedUrls: list(cfg.rssFeedUrls).length > 0 ? list(cfg.rssFeedUrls) : fileKeys.rssFeedUrls || [],
      telegramChannels: list(cfg.telegramChannels).length > 0 ? list(cfg.telegramChannels) : fileKeys.telegramChannels || [],

      allowedDomains: list(cfg.allowedDomains),
      blockedDomains: list(cfg.blockedDomains),
      maxPdfBytes: Math.max(0, Number(cfg.maxPdfBytes ?? fallback.maxPdfBytes)),
      maxExternalToolCalls: Math.max(0, Number(cfg.maxExternalToolCalls ?? fallback.maxExternalToolCalls)),
      requireApprovalForWrites: on(cfg.requireApprovalForWrites, fallback.requireApprovalForWrites),
      llmConcurrency: Math.max(1, Math.min(8, Number(cfg.llmConcurrency ?? fallback.llmConcurrency))),
      includeReasoningAudit: on(cfg.includeReasoningAudit, fallback.includeReasoningAudit),
    };
  } catch {
    return fallback;
  }
}

// item 7: per-run guardrails — human-approval gate for write-capable operations
// and a hard cap on cross-plugin tool invocations. Reset each research run.
type RunGuardrails = {
  requireApprovalForWrites: boolean;
  maxExternalToolCalls: number;
  externalToolCallsUsed: number;
};

let runGuardrails: RunGuardrails = {
  requireApprovalForWrites: false,
  maxExternalToolCalls: 0,
  externalToolCallsUsed: 0,
};

function resetRunGuardrails(ui: ReturnType<typeof readConfig>) {
  runGuardrails = {
    requireApprovalForWrites: ui.requireApprovalForWrites,
    maxExternalToolCalls: ui.maxExternalToolCalls,
    externalToolCallsUsed: 0,
  };
}

/** Returns an error message when the write is blocked, else null. */
function checkWriteApproval(confirmed: unknown): string | null {
  if (!runGuardrails.requireApprovalForWrites) return null;
  if (confirmed === true) return null;
  return (
    "Write operation blocked: 'Require Approval Before Writes' is enabled. " +
    "Ask the user for explicit consent, then re-call this tool with confirmed: true."
  );
}

const WRITE_GATE_CONFIRMED_PARAM = z
  .boolean()
  .optional()
  .describe(
    "Set to true only after the user has explicitly approved this write. " +
      "Required when 'Require Approval Before Writes' is enabled.",
  );

function defaultSearchEngines(cfg: ReturnType<typeof readConfig>): SearchEngine[] {
  const engines: SearchEngine[] = ["ddg", "bing", "reference"];
  if (cfg.enableAcademicAPIs) engines.push("openalex", "crossref", "arxiv");
  if (cfg.enableYouTube) engines.push("youtube");
  if (cfg.rssFeedUrls.length > 0) engines.push("rss");
  if (cfg.telegramChannels.length > 0) engines.push("telegram");
  if (cfg.serperApiKey) engines.push("serper");
  if (cfg.braveApiKey) engines.push("brave-api");
  return engines;
}

export async function toolsProvider(ctl: any) {
  const deepResearchTool = tool({
    name: "DeepResearch",
    description: "Runs a deep research swarm on the given topic.",
    parameters: {
      topic: z.string().describe("The research topic."),
      focusAreas: z
        .array(z.string())
        .optional()
        .describe("Specific areas to focus on."),
      depth: z
        .string()
        .optional()
        .describe("Research depth (e.g., shallow, standard, deep)."),
      contentLimit: z
        .number()
        .optional()
        .describe("Content limit per page (overrides the UI setting)."),
      maxResultsPerQuery: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Results requested from each search engine per query (overrides UI setting).",
        ),
      sessionTimeoutMinutes: z
        .number()
        .optional()
        .describe("Session timeout in minutes."),

      enableLocalSources: z
        .boolean()
        .optional()
        .describe(
          "Include indexed local RAG libraries in the research swarm. " +
            "Default: false. Local chunks are blended with web sources and marked as local.",
        ),

      localLibraryIds: z
        .array(z.string().uuid())
        .max(20)
        .optional()
        .describe(
          "Optional RAG library IDs to search. Omit to use role-based routing " +
            "and progressive priority retrieval across all indexed libraries.",
        ),
    },

    implementation: async (
      args: any,
      { status, warn, signal },
    ): Promise<ToolCallResult> => {
      try {
        const ui = readConfig(ctl);
        resetRunGuardrails(ui);
const result = await runDeepResearch(
  {
    topic: args.topic,
    focusAreas: args.focusAreas ?? [],
    depthPreset: args.depth ?? ui.researchDepth,
    contentLimitMode: ui.contentLimitMode as "auto" | "manual",
    contentLimitPerPage:
      args.contentLimit ?? ui.contentLimitPerPage,
    searchResultsPerQuery:
      typeof args.maxResultsPerQuery === "number"
        ? args.maxResultsPerQuery
        : ui.searchResultsPerQuery,
    evidenceExcerptChars: ui.evidenceExcerptChars,
    enableAdaptiveLearning: ui.enableAdaptiveLearning,
    externalPluginTools: ui.externalPluginTools,
    enableLinkFollowing: ui.enableLinkFollowing,
    enableAIPlanning: ui.enableAIPlanning,
    safeSearch: ui.safeSearch,
    timeRange: ui.timeRange,
    engineSelectionMode: ui.engineSelectionMode,
	enableYouTube: ui.enableYouTube,
    enableAcademicAPIs: ui.enableAcademicAPIs,
    enableReferenceSearch: ui.enableReferenceSearch,
    serperApiKey: ui.serperApiKey,
    braveApiKey: ui.braveApiKey,
    decodoApiToken: ui.decodoApiToken,
    cacheDuration: ui.cacheDuration,
    contextBudgetMode: ui.contextBudgetMode,
    manualContextLimit: ui.manualContextLimit,
    maxSynthesisInputTokens: ui.maxSynthesisInputTokens,
    contextIsolation: ui.contextIsolation,
    llmCallMode: ui.llmCallMode,
    flaresolverrUrl: ui.flaresolverrUrl,
    searxngUrl: ui.searxngUrl,
    crossrefMailto: ui.crossrefMailto,
    rssFeedUrls: ui.rssFeedUrls,
    telegramChannels: ui.telegramChannels,

    maxSessionMs:
      typeof args.sessionTimeoutMinutes === "number"
        ? args.sessionTimeoutMinutes * 60_000
        : ui.maxSessionMinutes * 60_000,

    // ONLY these two lines changed:
    enableLocalSources: args.enableLocalSources ?? ui.enableLocalSources,
    localLibraryIds: args.localLibraryIds,

    allowedDomains: ui.allowedDomains,
    blockedDomains: ui.blockedDomains,
    maxPdfBytes: ui.maxPdfBytes,
    llmConcurrency: ui.llmConcurrency,
    includeReasoningAudit: ui.includeReasoningAudit,
  },
  status,
  warn,
  signal,
);

        if (
          !result ||
          result.totalSources === 0 ||
          !result.report ||
          result.report.markdown.trim() === ""
        ) {
          return {
            error: true,
            output:
              "Research completed but found no usable sources. Search engines may have blocked requests, and no relevant local sources were available.",
          } satisfies ToolCallResult;
        }

        return {
          error: false,
          output: result.report.markdown,
        } satisfies ToolCallResult;
      } catch (err: unknown) {
        return {
          error: true,
          output: `Research failed with error: ${
            err instanceof Error ? err.message : String(err)
          }. Please inform the user.`,
        } satisfies ToolCallResult;
      }
    },
  });

  // ... rest of toolsProvider continues here

const researchSearchTool = tool({
  name: "Search",
  description:
    "Search the web and return scored, ranked results with domain authority tiers. " +
    "Each result includes a domain score (0-100), source tier (academic/government/news/etc.), " +
    "URL quality score, and freshness estimate. Results are ranked by combined quality. " +
    "By default queries several engines in parallel (DuckDuckGo, Bing, reference sites, plus " +
    "academic APIs and YouTube when enabled in settings) and merges/deduplicates the hits. " +
    "Use this for focused lookups. For full research, use 'Research'." +
    "Don't use this for searching local files.",
  parameters: {
    query: z
      .string()
      .min(2)
      .describe("Search query - use natural language as you would type into a search engine."),
    maxResults: z
      .number()
      .int()
      .min(SEARCH_RESULTS_MIN)
      .max(SEARCH_RESULTS_MAX)
      .optional()
      .describe("Max results to return (default: 8)."),
    engines: z
      .array(
        z.enum([
          "ddg",
          "bing",
          "brave",
          "reference",
          "academic",
          "youtube",
          "serper",
          "brave-api",
        ]),
      )
      .optional()
      .describe(
        "Optional engine set to use. 'academic' expands to OpenAlex + Crossref + arXiv. " +
        "Defaults to the configured engines (ddg, bing, reference, +academic APIs when enabled, +youtube when enabled).",
      ),
    timeRange: z
      .enum(["all", "day", "week", "month", "year"])
      .optional()
      .describe("Recency filter passed to engines that support it (default: configured value)."),
  },

  implementation: async (
    { query, maxResults, engines, timeRange },
    { status, warn, signal },
  ) => {
    const cfg = readConfig(ctl);
    setDecodoToken(cfg.decodoApiToken);
    const max = maxResults ?? 8;
    const expand = (list: ReadonlyArray<string>): SearchEngine[] =>
      list.flatMap((e): SearchEngine[] =>
        e === "academic" ? ["openalex", "crossref", "arxiv"] : [e as SearchEngine],
      );
    const requested = engines && engines.length > 0 ? expand(engines) : defaultSearchEngines(cfg);
    const usable = requested.filter((e) => {
      if (e === "serper") return !!cfg.serperApiKey;
      if (e === "brave-api") return !!cfg.braveApiKey;
      return true;
    });
    const engineSet = usable.length > 0 ? usable : (["ddg"] as SearchEngine[]);
    const effectiveTimeRange = timeRange ?? cfg.timeRange ?? "all";

    status(`Searching "${query}" via ${engineSet.join(", ")}`);

    try {
      const hits = await multiEngineSearch(
        query,
        max * Math.max(1, engineSet.length),
        engineSet,
        signal,
        () => new DdgRateLimiter(10000),
        effectiveTimeRange,
        {
          serperApiKey: cfg.serperApiKey,
          braveApiKey: cfg.braveApiKey,
          rssFeedUrls: cfg.rssFeedUrls,
          telegramChannels: cfg.telegramChannels,
        },
      );

      if (hits.length === 0) {
        return "Search failed: 0 results found. All search engines are currently blocking requests (CAPTCHA).";
      }

      const scored = hits.map((h: any) => scoreCandidate(h, query));
      const ranked = rankCandidates(scored, max);

      status(`Found ${ranked.length} ranked results.`);

      return ranked.map((c: any, i: number) => ({
        rank: i + 1,
        url: c.url,
        title: c.title,
        snippet: c.snippet,
        domainScore: c.domainScore,
        freshnessScore: c.freshnessScore,
        urlQuality: c.urlQuality,
        totalScore: c.totalScore,
        tier: c.tier,
      }));
    } catch (err: unknown) {
      if (isAbortError(err) || signal.aborted) return "Search cancelled.";
      const msg = errorMessage(err);
      warn(`Search error: ${msg}`);
      return `Error during search: ${msg}`;
    }
  },
});

  
  const researchReadPageTool = tool({
    name: "Read Page",
    description:
      "Visit a website URL and return cleanly extracted text using Mozilla Readability " +
      "(the same engine as Firefox Reader Mode). " +
      "Automatically detects PDF URLs (arXiv, Springer, IEEE, etc.) and extracts " +
      "text content and embedded images from the PDF instead of returning garbled bytes. " +
      "Also returns: title, description, detected publication date, word count, " +
      "domain authority score, source tier, and top outbound links. " +
      "For PDFs, embedded images are saved to temp files and returned as file paths " +
      "with dimensions and size metadata (not inline base64). " +
      "Use this to read individual pages. For reading multiple URLs at once use 'Multi-Read'." +
      "with dimensions and size metadata (not inline base64). " +
      "YouTube URLs (youtu.be, /watch, /shorts, /embed) are resolved to the " +
      "video's transcript instead of the bot-blocked watch page. Transcripts are " +
      "chunked: while 'totalPages' exceeds 'page', call again with the next page " +
      "number to read the rest of the video before summarizing it. " +
      "Don't use this for reading local files.",
    parameters: {
      url: z.string().url().describe("The URL to visit and read."),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The page number to read (starting from 1). Use this to read long documents " +
          "in chunks. If the returned 'totalPages' is greater than 'page', you can " +
          "call this tool again with the next page number to continue reading.",
        ),
      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract from the page " +
          "(default: plugin content-per-page setting).",
        ),
    },

    implementation: async ({ url, page: pageNum = 1, contentLimit }, { status, warn, signal }) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;

      status(`Reading: ${url} (page ${pageNum})`);

      try {
        // YouTube watch pages bot-block the generic fetcher, so transcripts are
        // pulled via the innerTube API instead. Never let this path report the
        // misleading "blocked and all archives failed" error.
        if (isYouTubeUrl(url)) {
          status(`YouTube URL - fetching transcript (page ${pageNum})...`);
          const ytData = await extractYouTubeTranscript(
            url,
            signal,
            YT_MAX_TRANSCRIPT_CHARS,
          );
          if (ytData) {
            const ytPage = buildYouTubePage(url, ytData, limit, pageNum);
            const ytScored = scoreCandidate(
              { url, title: ytPage.title, snippet: ytPage.description },
              "",
            );

            const ytTotalPages = ytPage.totalPages ?? 1;
            status(
              ytTotalPages > pageNum
                ? `Transcript read (${pageNum}/${ytTotalPages}). Call again with page=${pageNum + 1} to continue.`
                : "Transcript read successfully.",
            );

            return {
              url: ytPage.finalUrl,
              title: ytPage.title,
              description: ytPage.description,
              published: ytPage.published,
              wordCount: ytPage.wordCount,
              domainScore: ytScored.domainScore,
              tier: ytScored.tier,
              content: ytPage.text,
              page: ytPage.page,
              totalPages: ytPage.totalPages,
              topLinks: [],
              sourceType: "youtube-transcript",
            };
          }
          warn(`YouTube transcript unavailable for ${url}; falling back to page fetch.`);
        }

        const fetchResult = await fetchPage(url, signal);
        const { finalUrl } = fetchResult;

        const isPdf =
          (fetchResult.rawBuffer &&
            isPdfContentType(fetchResult.contentType)) ||
          (!fetchResult.rawBuffer && isPdfUrl(url));

        let page: ReturnType<typeof extractPage> & {
          images?: ReadonlyArray<PdfImage>;
        };
        let images: ReadonlyArray<PdfImage> = [];

        if (isPdf && fetchResult.rawBuffer) {
          status(`Found PDF - extracting contents (page ${pageNum})`);
          const pdfResult = await extractPdf(
            fetchResult.rawBuffer,
            url,
            finalUrl,
            limit,
            true,
            20,
            pageNum,
          );
          page = pdfResult;
          images = pdfResult.images;
        } else if (
          isPdf &&
          fetchResult.html &&
          fetchResult.html.startsWith("%PDF")
        ) {
          status(`Found PDF - extracting contents (page ${pageNum})`);
          const buf = Buffer.from(fetchResult.html, "binary");
          const pdfResult = await extractPdf(
            buf,
            url,
            finalUrl,
            limit,
            true,
            20,
            pageNum,
          );
          page = pdfResult;
          images = pdfResult.images;
        } else {
          page = extractPage(fetchResult.html, url, finalUrl, limit, undefined, pageNum);
        }

        const scored = scoreCandidate(
          { url, title: page.title, snippet: page.description },
          "",
        );

        status(
          images.length > 0
            ? `Page read successfully. Extracted ${images.length} image(s).`
            : "Page read successfully.",
        );

        const result: Record<string, unknown> = {
          url: page.finalUrl,
          title: page.title,
          description: page.description,
          published: page.published,
          wordCount: page.wordCount,
          domainScore: scored.domainScore,
          tier: scored.tier,
          content: page.text,
          page: page.page,
          totalPages: page.totalPages,
          topLinks: page.outlinks.slice(0, 10).map((l: any) => ({
            text: l.text,
            href: l.href,
          })),
        };

        if (images.length > 0) {
          result.images = images.map((img: any, idx: number) => ({
            index: idx + 1,
            page: img.page,
            format: img.format,
            width: img.width,
            height: img.height,
            sizeKB: Math.round(img.byteSize / 1024),
            filePath: img.filePath,
          }));
          result.imageCount = images.length;

          const imageNote = images
            .map(
              (img: any, idx: number) =>
                `[Image ${idx + 1} on page ${img.page}: ${img.width}x${img.height}, ${Math.round(img.byteSize / 1024)} KB - saved to ${img.filePath}]`,
            )
            .join("\n");
          result.content =
            (result.content as string) +
            "\n\n--- Extracted Images ---\n" +
            imageNote;
        }

        return result;
      } catch (err: unknown) {
        if (isAbortError(err) || signal.aborted) return "Page read cancelled.";
        const msg = errorMessage(err);
        warn(`Read error: ${msg}`);
        return `Error reading page: ${msg}`;
      }
    },
  });

  const researchMultiReadTool = tool({
    name: "Multi-Read",
    description:
      "Fetch up to 10 URLs concurrently (3 at a time) and return extracted text " +
      "and metadata for all of them. Automatically handles PDF URLs - extracts " +
      "clean text instead of returning garbled binary data. Returns domain authority " +
      "score, publication date, and word count per page. " +
      "YouTube URLs are resolved to their transcript rather than the watch page. " +
      "Use this when you already have a list of URLs and want to read them all " +
      "at once without running a full research session.",
    parameters: {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(10)
        .describe("List of URLs to read (1-10)."),
      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract per page " +
          "(default: plugin content-per-page setting).",
        ),
    },

    implementation: async (
      { urls, contentLimit },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;

      status(`Reading ${urls.length} page(s) - 3 at a time...`);

      const CONCURRENCY = 3;
      const results: Array<{
        index: number;
        url: string;
        title: string;
        published: string | null;
        wordCount: number;
        domainScore: number;
        tier: string;
        content: string;
        error: string | null;
      }> = [];

      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        if (signal.aborted) break;

        const batch = urls.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (url: any, bi: number) => {
            if (isYouTubeUrl(url)) {
              const ytData = await extractYouTubeTranscript(
                url,
                signal,
                YT_MAX_TRANSCRIPT_CHARS,
              );
              if (ytData) {
                const ytPage = buildYouTubePage(url, ytData, limit, 1);
                const ytScored = scoreCandidate(
                  { url, title: ytPage.title, snippet: ytPage.description },
                  "",
                );
                return {
                  index: i + bi + 1,
                  url: ytPage.finalUrl,
                  title: ytPage.title,
                  published: ytPage.published,
                  wordCount: ytPage.wordCount,
                  domainScore: ytScored.domainScore,
                  tier: ytScored.tier,
                  content: ytPage.text,
                  page: ytPage.page,
                  totalPages: ytPage.totalPages,
                  error: null as string | null,
                };
              }
              warn(
                `YouTube transcript unavailable for ${url}; falling back to page fetch.`,
              );
            }

            const fetchResult = await fetchPage(url, signal);
            const { finalUrl } = fetchResult;

            const isPdf =
              (fetchResult.rawBuffer &&
                isPdfContentType(fetchResult.contentType)) ||
              (!fetchResult.rawBuffer && isPdfUrl(url));

            let page;
            if (isPdf && fetchResult.rawBuffer) {
              page = await extractPdf(
                fetchResult.rawBuffer,
                url,
                finalUrl,
                limit,
                false,
              );
            } else if (
              isPdf &&
              fetchResult.html &&
              fetchResult.html.startsWith("%PDF")
            ) {
              const buf = Buffer.from(fetchResult.html, "binary");
              page = await extractPdf(buf, url, finalUrl, limit, false);
            } else {
              page = extractPage(fetchResult.html, url, finalUrl, limit);
            }

            const scored = scoreCandidate(
              { url, title: page.title, snippet: page.description },
              "",
            );
            return {
              index: i + bi + 1,
              url: page.finalUrl,
              title: page.title,
              published: page.published,
              wordCount: page.wordCount,
              domainScore: scored.domainScore,
              tier: scored.tier,
              content: page.text,
              page: page.page,
              totalPages: page.totalPages,
              error: null as string | null,
            };
          }),
        );

        for (let bi = 0; bi < settled.length; bi++) {
          const outcome = settled[bi];
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
          } else {
            const msg = errorMessage(outcome.reason);
            if (!isAbortError(outcome.reason)) {
              warn(`Failed to read ${batch[bi]}: ${msg}`);
            }
            results.push({
              index: i + bi + 1,
              url: batch[bi],
              title: "",
              published: null,
              wordCount: 0,
              domainScore: 0,
              tier: "general",
              content: "",
              error: msg,
            });
          }
        }

        if (i + CONCURRENCY < urls.length)
          await sleep(MULTI_READ_BATCH_DELAY_MS);
      }

      const succeeded = results.filter((r) => r.error === null).length;
      status(`Done: ${succeeded}/${urls.length} pages read successfully.`);

      if (succeeded === 0) {
        return "All page reads failed. Verify the URLs are publicly accessible.";
      }

      return results;
    },
  });

  const readSkillFileTool = tool({
    name: "ReadSkillFile",
    description: "Reads a specialized knowledge skill file from the plugin's skills directory. Use this to apply specific formatting rules or domain expertise before synthesizing research.",
    parameters: {
      skillName: z.string().describe("The name of the skill file to read (without extension)"),
    },
    implementation: async ({ skillName }, { status }) => {
      status(`Reading skill file: ${skillName}...`);
      const content = readSkillFile(skillName);
      if (!content) {
        return { error: `Skill file '${skillName}' not found.` };
      }
      return { content };
    },
  });

  const ragAddLibraryTool = tool({
    name: "RAG Add Library",
    description:
      "Index a local folder into a searchable RAG library with priority and tag metadata. " +
      "Multiple libraries can coexist - like GPT4All's multi-library model. " +
      "Each library has a priority tier (proprietary > internal > reference > general) " +
      "and tags for automatic worker routing (e.g. 'legal', 'academic', 'technical'). " +
      "When 'Research' runs with local sources enabled, workers search the right " +
      "libraries based on their role: the academic worker prefers 'academic'-tagged libraries, " +
      "the regulatory worker prefers 'legal'/'policy'-tagged ones, etc. " +
      "Supports 30+ file types: text, markdown, HTML, code, CSV, JSON, XML, Jupyter notebooks, and more. " +
      "Re-indexing a folder that was already indexed replaces the old library.",
    parameters: {
      name: z
        .string()
        .min(1)
        .max(100)
        .describe(
          "A descriptive name for this library, e.g. 'Company Policies', " +
          "'Research Papers', 'Client Reports'. Used in search results and reports.",
        ),
      folderPath: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the folder containing your documents. " +
          "All supported files in subdirectories will be included.",
        ),
      priority: z
        .enum(["proprietary", "internal", "reference", "general"])
        .optional()
        .describe(
          "Priority tier for progressive source retrieval. " +
          "proprietary = searched first, highest trust (your own confidential data). " +
          "internal = second priority (shared team knowledge). " +
          "reference = third priority (curated reference materials). " +
          "general = lowest priority (miscellaneous). " +
          "Default: general.",
        ),
      tags: z
        .array(
          z.enum([
            "legal",
            "academic",
            "technical",
            "financial",
            "medical",
            "policy",
            "reports",
            "code",
            "general",
          ]),
        )
        .optional()
        .describe(
          "Tags for automatic worker routing. Workers search matching libraries first. " +
          "Examples: ['legal'] for contracts/policies, ['academic', 'technical'] for papers, " +
          "['financial', 'reports'] for financial data. Default: ['general'].",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Optional description of what this library contains."),
      confirmed: WRITE_GATE_CONFIRMED_PARAM,
    },

    implementation: async (
      { name, folderPath, priority, tags, description, confirmed },
      { status },
    ) => {
      try {
        const gate = checkWriteApproval(confirmed);
        if (gate) return { error: true, output: gate };
        const store = getGlobalStore();
        const cfg = readConfig(ctl);
        const library = await store.indexLibrary(
          name,
          folderPath,
          description ?? "",
          (priority as LibraryPriority) ?? "general",
          (tags as LibraryTag[]) ?? ["general"],
          cfg.contentLimitPerPage,
          status,
        );
		
		saveGlobalStoreIndex();
        return {
          success: true,
          library: {
            id: library.id,
            name: library.name,
            folderPath: library.folderPath,
            description: library.description,
            priority: library.priority,
            tags: library.tags,
            fileCount: library.fileCount,
            chunkCount: library.chunkCount,
            totalWords: library.totalWords,
            indexedAt: library.indexedAt,
			indexingReport: library.indexingReport ?? [],
            fileTypes: summariseFileTypes(library.files),
          },
          instructions:
            "Library indexed. Enable 'Local Document Sources' in plugin settings " +
            "to include these documents in 'Research' results. " +
            `Priority: ${library.priority} - ` +
            (library.priority === "proprietary"
              ? "will be searched first, before all other sources."
              : library.priority === "internal"
                ? "will be searched after proprietary libraries."
                : "will be searched alongside other libraries."),
        };
      } catch (err: unknown) {
        return `Error indexing library: ${errorMessage(err)}`;
      }
    },
  });

  const ragListLibrariesTool = tool({
    name: "RAG List Libraries",
    description:
      "List all indexed RAG libraries with their metadata, stats, and priority tiers. " +
      "Shows library name, priority, tags, folder path, file counts, chunk counts, " +
      "word totals, and file type breakdown. Libraries are sorted by priority.",
    parameters: {},

    implementation: async () => {
      const store = getGlobalStore();
      const libraries = store.getLibraries();

      if (libraries.length === 0) {
        return {
          libraries: [],
          message:
            "No libraries indexed yet. Use 'RAG Add Library' to index a folder.",
        };
      }

      return {
        libraries: libraries.map((lib: any) => ({
          id: lib.id,
          name: lib.name,
          folderPath: lib.folderPath,
          description: lib.description,
          priority: lib.priority,
          tags: lib.tags,
          fileCount: lib.fileCount,
          chunkCount: lib.chunkCount,
          totalWords: lib.totalWords,
          indexedAt: lib.indexedAt,
          fileTypes: summariseFileTypes(lib.files),
        })),
        stats: store.getStats(),
      };
    },
  });

  const ragRemoveLibraryTool = tool({
    name: "RAG Remove Library",
    description:
      "Remove an indexed RAG library by its ID. " +
      "Use 'RAG List Libraries' first to find the library ID.",
    parameters: {
      libraryId: z
        .string()
        .uuid()
        .describe("The UUID of the library to remove."),
      confirmed: WRITE_GATE_CONFIRMED_PARAM,
    },

    implementation: async ({ libraryId, confirmed }, { status }) => {
      const gate = checkWriteApproval(confirmed);
      if (gate) return { error: true, output: gate };
      const store = getGlobalStore();
      const library = store.getLibrary(libraryId);

      if (!library) {
        return `Library not found: ${libraryId}`;
      }

      const name = library.name;
      const removed = store.removeLibrary(libraryId);
	  
if (removed) {
  saveGlobalStoreIndex();
}

      if (removed) {
        status(`Removed library "${name}"`);
        return {
          success: true,
          removedLibrary: name,
          remainingLibraries: store.getLibraries().length,
        };
      }

      return "Failed to remove library.";
    },
  });

  const ragSearchTool = tool({
    name: "RAG Search",
    description:
      "Search across your indexed RAG libraries using BM25 + fuzzy n-gram hybrid scoring. " +
      "Returns the most relevant chunks ranked by relevance with context windows " +
      "(text from surrounding chunks for richer understanding). " +
      "Supports progressive mode: searches proprietary libraries first, then internal, " +
      "then reference, then general - stopping early when enough results are found. " +
      "For full research that blends local and web sources, use 'Research' with Local Document Sources enabled.",
    parameters: {
      query: z
        .string()
        .min(1)
        .describe(
          "Search query - natural language works best. Use '*' to list all chunks.",
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("Maximum results to return (default: 8)."),
      libraryId: z
        .string()
        .uuid()
        .optional()
        .describe("Optional: limit search to a specific library by its ID."),
      progressive: z
        .boolean()
        .optional()
        .describe(
          "Use progressive search (default: true). Searches libraries in priority order: " +
          "proprietary -> internal -> reference -> general. Set to false to search all at once.",
        ),
      includeContext: z
        .boolean()
        .optional()
        .describe(
          "Include surrounding chunk text for richer context (default: true). " +
          "Adds ~200 chars before and after each matched chunk.",
        ),
    },

    implementation: async (
      { query, maxResults, libraryId, progressive, includeContext },
      { status },
    ) => {
      const store = getGlobalStore();

      if (!store.hasLibraries()) {
        return "No libraries indexed. Use 'RAG Add Library' first.";
      }

      const max = maxResults ?? 8;
      const isWildcard = query.trim() === "*";
      const useProgressive = progressive !== false && !libraryId;

      status(
        isWildcard
          ? "Listing all document chunks..."
          : `Searching RAG libraries: "${query}"${useProgressive ? " (progressive)" : ""}`,
      );

      let hits;
      if (isWildcard) {
        const targetIds = libraryId ? [libraryId] : undefined;
        hits = store.listAll(max, targetIds);
      } else if (useProgressive) {
        hits = store.searchProgressive(query, max);
      } else {
        const targetIds = libraryId ? [libraryId] : undefined;
        hits = store.search(query, max, targetIds);
      }

      if (hits.length === 0) {
        return {
          results: [],
          message: "No relevant documents found for this query.",
        };
      }

      status(
        `Found ${hits.length} relevant chunks across ${new Set(hits.map((h: any) => h.libraryName)).size} library(ies).`,
      );

      const showContext = includeContext !== false;

      return hits.map((h: any, i: number) => {
        const result: Record<string, unknown> = {
          rank: i + 1,
          library: h.libraryName,
          priority: h.libraryPriority,
          file: h.fileRelPath || h.fileName,
          fileType: h.fileType,
          heading: h.heading || undefined,
          score: Math.round(h.score * 1000) / 1000,
          bm25Score: Math.round(h.bm25Score * 1000) / 1000,
          wordCount: h.wordCount,
          chunkPosition: `${h.chunkIndex + 1} of ${h.totalChunks}`,
          content: h.text,
        };

        if (showContext) {
          if (h.contextBefore) result.contextBefore = h.contextBefore;
          if (h.contextAfter) result.contextAfter = h.contextAfter;
        }

        return result;
      });
    },
  });

  const ragUpdateLibraryTool = tool({
    name: "RAG Update Library",
    description:
      "Update a library's metadata (name, description, priority, tags) without re-indexing. " +
      "Use this to change a library's priority tier or add/remove tags.",
    parameters: {
      libraryId: z
        .string()
        .uuid()
        .describe("The UUID of the library to update."),
      name: z.string().min(1).max(100).optional().describe("New name."),
      description: z.string().max(500).optional().describe("New description."),
      priority: z
        .enum(["proprietary", "internal", "reference", "general"])
        .optional()
        .describe("New priority tier."),
      tags: z
        .array(
          z.enum([
            "legal",
            "academic",
            "technical",
            "financial",
            "medical",
            "policy",
            "reports",
            "code",
            "general",
          ]),
        )
        .optional()
        .describe("New tags for worker routing."),
      confirmed: WRITE_GATE_CONFIRMED_PARAM,
    },

    implementation: async (
      { libraryId, name, description, priority, tags, confirmed },
      { status },
    ) => {
      const gate = checkWriteApproval(confirmed);
      if (gate) return { error: true, output: gate };
      const store = getGlobalStore();
      const updated = store.updateLibraryMeta(libraryId, {
        name,
        description,
        priority: priority as LibraryPriority | undefined,
        tags: tags as LibraryTag[] | undefined,
      });
	  
	  if (updated) {
  saveGlobalStoreIndex();
}

      if (!updated) return `Library not found: ${libraryId}`;

      status(`Updated library "${updated.name}"`);
      return {
        success: true,
        library: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          priority: updated.priority,
          tags: updated.tags,
        },
      };
    },
  });

  const ragCheckChangesTool = tool({
    name: "RAG Check Changes",
    description:
      "Check if files in a library have changed since indexing. " +
      "Shows modified, deleted, and newly added files. " +
      "If changes are found, you can re-index with 'RAG Add Library'.",
    parameters: {
      libraryId: z
        .string()
        .uuid()
        .describe("The UUID of the library to check."),
    },

    implementation: async ({ libraryId }) => {
      const store = getGlobalStore();
      const library = store.getLibrary(libraryId);
      if (!library) return `Library not found: ${libraryId}`;

      const changes = store.checkForChanges(libraryId);
      const hasChanges =
        changes.modified.length > 0 ||
        changes.deleted.length > 0 ||
        changes.added.length > 0;

      return {
        library: library.name,
        hasChanges,
        modified: changes.modified,
        deleted: changes.deleted,
        added: changes.added,
        suggestion: hasChanges
          ? `Re-index with: RAG Add Library(name="${library.name}", folderPath="${library.folderPath}", ` +
          `priority="${library.priority}", tags=${JSON.stringify(library.tags)})`
          : "Library is up to date - no re-indexing needed.",
      };
    },
  });

  const ragSaveIndexTool = tool({
    name: "RAG Save Index",
    description:
      "Save the current RAG index to disk so libraries persist across sessions. " +
      "Saves all libraries, chunks, and metadata to a JSON file. " +
      "Load it later with 'RAG Load Index' to avoid re-indexing.",
    parameters: {
      filePath: z
        .string()
        .min(1)
        .describe(
          "Path to save the index file, e.g. '~/.lmstudio/rag-index.json'. " +
          "Parent directories are created automatically.",
        ),
      confirmed: WRITE_GATE_CONFIRMED_PARAM,
    },

    implementation: async ({ filePath, confirmed }, { status }) => {
      try {
        const gate = checkWriteApproval(confirmed);
        if (gate) return { error: true, output: gate };
        const store = getGlobalStore();
        const resolvedPath = filePath.replace(/^~/, process.env.HOME || "~");
        store.saveIndex(resolvedPath);
        const stats = store.getStats();
        status(`RAG index saved to ${resolvedPath}`);
        return {
          success: true,
          path: resolvedPath,
          stats: {
            libraries: stats.libraries,
            totalChunks: stats.totalChunks,
            totalWords: stats.totalWords,
          },
        };
      } catch (err: unknown) {
        return `Error saving index: ${errorMessage(err)}`;
      }
    },
  });

  const ragLoadIndexTool = tool({
    name: "RAG Load Index",
    description:
      "Load a previously saved RAG index from disk. " +
      "Restores all libraries and chunks without re-scanning files. " +
      "Libraries whose folders no longer exist are skipped.",
    parameters: {
      filePath: z.string().min(1).describe("Path to the saved index file."),
      confirmed: WRITE_GATE_CONFIRMED_PARAM,
    },

    implementation: async ({ filePath, confirmed }, { status }) => {
      try {
        const gate = checkWriteApproval(confirmed);
        if (gate) return { error: true, output: gate };
        const store = getGlobalStore();
        const resolvedPath = filePath.replace(/^~/, process.env.HOME || "~");
        const result = store.loadIndex(resolvedPath);
        const stats = store.getStats();
        status(
          `Loaded ${result.loaded} library(ies)` +
          (result.skipped > 0
            ? `, skipped ${result.skipped} (missing folders)`
            : ""),
        );
        return {
          success: true,
          loaded: result.loaded,
          skipped: result.skipped,
          stats: {
            libraries: stats.libraries,
            totalChunks: stats.totalChunks,
            totalWords: stats.totalWords,
          },
        };
      } catch (err: unknown) {
        return `Error loading index: ${errorMessage(err)}`;
      }
    },
  });

  const pdfBatchReadTool = tool({
    name: "PDF Batch Read",
    description:
      "Fetch and extract text from up to 10 PDF URLs in parallel, returning " +
      "structured page-by-page content for each document. " +
      "Ideal for processing multiple research papers, reports, or manuals at once - " +
      "e.g. 4 PDFs of 20 pages each - where you need to cite specific pages or " +
      "compare content across documents. " +
      "Each result includes the full extracted text, estimated page count, word count, " +
      "and a page-window breakdown so you can reference content by page number. " +
      "Set autoIndex=true to also index all successfully read PDFs into a RAG library " +
      "for later semantic search via 'RAG Search'.",

    parameters: {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(10)
        .describe("PDF URLs to fetch and extract (1-10)."),

      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract per PDF " +
          "(default: plugin content-per-page setting).",
        ),

      pageWindowChars: z
        .number()
        .int()
        .min(500)
        .max(8000)
        .optional()
        .describe(
          "Approximate character width of each page window in the page breakdown. " +
          "Smaller = more granular page citations. Default: 2000.",
        ),

      autoIndex: z
        .boolean()
        .optional()
        .describe(
          "If true, index each successfully extracted PDF into the RAG store " +
          "under a library named after the URL hostname + path. " +
          "Default: false.",
        ),

      indexLibraryName: z
        .string()
        .optional()
        .describe(
          "Library name to use when autoIndex=true. " +
          "Default: 'pdf-batch-<timestamp>'.",
        ),
    },

    implementation: async (
      { urls, contentLimit, pageWindowChars = 2000, autoIndex = false, indexLibraryName },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;
      const CONCURRENCY = 3;

      status(`Fetching ${urls.length} PDF(s) - ${CONCURRENCY} at a time...`);

      interface PdfPageWindow {
        pageEstimate: number;
        charStart: number;
        charEnd: number;
        text: string;
      }

      interface PdfReadResult {
        index: number;
        url: string;
        title: string;
        author: string | null;
        published: string | null;
        pageCount: number;
        wordCount: number;
        charCount: number;
        fullText: string;
        pageWindows: PdfPageWindow[];
        indexedAsLibraryId: string | null;
        error: string | null;
      }

      const results: PdfReadResult[] = [];

      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        if (signal.aborted) break;

        const batch = urls.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (url: any, bi: number): Promise<PdfReadResult> => {
            const idx = i + bi + 1;
            status(`[${idx}/${urls.length}] Fetching ${url}...`);

            const fetchResult = await fetchPage(url, signal);
            const { finalUrl } = fetchResult;

            const isPdf =
              (fetchResult.rawBuffer && isPdfContentType(fetchResult.contentType)) ||
              (!fetchResult.rawBuffer && isPdfUrl(url));

            if (!isPdf) {
              return {
                index: idx,
                url: finalUrl,
                title: "",
                author: null,
                published: null,
                pageCount: 0,
                wordCount: 0,
                charCount: 0,
                fullText: "",
                pageWindows: [],
                indexedAsLibraryId: null,
                error: "URL did not return a PDF (wrong Content-Type or URL pattern).",
              };
            }

            const buffer =
              fetchResult.rawBuffer ??
              (fetchResult.html?.startsWith("%PDF")
                ? Buffer.from(fetchResult.html, "binary")
                : null);

            if (!buffer) {
              return {
                index: idx,
                url: finalUrl,
                title: "",
                author: null,
                published: null,
                pageCount: 0,
                wordCount: 0,
                charCount: 0,
                fullText: "",
                pageWindows: [],
                indexedAsLibraryId: null,
                error: "Could not obtain PDF bytes from the response.",
              };
            }

            status(`[${idx}/${urls.length}] Extracting text from PDF...`);
            const extracted = await extractPdf(buffer, url, finalUrl, limit, false);

            const text = extracted.text;
            const pageWindows: PdfPageWindow[] = [];
            const totalPages = extracted.pageCount > 0 ? extracted.pageCount : null;

            if (text.length > 0) {
              const segCount = Math.max(1, Math.ceil(text.length / pageWindowChars));
              const segSize = Math.ceil(text.length / segCount);

              for (let s = 0; s < segCount; s++) {
                const charStart = s * segSize;
                const charEnd = Math.min(charStart + segSize, text.length);
                const pageEstimate = totalPages
                  ? Math.min(totalPages, Math.round((s / segCount) * totalPages) + 1)
                  : s + 1;
                pageWindows.push({
                  pageEstimate,
                  charStart,
                  charEnd,
                  text: text.slice(charStart, charEnd),
                });
              }
            }

            const author: string | null = extracted.pdfAuthor || null;

            let indexedAsLibraryId: string | null = null;
            if (autoIndex) {
              try {
                const tmpDir = os.tmpdir();
                const safeName = url.replace(/[^a-z0-9]/gi, "_").slice(-60);
                const tmpPath = path.join(tmpDir, `pdf_batch_${safeName}.txt`);
                fs.writeFileSync(tmpPath, text, "utf-8");

                const libName =
                  indexLibraryName ||
                  `pdf-batch-${Date.now()}`;

                const store = getGlobalStore();
                const lib = await store.indexLibrary(
                  path.dirname(tmpPath),
                  libName,
                  `Auto-indexed batch PDF: ${extracted.title || url}`,
                  "reference",
                  ["general"],
                );
                indexedAsLibraryId = lib?.id ?? null;
                try { fs.unlinkSync(tmpPath); } catch { }
              } catch (indexErr) {
                warn(
                  `Auto-index failed for ${url}: ${errorMessage(indexErr)}`,
                );
              }
            }

            return {
              index: idx,
              url: finalUrl,
              title: extracted.title,
              author,
              published: extracted.published,
              pageCount: extracted.pageCount > 0 ? extracted.pageCount : pageWindows.length,
              wordCount: extracted.wordCount,
              charCount: text.length,
              fullText: text,
              pageWindows,
              indexedAsLibraryId,
              error: null,
            };
          }),
        );

        for (let bi = 0; bi < settled.length; bi++) {
          const outcome = settled[bi];
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
          } else {
            const msg = errorMessage(outcome.reason);
            if (!isAbortError(outcome.reason)) {
              warn(`Failed to read PDF ${batch[bi]}: ${msg}`);
            }
            results.push({
              index: i + bi + 1,
              url: batch[bi],
              title: "",
              author: null,
              published: null,
              pageCount: 0,
              wordCount: 0,
              charCount: 0,
              fullText: "",
              pageWindows: [],
              indexedAsLibraryId: null,
              error: msg,
            });
          }
        }

        if (i + CONCURRENCY < urls.length) await sleep(MULTI_READ_BATCH_DELAY_MS);
      }

      const succeeded = results.filter((r) => r.error === null).length;
      const totalWords = results.reduce((s, r) => s + r.wordCount, 0);
      status(
        `Done: ${succeeded}/${urls.length} PDFs read, ~${totalWords.toLocaleString()} words total.`,
      );

      if (succeeded === 0) {
        return "All PDF reads failed. Verify the URLs are accessible and return valid PDFs.";
      }

      return {
        summary: {
          totalRequested: urls.length,
          totalSucceeded: succeeded,
          totalWords,
          autoIndexed: results.filter((r) => r.indexedAsLibraryId !== null).length,
        },
        documents: results,
      };
    },
  });

  const usePluginTool = tool({
    name: "Use Plugin Tool",
    description:
      "Invoke a tool exposed by ANOTHER loaded LM Studio plugin (cross-plugin tool use). " +
      "Call with only 'plugin' to list that plugin's available tools, or with 'toolName' " +
      "(and optional 'input') to run one and return its result. This lets Deep Swarm pull " +
      "evidence or capabilities from companion plugins. Requires the target plugin to be " +
      "loaded and granted tool-use access. You can set a default plugin id in settings " +
      "(externalPluginTools).",
    parameters: {
      plugin: z
        .string()
        .optional()
        .describe("Target plugin identifier as 'owner/name' (or 'dev/owner/name'). Defaults to the configured external plugin."),
      toolName: z
        .string()
        .optional()
        .describe("Name of the remote tool to invoke. Omit to list the plugin's tools."),
      input: z
        .record(z.unknown())
        .optional()
        .describe("Arguments object passed to the remote tool."),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          "Set to true only after the user has explicitly approved invoking this remote tool. " +
            "Required when 'Require Approval Before Writes' is on and the target tool is write-capable.",
        ),
    },
    implementation: async ({ plugin, toolName, input, confirmed }, { status, warn, signal }) => {
      const cfg = readConfig(ctl);
      const pluginId = (plugin && plugin.trim()) || cfg.externalPluginTools[0] || "";

      if (!pluginId) {
        return {
          error: true,
          output:
            "No plugin specified and no default set. Pass 'plugin' (e.g. 'owner/name') or configure externalPluginTools in settings.",
        } satisfies ToolCallResult;
      }

      // item 7: per-run hard cap on cross-plugin tool calls.
      if (
        toolName &&
        runGuardrails.maxExternalToolCalls > 0 &&
        runGuardrails.externalToolCallsUsed >= runGuardrails.maxExternalToolCalls
      ) {
        return {
          error: true,
          output:
            `External plugin tool call budget exceeded: limit is ${runGuardrails.maxExternalToolCalls} call(s) ` +
            `per research run. Ask the user to raise 'Max External Plugin Tool Calls' or reduce cross-plugin usage.`,
        } satisfies ToolCallResult;
      }

      const client = ctl?.client;
      if (!client?.plugins?.pluginTools) {
        return {
          error: true,
          output:
            "Cross-plugin tools are unavailable: ctl.client.plugins.pluginTools not found. " +
            "Run this inside LM Studio with a recent SDK.",
        } satisfies ToolCallResult;
      }

      let session: any = null;
      try {
        status(`Opening remote plugin: ${pluginId}...`);
        session = await client.plugins.pluginTools(pluginId, { signal });
        const remoteTools: ReadonlyArray<any> = session?.tools ?? [];

        if (!toolName) {
          const listing = remoteTools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            readOnly: t.readOnly ?? null,
          }));
          return {
            error: false,
            output: JSON.stringify({ plugin: pluginId, tools: listing }, null, 2),
          } satisfies ToolCallResult;
        }

        const target = remoteTools.find((t) => t.name === toolName);
        if (!target) {
          return {
            error: true,
            output: `Tool '${toolName}' not found on '${pluginId}'. Available: ${
              remoteTools.map((t) => t.name).join(", ") || "(none)"
            }`,
          } satisfies ToolCallResult;
        }

        status(`Invoking ${pluginId} -> ${toolName}...`);

        // item 7: gate write-capable (or unknown-safety) remote tools behind
        // explicit user consent when the approval flag is on.
        if (target.readOnly === false || target.readOnly == null) {
          const gate = checkWriteApproval(confirmed);
          if (gate) {
            status(gate);
            return { error: true, output: gate } satisfies ToolCallResult;
          }
        }

        runGuardrails.externalToolCallsUsed += 1;
        const result = await target.implementation(input ?? {}, { status, warn, signal });
        const output =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { error: false, output } satisfies ToolCallResult;
      } catch (err: unknown) {
        return {
          error: true,
          output: `Cross-plugin call to '${pluginId}' failed: ${errorMessage(err)}`,
        } satisfies ToolCallResult;
      } finally {
        try {
          if (session && typeof session[Symbol.dispose] === "function") session[Symbol.dispose]();
          else if (session && typeof session.dispose === "function") await session.dispose();
        } catch {
          /* ignore dispose errors */
        }
      }
    },
  });

    return [
    deepResearchTool,
    researchSearchTool,
    researchReadPageTool,
    researchMultiReadTool,
    pdfBatchReadTool,
    readSkillFileTool,
    usePluginTool,
    ragAddLibraryTool,
    ragListLibrariesTool,
    ragRemoveLibraryTool,
    ragSearchTool,
    ragUpdateLibraryTool,
    ragCheckChangesTool,
    ragSaveIndexTool,
    ragLoadIndexTool,
  ];
} // closes: export async function toolsProvider(ctl: any)

// Alias for backward compatibility if other files use createTools
export const createTools = toolsProvider;

function summariseFileTypes(
  files: ReadonlyArray<{ fileType: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const ext = f.fileType || "unknown";
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return counts;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}
