/**
 * @file researcher.ts
 * Top-level entry point for the deep research engine.
 * Connects the swarm orchestrator to the report builder.
 */

import { runSwarm } from "./swarm/orchestrator";
import { buildReport } from "./report/builder";
import {
  ResearchConfig,
  ResearchResult,
  IResearchRunRecord,
  StatusFn,
  WarnFn,
} from "./types";
import { getDepthProfile } from "./constants";

/**
 * Runs a complete deep research session using the swarm architecture.
 */
export async function runDeepResearch(
  cfg: ResearchConfig,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<ResearchResult> {
  const profile = getDepthProfile(cfg.depthPreset);

  if (cfg.enableLocalSources) {
    const scope = cfg.localLibraryIds?.length
      ? `${cfg.localLibraryIds.length} selected local librar${cfg.localLibraryIds.length === 1 ? "y" : "ies"}`
      : "all indexed local libraries";

    status(`Local Document Sources enabled: searching ${scope}.`);
  }

  const swarmResult = await runSwarm(cfg, profile, status, warn, signal);

  if (signal.aborted && swarmResult.sources.length === 0) {
    return {
      report: {
        markdown: "Research was cancelled before any sources were collected.",
        sources: [],
        topicKeywords: [],
        coveredDims: [],
        gapDims: [],
        contradictions: [],
      },
      queriesUsed: swarmResult.queriesUsed,
      totalSources: 0,
      totalRounds: 0,
    };
  }

  status("\nBuilding research report…");

    const report = await buildReport(
    cfg.topic,
    swarmResult.sources,
    swarmResult.queriesUsed,
    swarmResult.topicKeywords,
    profile.depthRounds,
    swarmResult.usedAI,
    cfg.enableAIPlanning,
    status,
    profile,
    cfg.contextBudgetMode ?? "auto",
    cfg.manualContextLimit ?? 8192,
    cfg.maxSynthesisInputTokens ?? 18000,
    swarmResult.gradedCards,
    swarmResult.skill,
    cfg.includeReasoningAudit ?? true,
    {
      planner: swarmResult.plannerReasoning,
      minedQueries: swarmResult.minedUncertaintyQueries,
    },
  );

  status(
    `Report ready - ${swarmResult.sources.length} sources, ${swarmResult.queriesUsed.length} queries`,
  );

  const footer = buildRunFooter(
    swarmResult.runStats,
    swarmResult.workerErrors.length,
    swarmResult.sources.length,
    swarmResult.queriesUsed.length,
    report.citationPass,
    report.contradictionCount,
    report.retryUsed,
    report.skillUsed,
  );
  const finalMarkdown = footer
    ? `${report.markdown.trim()}\n\n${footer}`
    : report.markdown;

  const reasoningTrace = {
    planner: swarmResult.plannerReasoning,
    synthesis: report.reasoningTrace,
    minedQueries: swarmResult.minedUncertaintyQueries,
  };
  const hasTrace =
    Boolean(reasoningTrace.planner) ||
    Boolean(reasoningTrace.synthesis) ||
    (reasoningTrace.minedQueries?.length ?? 0) > 0;
  const metadata: IResearchRunRecord = {
    runId: String(Date.now()),
    topic: cfg.topic,
    timestamp: new Date().toUTCString(),
    reasoningTrace: hasTrace ? reasoningTrace : undefined,
  };

  return {
    report: { ...report, markdown: finalMarkdown },
    queriesUsed: swarmResult.queriesUsed,
    totalSources: swarmResult.sources.length,
    totalRounds: profile.depthRounds,
    metadata,
  };
}

function buildRunFooter(
  stats: Readonly<NonNullable<import("./swarm/orchestrator").OrchestratorResult["runStats"]>> | undefined,
  workerErrorCount: number,
  sourceCount: number,
  queryCount: number,
  citationPass?: boolean,
  contradictionCount?: number,
  retryUsed?: boolean,
  skillUsed?: string,
): string {
  if (!stats) return "";
  const elapsedMin = Math.round(stats.runtimeElapsedMs / 60000);
  const fmtMin = (ms: number) =>
    !Number.isFinite(ms) || ms <= 0 ? "unlimited" : `${Math.round(ms / 60000)} min`;
  const lines: string[] = [
    "---",
    "## 🔍 Query Log",
    `Sources collected: ${sourceCount}`,
    `Queries run: ${queryCount}`,
    `Worker errors: ${workerErrorCount}`,
    "",
    "## ✅ Citation Verification",
    `Citation pass: ${citationPass === undefined ? "not checked" : citationPass ? "PASS" : "FAIL"}`,
    `Contradictions detected: ${contradictionCount ?? 0}`,
    `Synthesis retry: ${retryUsed ? "yes" : "no"}`,
    `Skill pack: ${skillUsed ?? "none"}`,
    "",
    "## 🚦 Source Health",
    `DDG state: ${stats.ddgState}`,
    `DDG searches attempted: ${stats.ddgQueries}`,
    `DDG blocks/challenges: ${stats.ddgBlocks}`,
    `SearXNG searches attempted: ${stats.searxngQueries}`,
    `SearXNG valid results: ${stats.searxngValidResults}`,
    "",
    "## 🤖 LLM Watchdog",
    `LLM calls used: ${stats.llmCallsUsed} / ${stats.llmCallBudget}`,
    `Critic/verifier: ${stats.criticCallsUsed} grading call${stats.criticCallsUsed === 1 ? "" : "s"}, ${stats.criticRetrySourcesAdded} retry source${stats.criticRetrySourcesAdded === 1 ? "" : "s"} added`,
    `Runtime: ${elapsedMin} min`,
    `Session limit: ${fmtMin(stats.sessionLimitMs)} | Effective runtime: ${fmtMin(stats.effectiveRuntimeMs)}`,
    "",
    "## 💾 Cache & Archives",
    `Visited cache entries: ${stats.cacheEntries}/${stats.cacheMaxEntries} (max age ${stats.cacheMaxAgeDays} days)`,
    `Negative-cache entries: ${stats.cacheNegativeEntries}`,
    `Cache file: ${stats.cacheFile}`,
    `Pages archived to Wayback: ${stats.pagesArchived}`,
    `Archive submission failures: ${stats.archiveSubmitFailures}`,
  ];
  return lines.join("\n");
}