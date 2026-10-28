// src/net/search-engines.ts
import type { SearchHit } from "../types";
import { DdgRateLimiter, searchDDG } from "./ddg";
import { buildBrowserHeaders, fetchLocalAllowed, fetchPage } from "./http";
import { fetchWithWaterfall, isFlareSolverrKnownUnreachable } from "./waterfallFetcher";
import { fetchViaDecodo, isDecodoConfigured } from "./decodoApi";
import { globalEnginePacer, ENGINE_PACE_MIN_INTERVAL_MS } from "../swarm/pluginBridgeAndPacer";
import { SEARXNG_MAX_CONCURRENCY, SEARXNG_QUERY_TIMEOUT_MS } from "../constants";
import { searchRssFeeds } from "./rss-engine";
import { searchTelegram } from "./social-engines";
import {
  searchArxiv,
  searchBraveApi,
  searchCrossref,
  searchGdelt,
  searchOpenAlex,
  searchReferenceSites,
  searchSerper,
} from "./api-engines";

export type SearchEngine =
  | "bing"
  | "ddg"
  | "brave"
  | "google"
  | "scholar"
  | "searxng"
  | "mojeek"
  | "yandex"
  | "serper"
  | "brave-api"
  | "openalex"
  | "crossref"
  | "arxiv"
  | "gdelt"
  | "reference"
  | "youtube"
  | "rss"
  | "telegram";

export interface SearchEngineOptions {
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
  readonly rssFeedUrls?: ReadonlyArray<string>;
  readonly telegramChannels?: ReadonlyArray<string>;
  readonly flaresolverrUrl?: string;

  /** Local SearXNG base URL (e.g. http://127.0.0.1:8080). Blank = public only. */
  readonly searxngUrl?: string;
}

export type LimiterFactory = () => DdgRateLimiter;

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(value: string): string {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    if (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) {
      const target = parsed.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
  } catch {}
  return value;
}

function normaliseUrl(value: string): string {
  return decodeDuckDuckGoUrl(value).trim().replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
}

function dedupeHits(hits: ReadonlyArray<SearchHit>, maxResults: number): ReadonlyArray<SearchHit> {
  const result: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const url = decodeDuckDuckGoUrl(hit.url);
    const key = normaliseUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...hit, url, title: hit.title?.trim() || url, snippet: hit.snippet?.trim() || "" });
    if (result.length >= maxResults) break;
  }
  return result;
}

function parseSearchLinks(html: string, source: string, maxResults: number): ReadonlyArray<SearchHit> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const linkRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while (hits.length < maxResults && (match = linkRe.exec(html)) !== null) {
    const href = decodeDuckDuckGoUrl(match[1]);
    const title = stripHtml(match[2]);
    if (!href.startsWith("http")) continue;
    if (!title || title.length < 2) continue;
    const key = normaliseUrl(href);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    hits.push({ url: href, title, snippet: "", discoveredBy: source });
  }
  return hits;
}

/**
 * Parse a SearXNG `format=json` response. Returns `null` when the payload is not
 * usable JSON so the caller can fall back to HTML parsing; an empty array is a
 * valid "200 OK but no results" response.
 */
export function parseSearxJson(
  raw: string,
  maxResults: number,
): ReadonlyArray<SearchHit> | null {
  try {
    const data = JSON.parse(raw) as {
      results?: Array<{
        url?: string;
        title?: string;
        content?: string;
        snippet?: string;
      }>;
    };
    if (!Array.isArray(data?.results)) return null;

    const hits: SearchHit[] = [];
    for (const result of data.results) {
      const url = typeof result.url === "string" ? result.url.trim() : "";
      if (!url.startsWith("http")) continue;
      hits.push({
        url,
        title: (result.title ?? url).trim() || url,
        snippet: (result.content ?? result.snippet ?? "").trim(),
        discoveredBy: "searxng",
      });
    }
    return dedupeHits(hits, maxResults);
  } catch {
    return null;
  }
}

// Serialized queue to prevent concurrent hits and ban patterns
class EngineQueue {
  private chain: Promise<any> = Promise.resolve();
  private lastRequest = 0;
  private readonly minDelay: number;

  constructor(minDelayMs: number = 4000) {
    this.minDelay = minDelayMs;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // Enforce minimum delay between sequential requests
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minDelay) {
      const jitter = Math.random() * 1000; // add up to 1s of jitter to look human
      await new Promise((resolve) => setTimeout(resolve, this.minDelay - elapsed + jitter));
    }

    const runTask = this.chain.then(() => task());
    // Update chain to catch errors so one failure doesn't break the queue permanently
    this.chain = runTask.then(() => undefined, () => undefined);
    this.lastRequest = Date.now();
    return runTask;
  }
}

/**
 * Small FIFO semaphore used to cap concurrent requests to the local SearXNG
 * instance. The old per-engine serialized queue allowed 9 workers to queue up
 * behind each other until the 30s multi-engine cap fired.
 */
class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaseFn();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return this.releaseFn();
  }

  private releaseFn(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

const searxLocalSemaphore = new AsyncSemaphore(SEARXNG_MAX_CONCURRENCY);

const engineQueues: Record<string, EngineQueue> = {
  ddg: new EngineQueue(4000),
  bing: new EngineQueue(3500),
  brave: new EngineQueue(3500),
  google: new EngineQueue(5000), // Google is strict, needs 5s
  scholar: new EngineQueue(5000),
  searxng: new EngineQueue(3000),
  mojeek: new EngineQueue(3000),
  yandex: new EngineQueue(4000),
  youtube: new EngineQueue(3000),
  reference: new EngineQueue(2000),
  serper: new EngineQueue(4000),
  "brave-api": new EngineQueue(4000),
};

async function searchHtmlEndpoint(url: string, source: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  
  // Run the fetch inside the engine's specific queue
  const queue = engineQueues[source] || new EngineQueue(4000);
  return queue.run(async () => {
    try {
      const response = await fetchPage(url, signal);
      const directHits = parseSearchLinks(response.html, source, maxResults);
      if (directHits.length > 0) return directHits;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }

    // Tier A2: Decodo Web Scraping API — when the local egress cannot reach the
    // engine's search host (TCP-blocked network), fetch the same search URL
    // server-side through Decodo's proxy pool and parse it like a direct fetch.
    if (isDecodoConfigured() && !signal.aborted) {
      try {
        const decodoHtml = await fetchViaDecodo(url, signal);
        if (decodoHtml) {
          const decodoHits = parseSearchLinks(decodoHtml, source, maxResults);
          if (decodoHits.length > 0) return decodoHits;
        }
      } catch (decodoError: unknown) {
        if (decodoError instanceof DOMException && decodoError.name === "AbortError") throw decodoError;
        console.warn(`[${source} Tier A2] Decodo search fallback failed for "${url.slice(0, 80)}": ${decodoError instanceof Error ? decodoError.message : String(decodoError)}`);
      }
    }

    // Tier B: FlareSolverr search fallback — many HTML engines (brave, google,
    // bing, searxng, ...) WAF out bots. Rendering the same search URL in a
    // headless browser via FlareSolverr sidesteps the challenge page. The result
    // HTML is fed through the same parser, so engines remain interchangeable.
    // Skipped entirely when the run-start probe found the endpoint unreachable.
    if (flaresolverrUrl && flaresolverrUrl.trim() !== "" && !signal.aborted && !isFlareSolverrKnownUnreachable()) {
      try {
        const fsHtml = await fetchWithWaterfall(url, signal, flaresolverrUrl);
        if (fsHtml) {
          const fsHits = parseSearchLinks(fsHtml, source, maxResults);
          if (fsHits.length > 0) return fsHits;
        }
      } catch (fsError: unknown) {
        if (fsError instanceof DOMException && fsError.name === "AbortError") throw fsError;
        console.warn(`[${source} Tier B] FlareSolverr search fallback failed for "${url.slice(0, 80)}": ${fsError instanceof Error ? fsError.message : String(fsError)}`);
      }
    }

    return [];
  });
}

async function searchBrave(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, "brave", maxResults, signal, flaresolverrUrl);
}

async function searchGoogle(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14&hl=en&num=${maxResults}`, "google", maxResults, signal, flaresolverrUrl);
}

async function searchGoogleScholar(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`, "scholar", maxResults, signal, flaresolverrUrl);
}

/** Default base URL of the local SearXNG instance (matches the config default). */
export const DEFAULT_SEARXNG_LOCAL_URL = "http://127.0.0.1:8080";
const PUBLIC_SEARXNG_URL = "https://searx.be";

export function normalizeSearxBase(base: string): string {
  return base.trim().replace(/\/+$/, "").replace(/\/search$/, "");
}

/**
 * Ordered SearXNG endpoints for a query: local first (when configured and not
 * known-dead), then the public instance. The local tier's URLs are marked so
 * the caller can pass the matching SSRF allowance.
 */
export function searxEndpointsFor(
  rawBase: string,
  query: string,
  maxResults: number,
): ReadonlyArray<{ url: string; local: boolean }> {
  const base = normalizeSearxBase(rawBase ?? "");
  const q = encodeURIComponent(query);
  const endpoints: { url: string; local: boolean }[] = [];
  if (base) {
    endpoints.push({
      url: `${base}/search?q=${q}&format=html`,
      local: true,
    });
  }
  endpoints.push({ url: `${PUBLIC_SEARXNG_URL}/search?q=${q}&format=html`, local: false });
  return endpoints;
}

interface SearxLocalState {
  configured: boolean;
  probed: boolean;
  reachable: boolean | null;
  probeError: string | null;
}

let searxLocal: SearxLocalState = { configured: false, probed: false, reachable: null, probeError: null };

export function getSearxLocalStats(): Readonly<SearxLocalState> {
  return { ...searxLocal };
}

export function isSearxLocalKnownUnavailable(): boolean {
  return searxLocal.probed && searxLocal.reachable === false;
}

/** True only after a successful run-start probe of the configured local URL. */
export function isSearxLocalReachable(): boolean {
  return searxLocal.probed && searxLocal.reachable === true;
}

/**
 * Promote the local SearXNG engine to index 0 when it is reachable, so the
 * worker waterfall queries the local instance before DDG. When it is not
 * reachable the configured order is preserved untouched.
 */
export function prioritizeSearxng(
  engines: ReadonlyArray<string>,
  localReachable: boolean,
): string[] {
  const deduped = Array.from(new Set(engines.filter((engine) => Boolean(engine))));
  // Promote only when SearXNG is already part of this engine set. Adding it
  // unconditionally let the DIRECT/API layers re-run SearXNG on every query.
  if (!localReachable || !deduped.includes("searxng")) return deduped;
  return ["searxng", ...deduped.filter((engine) => engine !== "searxng")];
}

export function resetSearxLocalStats(): void {
  searxLocal = { configured: false, probed: false, reachable: null, probeError: null };
}

function setSearxLocal(reachable: boolean, probeError: string | null): void {
  searxLocal = {
    ...searxLocal,
    probed: true,
    reachable,
    probeError: reachable ? null : probeError,
  };
}

/**
 * Run-start connectivity probe for the configured local SearXNG instance.
 * Never throws; on failure the local tier is marked dead for the run so
 * searches fall straight through to the public instance.
 */
export async function probeSearxLocal(rawBase: string, signal?: AbortSignal): Promise<void> {
  const base = normalizeSearxBase(rawBase ?? "");
  searxLocal = { configured: Boolean(base), probed: false, reachable: null, probeError: null };
  if (!base) {
    setSearxLocal(false, "empty URL");
    return;
  }

  const headers = buildBrowserHeaders(base);
  // Prefer the HTML endpoint first: it works even when trainers disable the
  // JSON API. The instance's bot-limiter 403s are treated as "reachable but
  // refuses us", which still means the endpoint is up.
  for (const url of [`${base}/search?q=probe&format=html`, `${base}/`]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
      if (res.ok || res.status === 403 || res.status === 429) {
        setSearxLocal(true, null);
        return;
      }
      setSearxLocal(false, `HTTP ${res.status} from ${url}`);
      if (res.status !== 404) return;
    } catch (error: unknown) {
      if (signal?.aborted) {
        setSearxLocal(false, "probing aborted");
        return;
      }
      setSearxLocal(
        false,
        error instanceof Error ? error.message : String(error),
      );
      // Any connection failure on the first URL is definitive for TCP-refused;
      // try the root second for the 404-free fallback case.
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Local SearXNG search. Tries `format=json` first (reliable url/title/content),
 * then falls back to HTML only when JSON is blocked or unparseable. Concurrency
 * is capped so nine workers cannot queue behind each other for 30 seconds.
 */
async function searchSearxLocal(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  base: string,
): Promise<ReadonlyArray<SearchHit> | null> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const startedAt = Date.now();
  const release = await searxLocalSemaphore.acquire();
  try {
    // Drop work that waited too long for a slot; the caller's 12s cap has
    // already elapsed, so completing now would only waste the instance.
    if (Date.now() - startedAt > SEARXNG_QUERY_TIMEOUT_MS) return [];

    const q = encodeURIComponent(query);
    const jsonUrl = `${base}/search?q=${q}&format=json`;
    const jsonRes = await fetchLocalAllowed(jsonUrl, signal, [base]);
    const jsonStatus = jsonRes.statusCode ?? 0;

    if (jsonStatus === 200) {
      const parsed = parseSearxJson(jsonRes.html, maxResults);
      // A valid 200 JSON response (including `[]`) is authoritative. Only
      // unparseable JSON falls through to the HTML endpoint.
      if (parsed !== null) return parsed;
    }

    if ([200, 400, 403, 404].includes(jsonStatus)) {
      const htmlRes = await fetchLocalAllowed(
        `${base}/search?q=${q}&format=html`,
        signal,
        [base],
      );
      return parseSearchLinks(htmlRes.html, "searxng", maxResults);
    }

    return null;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const msg = error instanceof Error ? error.message : String(error);
    // Connection-level failure: the local tier really is unavailable.
    setSearxLocal(false, msg);
    return null;
  } finally {
    release();
  }
}

async function searchSearxng(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string, searxngUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  let warnedLocalUnavailable = false;
  for (const { url, local } of searxEndpointsFor(searxngUrl ?? "", query, maxResults)) {
    if (local && isSearxLocalKnownUnavailable()) {
      if (!warnedLocalUnavailable) {
        warnedLocalUnavailable = true;
        console.warn(
          `[searxng] Local instance (${normalizeSearxBase(searxngUrl ?? "")}) unavailable` +
            ` (${getSearxLocalStats().probeError ?? "no response"}) — falling back to public ${PUBLIC_SEARXNG_URL}.`,
        );
      }
      continue;
    }
    if (local) {
      const allow = normalizeSearxBase(searxngUrl ?? DEFAULT_SEARXNG_LOCAL_URL);
      const localHits = await searchSearxLocal(query, maxResults, signal, allow);
      // A valid local 2xx response is authoritative — including `[]`. A narrow
      // query returning zero local hits must not trigger a second public-SearXNG
      // request (that is what doubled the load in the logs).
      if (localHits !== null) return localHits;
      warnedLocalUnavailable = true;
      continue;
    }

    const hits = await searchHtmlEndpoint(url, "searxng", maxResults, signal, flaresolverrUrl);
    if (hits.length > 0) return hits;
    warnedLocalUnavailable = true;
  }
  return [];
}

async function searchMojeek(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, "mojeek", maxResults, signal, flaresolverrUrl);
}

async function searchYandex(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://yandex.com/search/?text=${encodeURIComponent(query)}`, "yandex", maxResults, signal, flaresolverrUrl);
}

async function searchYouTube(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchInnerTube(query, maxResults, signal);
}

/** HTML-parse fallback used when a paid JSON API returns nothing. Runs the
 * engine's public search page through the normal direct→Decodo→FlareSolverr
 * tiers while keeping `source` so health/learning attribution stays correct. */
async function apiFallbackViaHtml(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  source: "serper" | "brave-api",
  flaresolverrUrl?: string,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) return [];
  const url =
    source === "serper"
      ? `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14&hl=en&num=${maxResults}`
      : `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  return searchHtmlEndpoint(url, source, maxResults, signal, flaresolverrUrl);
}

// Bing HTML results embed the real target as a base64 `u=` query param inside
// https://www.bing.com/ck/a? links. Decode it to get the actual destination URL.
function decodeBingTarget(href: string): string | null {
  try {
    const url = new URL(href.replace(/&amp;/g, "&"));
    if (url.hostname !== "www.bing.com" && !url.hostname.endsWith(".bing.com")) return href.startsWith("http") ? href : null;
    const encoded = url.searchParams.get("u");
    if (!encoded) return null;
    // YouTube/Bing encodes as "a1" + base64. Strip prefix and ignore relative refs.
    const b64 = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    if (b64.startsWith("L2")) return null; // /images/, /videos/, /maps/ internal refs
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return decoded.startsWith("http") ? decoded : null;
  } catch {
    return null;
  }
}

async function searchBing(query: string, maxResults: number, signal: AbortSignal, flaresolverrUrl?: string): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const queue = engineQueues["bing"] || new EngineQueue(4000);
  return queue.run(async () => {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}&setlang=en`;
    const parse = (html: string): ReadonlyArray<SearchHit> => {
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      // Each result is a <li class="b_algo"> block with <h2><a href target>title</a></h2>
      // plus a <p class="b_lineclamp..."> snippet.
      const algoRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
      let match: RegExpExecArray | null;
      while (hits.length < maxResults && (match = algoRe.exec(html)) !== null) {
        const block = match[0];
        const linkRe = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
        const lm = block.match(linkRe);
        if (!lm) continue;
        const real = decodeBingTarget(lm[1]);
        if (!real) continue;
        const title = stripHtml(lm[2]);
        const capRe = block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
        const snippet = capRe ? stripHtml(capRe[1]) : "";
        const key = normaliseUrl(real);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hits.push({ url: real, title, snippet, discoveredBy: "bing" });
      }
      return dedupeHits(hits, maxResults);
    };

    try {
      const response = await fetchPage(bingUrl, signal);
      const directHits = parse(response.html);
      if (directHits.length > 0) return directHits;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }

    // Tier A2: Decodo Web Scraping API — fetch the same Bing SERP server-side
    // when the local egress cannot reach www.bing.com (TCP-blocked network).
    if (isDecodoConfigured() && !signal.aborted) {
      try {
        const decodoHtml = await fetchViaDecodo(bingUrl, signal);
        if (decodoHtml) {
          const decodoHits = parse(decodoHtml);
          if (decodoHits.length > 0) return decodoHits;
        }
      } catch (decodoError: unknown) {
        if (decodoError instanceof DOMException && decodoError.name === "AbortError") throw decodoError;
        console.warn(`[bing Tier A2] Decodo search fallback failed for "${bingUrl.slice(0, 80)}": ${decodoError instanceof Error ? decodoError.message : String(decodoError)}`);
      }
    }

    // Tier B: FlareSolverr search fallback (WAF bypass)
    if (flaresolverrUrl && flaresolverrUrl.trim() !== "" && !signal.aborted) {
      try {
        const fsHtml = await fetchWithWaterfall(bingUrl, signal, flaresolverrUrl);
        if (fsHtml) {
          const fsHits = parse(fsHtml);
          if (fsHits.length > 0) return fsHits;
        }
      } catch (fsError: unknown) {
        if (fsError instanceof DOMException && fsError.name === "AbortError") throw fsError;
        console.warn(`[bing Tier B] FlareSolverr search fallback failed for "${bingUrl.slice(0, 80)}": ${fsError instanceof Error ? fsError.message : String(fsError)}`);
      }
    }

    return [];
  });
}

const INNERTUBE_SEARCH_URL = "https://www.youtube.com/youtubei/v1/search";
const INNERTUBE_WEB_CLIENT = {
  client: {
    clientName: "WEB",
    clientVersion: "2.20240814.00.00",
    hl: "en",
    gl: "US",
  },
};

function collectVideoRenderer(node: any, sink: (renderer: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (node.videoRenderer) sink(node.videoRenderer);
  for (const value of Object.values(node)) collectVideoRenderer(value, sink);
}

// YouTube's HTML results page is JS-rendered (only relative /watch?v= links that
// parseSearchLinks skips). POST to the innerTube search endpoint instead with the
// same WEB client that the web page uses — returns real video results.
async function searchInnerTube(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const queue = engineQueues["youtube"] || new EngineQueue(3000);
  return queue.run(async () => {
    try {
      const pageRes = await fetchQueryPage("https://www.youtube.com/results?search_query=deep+learning", signal);
      if (!pageRes) return [];
      const keyMatch = pageRes.html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (!keyMatch) return [];
      const apiKey = keyMatch[1];

      const res = await fetch(`${INNERTUBE_SEARCH_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...buildBrowserHeaders(INNERTUBE_SEARCH_URL),
        },
        body: JSON.stringify({ context: INNERTUBE_WEB_CLIENT, query }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as Record<string, any>;

      const out: SearchHit[] = [];
      const seen = new Set<string>();
      collectVideoRenderer(data, (v: any) => {
        if (out.length >= maxResults) return;
        const id = v.videoId;
        if (!id || seen.has(id)) return;
        seen.add(id);
        const title = v.title?.runs?.[0]?.text ?? "";
        const owner = v.ownerText?.runs?.[0]?.text ?? "";
        const published = v.publishedTimeText?.simpleText ?? "";
        const lengthText = v.lengthText?.simpleText ?? "";
        const desc =
          v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: any) => r.text ?? "").join("") ??
          v.descriptionSnippet?.runs?.map((r: any) => r.text ?? "").join("") ??
          "";
        if (!id || !title) return;
        out.push({
          url: `https://www.youtube.com/watch?v=${id}`,
          title,
          snippet: [desc, owner, published, lengthText].filter(Boolean).join(" · "),
          discoveredBy: "youtube",
        });
      });
      return dedupeHits(out, maxResults);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return [];
    }
  });
}

async function fetchQueryPage(url: string, signal: AbortSignal): Promise<{ html: string } | null> {
  try {
    const response = await fetch(url, {
      signal,
      redirect: "follow",
      headers: buildBrowserHeaders(url),
    });
    if (!response.ok) return null;
    return { html: await response.text() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

export async function multiEngineSearch(
  query: string,
  maxResults: number,
  engines: ReadonlyArray<SearchEngine>,
  signal: AbortSignal,
  limiterFactory: LimiterFactory = () => new DdgRateLimiter(4000),
  timeRange = "all",
  options: SearchEngineOptions = {},
  timeoutMs: number = MULTI_ENGINE_CAP_MS,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  let capTimer: NodeJS.Timeout | null = null;
  const cap = new Promise<never>((_, reject) => {
    capTimer = setTimeout(
      () => reject(new Error(`Engine search cap exceeded (${timeoutMs}ms) for "${query.slice(0, 60)}"`)),
      timeoutMs,
    );
    if (typeof capTimer.unref === "function") capTimer.unref();
  });

  try {
    return await Promise.race([
      multiEngineSearchInner(query, maxResults, engines, signal, limiterFactory, timeRange, options),
      cap,
    ]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
}

/** Hard ceiling on one multi-engine round so a hung engine can't stall a worker. */
const MULTI_ENGINE_CAP_MS = 30_000;

async function multiEngineSearchInner(
  query: string,
  maxResults: number,
  engines: ReadonlyArray<SearchEngine>,
  signal: AbortSignal,
  limiterFactory: LimiterFactory,
  timeRange: string,
  options: SearchEngineOptions,
): Promise<ReadonlyArray<SearchHit>> {
  const selectedEngines = Array.from(new Set(engines.filter((engine): engine is SearchEngine => !!engine)));
  if (selectedEngines.length === 0 || maxResults <= 0) return [];

  const perEngineLimit = Math.max(1, Math.ceil(maxResults / selectedEngines.length));

  const results = await Promise.all(
    selectedEngines.map(async (engine): Promise<ReadonlyArray<SearchHit>> => {
      try {
        switch (engine) {
          case "ddg": {
            const limiter = limiterFactory();
            // Serialize DDG across every worker: without this, 12 workers can
            // fire the same-engine queries within milliseconds and trip the 202
            // rate-limit page. The global pacer spaces them per ENGINE.
            return globalEnginePacer.schedule("ddg", ENGINE_PACE_MIN_INTERVAL_MS, () =>
              searchDDG(query, perEngineLimit, "moderate", signal, limiter, timeRange, options.flaresolverrUrl),
            );
          }
          case "bing": return searchBing(query, perEngineLimit, signal, options.flaresolverrUrl);
          case "brave": return searchBrave(query, perEngineLimit, signal, options.flaresolverrUrl);
          case "google": return searchGoogle(query, perEngineLimit, signal, options.flaresolverrUrl);
          case "scholar": return searchGoogleScholar(query, perEngineLimit, signal, options.flaresolverrUrl);
          case "searxng":
            // Concurrency is capped inside searchSearxLocal by a 2-slot
            // semaphore. Wrapping this in the serialized pacer defeated that
            // cap and caused 30s queue timeouts across nine workers.
            return searchSearxng(query, perEngineLimit, signal, options.flaresolverrUrl, options.searxngUrl);
          case "mojeek": return searchMojeek(query, perEngineLimit, signal, options.flaresolverrUrl);
          case "yandex": return searchYandex(query, perEngineLimit, signal, options.flaresolverrUrl);
          case "youtube": return searchYouTube(query, perEngineLimit, signal);
          case "serper": {
            if (!options.serperApiKey) return [];
            const apiHits = await searchSerper(query, perEngineLimit, options.serperApiKey, signal, limiterFactory());
            if (apiHits.length > 0 || !isDecodoConfigured()) return apiHits;
            return apiFallbackViaHtml(query, perEngineLimit, signal, "serper", options.flaresolverrUrl);
          }
          case "brave-api": {
            if (!options.braveApiKey) return [];
            const apiHits = await searchBraveApi(query, perEngineLimit, options.braveApiKey, signal, limiterFactory());
            if (apiHits.length > 0 || !isDecodoConfigured()) return apiHits;
            return apiFallbackViaHtml(query, perEngineLimit, signal, "brave-api", options.flaresolverrUrl);
          }
          case "openalex": return searchOpenAlex(query, perEngineLimit, signal);
          case "crossref": return searchCrossref(query, perEngineLimit, signal);
          case "arxiv": return searchArxiv(query, perEngineLimit, signal);
          case "gdelt": return searchGdelt(query, perEngineLimit, signal);
          case "rss":
            return options.rssFeedUrls && options.rssFeedUrls.length > 0
              ? searchRssFeeds([...options.rssFeedUrls], query, perEngineLimit, signal)
              : [];
          case "telegram":
            return options.telegramChannels && options.telegramChannels.length > 0
              ? searchTelegram([...options.telegramChannels], query, perEngineLimit, signal)
              : [];
          case "reference": return searchReferenceSites(query, perEngineLimit, signal);
          default: return [];
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return [];
      }
    }),
  );

  return dedupeHits(results.flat(), maxResults);
}