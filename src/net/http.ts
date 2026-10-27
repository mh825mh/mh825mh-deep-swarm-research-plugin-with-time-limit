// src/net/http.ts
import * as https from "node:https";
import * as http from "node:http";
import { setServers } from "node:dns";
import { isPrivateUrl, isRiskyUrl } from "./ssrf";
import { createArchiveController } from "./archiver";
import { FETCH_MAX_RETRIES, FETCH_TIMEOUT_MS } from "../constants";

const DNS_RESOLVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"];
setServers(DNS_RESOLVERS);

const UA_POOL: ReadonlyArray<string> = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

export function buildBrowserHeaders(url?: string): Record<string, string> {
  const ua = randomUA();
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
  
  if (url) {
    try {
      const parsed = new URL(url);
      headers["Referer"] = `${parsed.protocol}//${parsed.hostname}/`;
    } catch {}
  }
  
  return headers;
}

export function buildDDGHeaders(): Record<string, string> {
  return buildBrowserHeaders();
}

export interface FetchResult {
  readonly html: string;
  readonly finalUrl: string;
  readonly contentType?: string;
  readonly rawBuffer?: Buffer;
  readonly statusCode?: number;
}

// Tier-1 direct fetch timeout is defined in constants.ts (FETCH_TIMEOUT_MS =
// 4.5s) so the orchestration budget and the fetch layer cannot drift apart.

// Proxy support (optional)
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const proxyAgent = PROXY_URL ? new (require("https-proxy-agent").HttpsProxyAgent)(PROXY_URL) : undefined;

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
}

export function isSsrfAllowed(urlStr: string, allowUrls?: ReadonlyArray<string>): boolean {
  const allow = allowUrls ?? [];
  if (allow.length === 0) return false;
  try {
    const origin = new URL(urlStr).origin;
    return allow.some((a) => {
      try { return new URL(a).origin === origin; } catch { return false; }
    });
  } catch {
    return false;
  }
}

/**
 * Direct fetch for user-configured local infrastructure (allowed private URLs).
 * Unlike fetchPage there is no retry/backoff and no Wayback fallback: a local
 * endpoint that is down should fail fast so the caller can switch tiers.
 */
export async function fetchLocalAllowed(
  url: string,
  signal: AbortSignal,
  allowUrls: ReadonlyArray<string>,
): Promise<FetchResult> {
  if (isPrivateUrl(url) && !isSsrfAllowed(url, allowUrls)) {
    throw new Error("SSRF Guard: Blocked internal URL");
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: buildBrowserHeaders(url),
      redirect: "follow",
    });
    const contentType = res.headers.get("content-type") || "";
    return { html: await res.text(), finalUrl: res.url || url, contentType, statusCode: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPage(
  url: string, 
  signal: AbortSignal, 
  options: FetchOptions = {}
): Promise<FetchResult> {
  if (isPrivateUrl(url)) throw new Error("SSRF Guard: Blocked internal URL");
  if (await isRiskyUrl(url)) {
    throw new Error("SSRF Guard: Blocked hostname resolving to internal/private addresses");
  }

  let lastError: unknown;
  const { method = 'GET', body, headers: customHeaders = {} } = options;

  for (let attempt = 0; attempt < FETCH_MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Delay to prevent burst blocking
    await new Promise((resolve) => setTimeout(resolve, 2500));

    let tierOneTimedOut = false;
    try {
      const headers = { ...buildBrowserHeaders(url), ...customHeaders };
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        tierOneTimedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method,
          body,
          signal: controller.signal,
          headers,
          redirect: "follow"
        });

        // If blocked by Cloudflare/WAF, fall back to Wayback Machine immediately
        if ([403, 429, 503].includes(res.status)) {
          throw new Error(`HTTP ${res.status}`);
        }

        const contentType = res.headers.get("content-type") || "";
        const finalUrl = res.url || url;

        if (contentType.includes("application/pdf") || contentType.includes("application/octet-stream")) {
          const arrayBuf = await res.arrayBuffer();
          return { html: "", finalUrl, contentType, rawBuffer: Buffer.from(arrayBuf), statusCode: res.status };
        }

        const html = await res.text();

        // Only check for very specific captcha markers, avoid generic words like "blocked"
        if (html.includes("cf-challenge") || html.includes("hcaptcha") || html.includes("recaptcha")) {
          throw new Error("Captcha page detected");
        }

        return { html, finalUrl, contentType, statusCode: res.status };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err: unknown) {
      // Real cancellation (outer run signal) always propagates.
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Hard Tier-1 budget exhausted: do not retry a dead host. Throw so the
      // caller falls through to Tier 2 (got-scraping / FlareSolverr / Decodo)
      // and finally the archive tier, keeping the run inside the stall window.
      if (tierOneTimedOut) {
        throw new Error(`Tier-1 fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
      }

      lastError = err;

      // Exponential backoff
      const backoffTime = 5000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
    }
  }

  // If direct fetch fails, try 10 Web Archives
  return fetchFromArchives(url, signal);
}

async function fetchFromArchives(url: string, signal: AbortSignal): Promise<FetchResult> {
  // Only resilient, maintained archives. Dead mirrors (Google webcache,
  // cc.bingj, freezedry, corsproxy.io, allorigins, cors-anywhere herokuapp)
  // were removed - they return errors or are security liabilities.
  const archives = [
    `https://web.archive.org/web/2/${url}`,
    `https://archive.today/newest/${url}`,
    `https://web.archive.org/web/2024/${url}`
  ];

  for (const cacheUrl of archives) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(cacheUrl, { 
        signal: controller.signal, 
        headers: buildBrowserHeaders(cacheUrl)
      });
      clearTimeout(timeout);
      
      if (res.ok) {
        const html = await res.text();
        if (html.length > 500) {
          return { html, finalUrl: url, contentType: res.headers.get("content-type") || "", statusCode: res.status };
        }
      }
    } catch {}
  }

  const finalError = `Failed to fetch ${url}: Blocked and all archives failed`;
  maybeArchivePage(url, "All fetch + archive tiers failed", signal, finalError);
  throw new Error(finalError);
}

/**
 * Module-level archive controller used by the research pipeline. Runs should
 * call `resetArchiveSession()` once at the start so dedup + per-run caps are
 * fresh; callers may also reach underneath via `getArchiveState()` for
 * direct, fire-and-forget submissions (e.g. failing archive reads).
 */
const archiveController = createArchiveController();

export function resetArchiveSession(): void {
  archiveController.reset();
}

export function getArchiveState(): {
  readonly submitted: number;
  readonly skipped: number;
  readonly failed: number;
} {
  return archiveController.stats();
}

export function maybeArchivePage(
  url: string,
  reason: string,
  signal: AbortSignal,
  lastError?: string,
): void {
  archiveController
    .submit(url, reason, signal, lastError)
    .catch(() => {
      // Fire-and-forget: never let archiving break the research run.
    });
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}