// src/net/decodoApi.ts
// Decodo Web Scraping API integration: a server-side fetch tier that resolves
// targets from Decodo's proxy pool. Used when the local network cannot reach a
// host directly (e.g. duckduckgo.com is TCP-blocked on this egress).
//
// Endpoint: POST https://scraper-api.decodo.com/v2/scrape
//   Authorization: Basic <TOKEN>
//   Body: { "target": "universal", "url": "<target>", "proxy_pool": "premium" }
//   Response: { "results": [ { "content": "<JSON-encoded HTML>", "status_code": 200 } ] }
import { isPrivateUrl } from "./ssrf";

export interface DecodoStats {
  configured: boolean;
  attempts: number;
  successes: number;
  failures: number;
  lastError: string | null;
}

const DECODO_ENDPOINT = "https://scraper-api.decodo.com/v2/scrape";
const DECODO_TIMEOUT_MS = 25_000;
const DECODO_MAX_CALLS_PER_RUN = 200;
const DECODO_MAX_CONSECUTIVE_FAILURES = 5;

const stats: DecodoStats = {
  configured: false,
  attempts: 0,
  successes: 0,
  failures: 0,
  lastError: null,
};

let decodoToken = "";
let callsMade = 0;
let consecutiveFailures = 0;
let disabled = false;

export function setDecodoToken(token: string | undefined): void {
  decodoToken = token?.trim() ?? "";
  stats.configured = decodoToken.length > 0;
  if (!stats.configured) stats.lastError = null;
}

export function isDecodoConfigured(): boolean {
  return decodoToken.length > 0 && !disabled;
}

export function resetDecodoSession(): void {
  callsMade = 0;
  consecutiveFailures = 0;
  disabled = false;
  stats.configured = decodoToken.length > 0;
  stats.attempts = 0;
  stats.successes = 0;
  stats.failures = 0;
  stats.lastError = null;
}

export function getDecodoStats(): Readonly<DecodoStats> {
  return { ...stats };
}

function noteFailure(error: string): void {
  stats.failures++;
  stats.lastError = error;
  consecutiveFailures++;
  if (consecutiveFailures >= DECODO_MAX_CONSECUTIVE_FAILURES) {
    disabled = true;
    stats.lastError = `${error} (disabled after ${DECODO_MAX_CONSECUTIVE_FAILURES} consecutive failures)`;
  }
}

/**
 * Target-side outcomes (the proxy fetched the page but the TARGET site
 * returned a non-2xx status, a stub/empty body, or a bot challenge). The
 * Decodo transport itself is healthy, so these must NOT advance the
 * consecutive-failure circuit breaker — otherwise five DDG 202 challenges
 * arriving through Decodo disable the whole tier.
 */
function noteTargetOutcome(error: string): void {
  stats.lastError = `${error} (target-side; not counted against Decodo)`;
}

/** Bot-challenge / stub-page markers shared with the DDG and waterfall tiers.
 * Kept deliberately specific — generic words like "captcha" appear in legit
 * articles and would false-positive healthy pages. */
const CHALLENGE_MARKERS = [
  "Just a moment...",
  "cf-browser-verification",
  "Attention Required! | Cloudflare",
  "Enable JavaScript and cookies to continue",
  "bots use DuckDuckGo too much",
  "unusual traffic from your computer network",
];

function looksLikeChallengeOrStub(html: string): boolean {
  if (html.trim().length < 250) return true;
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

/**
 * Fetches `url` through the Decodo Web Scraping API and returns the rendered
 * HTML, or null when Decodo is not configured / the request failed. Never
 * throws (a broken endpoint simply falls through to other tiers).
 */
export async function fetchViaDecodo(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!isDecodoConfigured()) return null;
  if (signal.aborted) return null;
  if (callsMade >= DECODO_MAX_CALLS_PER_RUN) {
    noteFailure(`per-run call cap reached (${DECODO_MAX_CALLS_PER_RUN})`);
    return null;
  }
  if (isPrivateUrl(url)) return null;

  callsMade++;
  stats.attempts++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DECODO_TIMEOUT_MS);
  if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();

  try {
    const res = await fetch(DECODO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Basic ${decodoToken}`,
      },
      body: JSON.stringify({
        target: "universal",
        url,
        proxy_pool: "premium",
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      noteFailure(`Decodo API HTTP ${res.status}`);
      return null;
    }

    // The API responds with a JSON envelope whose `results[0].content` is a
    // JSON-encoded string of the target HTML. Some responses instead carry a
    // flat envelope (`content` / `body` / `html` at the top level) or raw
    // HTML — unwrap all three shapes.
    const rawText = await res.text();
    let html: string | null = null;
    let targetStatus = res.status;

    if (rawText.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(rawText) as {
          results?: ReadonlyArray<{ content?: unknown; status_code?: number }>;
          content?: unknown;
          body?: unknown;
          html?: unknown;
        };
        const first = parsed.results?.[0];
        targetStatus = first?.status_code ?? res.status;
        const candidate =
          first?.content ?? parsed.content ?? parsed.body ?? parsed.html;
        if (typeof candidate === "string") {
          try {
            const decoded = JSON.parse(candidate);
            html = typeof decoded === "string" ? decoded : JSON.stringify(decoded);
          } catch {
            html = candidate;
          }
        } else if (typeof candidate === "object" && candidate !== null) {
          html = JSON.stringify(candidate);
        }
      } catch {
        // Not valid JSON after all — fall through and treat it as raw HTML.
      }
    }
    if (html === null) html = rawText;

    // Target-level non-2xx (e.g. DDG 202 rate-limit, 403 from the site): the
    // Decodo proxy itself answered fine. Do NOT poison the circuit breaker.
    if (targetStatus < 200 || targetStatus >= 300) {
      noteTargetOutcome(`Target HTTP ${targetStatus}`);
      return null;
    }

    if (!html || html.trim().length === 0) {
      noteTargetOutcome("Decodo returned empty content");
      return null;
    }

    // Target returned 200 but the body is a stub or bot-challenge page — again
    // a target-side outcome, so let the caller fall through to the next engine
    // without counting a Decodo transport failure.
    if (looksLikeChallengeOrStub(html)) {
      noteTargetOutcome("Target HTTP 200 with challenge/stub page");
      return null;
    }

    stats.successes++;
    consecutiveFailures = 0;
    stats.lastError = null;
    return html;
  } catch (err) {
    if (signal.aborted) return null;
    if (err instanceof DOMException && err.name === "AbortError") return null;
    noteFailure(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}