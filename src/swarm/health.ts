// src/swarm/health.ts

import { getFsStats } from "../net/waterfallFetcher";
import { getSearxLocalStats } from "../net/search-engines";
import { getDecodoStats } from "../net/decodoApi";
import {
  DDG_MAX_CONSECUTIVE_FAILURES,
  DDG_RATE_LIMIT_COOLDOWN_MS,
} from "../constants";

export type EngineState = "HEALTHY" | "DEGRADED" | "TEMPORARILY_UNHEALTHY" | "DISABLED";

export interface EngineHealth {
  state: EngineState;
  searchesAttempted: number;
  validResults: number; // <--- ADD THIS
  emptyResults: number;
  blocks: number;
  timeouts: number;     // <--- ADD THIS
  parserErrors: number; // <--- ADD THIS
  rateLimited: number;
  consecutiveFailures: number;
  cooldownExpiry: number | null;
  lastFailureReason: string | null;
}

export interface GapRecord {
  id: string;
  topic: string;
  missingClaim: string;
  whyInsufficient: string;
  freshnessRequired: boolean;
  preferredTier: string | null;
  searchLayerAuthorized: string;
  resolved: boolean;
}

export class SearchHealthTracker {
  public ddg: EngineHealth = this.freshState();
  public searxng: EngineHealth = this.freshState();
  public api: EngineHealth = this.freshState();
  public readonly otherEngines: Record<string, EngineHealth> = {};

  public gaps: GapRecord[] = [];
  public apiCallsMade: number = 0;
  public localChunksRetrieved: number = 0;
  public localChunksAccepted: number = 0;
  public junkUrlsRejected: number = 0;
  public pagesArchived: number = 0;
  public archiveSubmitFailures: number = 0;

  private freshState(): EngineHealth {
    return {
      state: "HEALTHY",
      searchesAttempted: 0,
      validResults: 0,
      emptyResults: 0,
      blocks: 0,
      timeouts: 0,
      parserErrors: 0,
      rateLimited: 0,
      consecutiveFailures: 0,
      cooldownExpiry: null,
      lastFailureReason: null
    };
  }

  public isDdgAvailable(): boolean {
    if (this.ddg.state === "TEMPORARILY_UNHEALTHY") {
      if (Date.now() >= (this.ddg.cooldownExpiry ?? 0)) {
        // 11 minutes passed, allow ONE health check
        return true; 
      }
      return false;
    }
    return true;
  }

    public recordDdgSuccess(hitCount: number) {
    this.ddg.searchesAttempted++;
    if (hitCount >= 1) {
      this.ddg.validResults++;
      this.ddg.consecutiveFailures = 0;
      this.ddg.state = "HEALTHY";
      this.ddg.cooldownExpiry = null;
    } else {
      this.ddg.emptyResults++;
      this.recordDdgFailure("INVALID_RESULT_SET (0 results)");
    }
  }

  public recordDdgFailure(reason: string) {
    this.ddg.searchesAttempted++;
    this.ddg.blocks++;
    this.ddg.consecutiveFailures++;
    this.ddg.lastFailureReason = reason;

    if (reason.includes("timeout")) this.ddg.timeouts++;
    if (reason.includes("parser")) this.ddg.parserErrors++;
    const rateLimited = /rate_limited|202/i.test(reason);
    if (rateLimited) this.ddg.rateLimited++;

    // A 202 rate-limit page is definitive: stop hammering DDG for the rest of
    // the run instead of letting 12 workers retry it in a row.
    if (rateLimited) {
      this.ddg.state = "TEMPORARILY_UNHEALTHY";
      this.ddg.cooldownExpiry = Date.now() + DDG_RATE_LIMIT_COOLDOWN_MS;
      return;
    }

    if (this.ddg.consecutiveFailures >= DDG_MAX_CONSECUTIVE_FAILURES) {
      this.ddg.state = "TEMPORARILY_UNHEALTHY";
      this.ddg.cooldownExpiry = Date.now() + DDG_RATE_LIMIT_COOLDOWN_MS;
    }
  }

  public canUseApi(): boolean {
    return this.apiCallsMade < 3;
  }

  public isOtherEngineAvailable(engine: string): boolean {
    const state = this.otherEngines[engine];
    if (!state) return true;
    if (state.state === "TEMPORARILY_UNHEALTHY") {
      if (Date.now() >= (state.cooldownExpiry ?? 0)) {
        state.state = "HEALTHY";
        state.consecutiveFailures = 0;
        state.cooldownExpiry = null;
        return true;
      }
      return false;
    }
    return state.state !== "DISABLED";
  }

  private engineState(engine: string): EngineHealth {
    // SearXNG has its own first-class health block in the report. Point the
    // otherEngines entry at the same state object so every call updates both.
    if (engine === "searxng") {
      this.otherEngines[engine] = this.searxng;
    }
    return (this.otherEngines[engine] = this.otherEngines[engine] ?? this.freshState());
  }

  /**
   * A 200 OK with zero results means the query was too narrow, not that the
   * engine is down. Count the attempt/empty result but never cooldown.
   */
  public recordOtherEngineEmpty(engine: string): void {
    const state = this.engineState(engine);
    state.searchesAttempted++;
    state.emptyResults++;
  }

  public recordOtherEngineHit(engine: string, hitCount: number, reason?: string) {
    const state = this.engineState(engine);
    state.searchesAttempted++;
    if (hitCount >= 1) {
      state.validResults++;
      state.consecutiveFailures = 0;
      state.state = "HEALTHY";
      state.cooldownExpiry = null;
      state.lastFailureReason = null;
    } else {
      state.emptyResults++;
      state.consecutiveFailures++;
      state.blocks++;
      if (reason) state.lastFailureReason = reason;
      if (state.consecutiveFailures >= 3) {
        state.state = "TEMPORARILY_UNHEALTHY";
        state.cooldownExpiry = Date.now() + (11 * 60 * 1000);
      }
    }
  }

  public generateReport(): string {
    return `
══════════════════════════════════════════════════════════════
RESEARCH SOURCE HEALTH REPORT
══════════════════════════════════════════════════════════════
SOURCE PRIORITY ENFORCEMENT
- Local sources searched first: YES
- Local chunks retrieved: ${this.localChunksRetrieved}
- Local chunks accepted: ${this.localChunksAccepted}
- External searches authorised: ${this.gaps.length}
- Gaps resolved: ${this.gaps.filter(g => g.resolved).length}

DDG HEALTH
- State: ${this.ddg.state}
- Searches attempted: ${this.ddg.searchesAttempted}
- Valid results: ${this.ddg.validResults}
- Blocks/challenges: ${this.ddg.blocks}
- Rate-limited (202): ${this.ddg.rateLimited}
- Consecutive failures: ${this.ddg.consecutiveFailures}
- Cooldown expiry: ${this.ddg.cooldownExpiry ? new Date(this.ddg.cooldownExpiry).toISOString() : 'None'}
- Last failure reason: ${this.ddg.lastFailureReason || 'None'}

SEARXNG HEALTH
- State: ${this.searxng.state}
- Searches attempted: ${this.searxng.searchesAttempted}
- Valid results: ${this.searxng.validResults}

SEARXNG LOCAL INSTANCE
${(() => {
  const sx = getSearxLocalStats();
  if (!sx.configured) return "- Not configured (public instance only)";
  const state = sx.reachable === null ? "NOT PROBED" : sx.reachable ? "REACHABLE" : "UNREACHABLE (public fallback active)";
  return [
    `- Configured: YES`,
    `- State: ${state}`,
    sx.probeError ? `- Probe error: ${sx.probeError}` : null,
  ].filter(Boolean).join("\\n");
})()}

OTHER ENGINES HEALTH
${Object.entries(this.otherEngines).map(([name, e]) => `- ${name}: ${e.state} (${e.searchesAttempted} attempts, ${e.validResults} valid, cooldown ${e.cooldownExpiry ? new Date(e.cooldownExpiry).toISOString() : "None"})`).join("\n") || "- No extra engines probed yet"}

API GAP FILLING
- API eligible: ${this.canUseApi() ? 'YES' : 'NO'}
- API requests: ${this.apiCallsMade}
- API call budget: 3

QUERY QUALITY
- Gaps generated: ${this.gaps.length}
- Invalid gaps rejected: ${this.gaps.filter(g => !g.missingClaim).length}

FLARESOLVERR HEALTH
${(() => {
  const fs = getFsStats();
  const reachable = fs.reachable === null ? "NOT PROBED" : fs.reachable ? "YES" : "NO";
  return [
    `- Configured: ${fs.configured ? "YES" : "NO"}`,
    `- Reachable: ${reachable}`,
    `- Resolution attempts: ${fs.attempts} | Successful: ${fs.successes} | Failures: ${fs.failures}`,
    `- Last descriptor: ${fs.probeError || "None"}`,
  ].join("\n");
})()}

DECODO WEB SCRAPING API
${(() => {
  const dd = getDecodoStats();
  return [
    `- Configured: ${dd.configured ? "YES" : "NO"}`,
    `- Server-side fetch attempts: ${dd.attempts} | Successful: ${dd.successes} | Failures: ${dd.failures}`,
    `- Last error: ${dd.lastError || "None"}`,
  ].join("\n");
})()}

ARCHIVE-ON-FAILURE
- Pages archived to Wayback: ${this.pagesArchived}
- Archive submission failures/skips: ${this.archiveSubmitFailures}
══════════════════════════════════════════════════════════════
`;
  }
}