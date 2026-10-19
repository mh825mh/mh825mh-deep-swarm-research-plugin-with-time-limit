/**
 * Multi-tiered resilient fetcher for LM Studio research swarm workers.
 *
 * NOTE: `got-scraping` v4 is ESM-only. LM Studio bundles plugins as CommonJS
 * and leaves dependencies external, so a top-level `import` becomes a
 * `require("got-scraping")` that throws ERR_PACKAGE_PATH_NOT_EXPORTED on load.
 * We therefore load it lazily via an indirect dynamic import (opaque to the
 * bundler) and gracefully disable the tier if it can't be loaded.
 */

type GotScrapingResponse = { statusCode?: number; body: unknown };
type GotScrapingModule = {
  gotScraping: {
    get(url: string, options?: Record<string, unknown>): Promise<GotScrapingResponse>;
  };
};

import { fetchViaDecodo, isDecodoConfigured } from "./decodoApi";

let modPromise: Promise<GotScrapingModule | null> | null = null;

export interface FlareSolverrStats {
  configured: boolean;
  probed: boolean;
  reachable: boolean | null;
  probeError: string | null;
  attempts: number;
  successes: number;
  failures: number;
}

const fsStats: FlareSolverrStats = {
  configured: false,
  probed: false,
  reachable: null,
  probeError: null,
  attempts: 0,
  successes: 0,
  failures: 0,
};

export function resetFsStats(): void {
  fsStats.configured = false;
  fsStats.probed = false;
  fsStats.reachable = null;
  fsStats.probeError = null;
  fsStats.attempts = 0;
  fsStats.successes = 0;
  fsStats.failures = 0;
  fsReachableConfirmed = false;
}

export function recordFsAttempt(ok: boolean, error?: string): void {
  fsStats.attempts++;
  if (ok) fsStats.successes++;
  else {
    fsStats.failures++;
    if (error) fsStats.probeError = error;
  }
}

export function getFsStats(): Readonly<FlareSolverrStats> {
  return { ...fsStats };
}

/**
 * True when a configured FlareSolverr endpoint has been probed and did NOT
 * answer the ready check. Callers (the fetch waterfall and the search-HTML
 * fallback) should skip the bypass tier entirely so an unreachable endpoint
 * never racks up per-URL doomed attempts.
 */
export function isFlareSolverrKnownUnreachable(): boolean {
  return fsStats.probed && fsStats.reachable === false;
}

/** Set by the run-start probe; used by Tier B to remember whether the endpoint
 * answered the connectivity check. */
let fsReachableConfirmed = false;

async function probeFlareSolverrCore(url: string, signal?: AbortSignal): Promise<void> {
  fsStats.configured = true;
  fsStats.probed = true;
  fsStats.reachable = null;
  fsStats.probeError = null;

  const tryGet = async (probeUrl: string): Promise<boolean> => {
    if (signal?.aborted) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(probeUrl, { signal: ctrl.signal });
      if (!res.ok) return false;
      const text = await res.text();
      return /ready|FlareSolverr/i.test(text);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const base = url.replace(/\/+$/, "");
  // The standard FlareSolverr endpoint is exposed at root (e.g. http://127.0.0.1:8191/),
  // but users often configure "<host>/v1". Probe both rooted forms so a valid endpoint
  // isn't misreported as unreachable.
  const roots = [`${base}/v1`, base, `${base}/health`, `${base}/`];
  if (/\/v1$/.test(base)) roots.push(base.replace(/\/v1$/, "/"));

  let reachable = false;
  for (const root of roots) {
    if (await tryGet(root)) {
      reachable = true;
      break;
    }
  }

  if (!reachable) {
    fsStats.reachable = false;
    fsStats.probeError =
      signal?.aborted ? "aborted" : "FlareSolverr endpoint did not answer the ready check";
    return;
  }
  fsStats.reachable = true;
  fsReachableConfirmed = true;
}

/**
 * Lightweight connectivity check for a configured FlareSolverr endpoint.
 * Best-effort: never throws (a broken endpoint simply logs as unreachable so
 * the run can fall through to the Wayback tier). Reused by Tier B to verify the
 * endpoint is actually alive before promising a bypass.
 */
export async function probeFlareSolverr(
  flareSolverrUrl: string | undefined,
  signal?: AbortSignal,
): Promise<Readonly<FlareSolverrStats>> {
  const trimmed = flareSolverrUrl?.trim() ?? "";
  if (!trimmed) {
    resetFsStats();
    return getFsStats();
  }
  await probeFlareSolverrCore(trimmed, signal);
  return getFsStats();
}

function loadGotScraping(): Promise<GotScrapingModule | null> {
  if (!modPromise) {
    const dynamicImport = new Function("s", "return import(s)") as (
      specifier: string,
    ) => Promise<GotScrapingModule>;
    modPromise = dynamicImport("got-scraping").catch((err: any) => {
      console.warn(
        `[Tier A] got-scraping unavailable (${err?.code ?? err?.message}); skipping TLS tier.`,
      );
      return null;
    });
  }
  return modPromise;
}

/**
 * Multi-tiered resilient fetcher for LM Studio research swarm workers.
 *
 * @param url The target URL to fetch.
 * @param abortSignal AbortSignal to propagate timeouts and cancellation.
 * @param flaresolverrUrl Optional FlareSolverr endpoint (e.g. "http://127.0.0.1:8191/v1").
 * @returns Clean HTML string if successful, or null if all tiers fail.
 */
export async function fetchWithWaterfall(
  url: string,
  abortSignal: AbortSignal,
  flaresolverrUrl?: string
): Promise<string | null> {
  // ==========================================
  // TIER A: got-scraping (Native TLS Fingerprinting)
  // ==========================================
  const gs = await loadGotScraping();
  if (gs) {
    try {
      console.log(`[Tier A] Fetching ${url} with got-scraping...`);
      const response = await gs.gotScraping.get(url, {
        signal: abortSignal,
        throwHttpErrors: false, // Don't throw on 403/503 so we can inspect the challenge body
      });

      const body = response.body as string;

      // Verify status and ensure no Cloudflare/DDoS challenge indicators are present
      const isChallenge =
        body.includes('Just a moment...') ||
        body.includes('cf-browser-verification') ||
        body.includes('Attention Required! | Cloudflare');

      if (response.statusCode === 200 && !isChallenge) {
        return body;
      }

      console.warn(`[Tier A] Block or challenge detected for ${url} (HTTP ${response.statusCode}). Falling back...`);
    } catch (error: any) {
      if (error.name === 'AbortError') throw error;
      console.warn(`[Tier A] Network error for ${url}: ${error.message}. Falling back...`);
    }
  }

  // ==========================================
  // TIER A2: Decodo Web Scraping API (server-side fetch)
  // ==========================================
  // When the local network cannot reach the target at all (TCP-blocked egress,
  // e.g. duckduckgo.com on this host), Decodo fetches it from their proxy pool
  // and returns the rendered HTML. Runs before FlareSolverr since a remote
  // service is more likely to share an unblocked egress than the local one.
  if (isDecodoConfigured() && !abortSignal.aborted) {
    const decodoHtml = await fetchViaDecodo(url, abortSignal);
    if (decodoHtml) {
      console.log(`[Tier A2] Resolved ${url} via Decodo Web Scraping API.`);
      return decodoHtml;
    }
  }

  // ==========================================
  // TIER B: FlareSolverr (Optional Headless Bypass)
  // ==========================================
  // Gated on the run-start probe: when the endpoint is known-unreachable, the
  // whole tier is skipped so an unreachable FlareSolverr never executes dozens
  // of doomed per-URL attempts (or trips its own timeouts).
  if (flaresolverrUrl && flaresolverrUrl.trim() !== '' && !isFlareSolverrKnownUnreachable()) {
    fsStats.configured = true;
    // One-time liveness verification: if a run-start probe never succeeded,
    // don't waste per-fetch time dialing a dead endpoint.
    if (!fsReachableConfirmed && !fsStats.probed) {
      await probeFlareSolverr(flaresolverrUrl).catch(() => {});
    }
    if (!fsReachableConfirmed) {
      recordFsAttempt(false, fsStats.probeError ?? "endpoint not reachable");
      console.warn(`[Tier B] FlareSolverr unreachable, skipping ${url}. Falling back...`);
    } else {
      try {
        console.log(`[Tier B] Requesting ${url} via FlareSolverr...`);
        const fsResponse = await fetch(flaresolverrUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: 'request.get',
            url: url,
            maxTimeout: 15000,
          }),
          signal: abortSignal,
        });

        if (fsResponse.ok) {
          const fsData = (await fsResponse.json()) as {
            status?: string;
            solution?: { response?: string };
            message?: string;
          };

          if (fsData.status === 'ok' && fsData.solution?.response) {
            recordFsAttempt(true);
            console.log(`[Tier B] Successfully resolved ${url} via FlareSolverr.`);
            return fsData.solution.response;
          }
          recordFsAttempt(false, fsData.message ?? `FlareSolverr status=${fsData.status}`);
        } else {
          recordFsAttempt(false, `HTTP ${fsResponse.status}`);
        }
        console.warn(`[Tier B] FlareSolverr could not resolve ${url}. Falling back...`);
      } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        recordFsAttempt(false, error?.message);
        console.warn(`[Tier B] FlareSolverr request failed (${error.message}). Falling back...`);
      }
    }
  }

  // ==========================================
  // TIER C: Wayback Machine (Archive.org Fallback)
  // ==========================================
  try {
    console.log(`[Tier C] Fetching snapshot for ${url} from Web Archive...`);
    const archiveUrl = `https://web.archive.org/web/2/${url}`;
    const archiveResponse = await fetch(archiveUrl, { signal: abortSignal });

    if (archiveResponse.ok) {
      const body = await archiveResponse.text();
      if (body) return body;
    }
  } catch (error: any) {
    if (error.name === 'AbortError') throw error;
    console.warn(`[Tier C] Web Archive fallback failed for ${url}: ${error.message}.`);
  }

  // All strategies exhausted; gracefully exit without crashing worker thread
  console.error(`[Waterfall] All tiers exhausted for ${url}. Returning null.`);
  return null;
}
