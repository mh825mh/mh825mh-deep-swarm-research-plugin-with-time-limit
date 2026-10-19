// src/swarm/pluginBridgeAndPacer.ts
// Three run-safety helpers in one module:
//   1. EngineRequestPacer  — per-engine serialized pacing so parallel workers
//      never burst a free search engine within milliseconds of each other
//      (the classic HTTP 202 / WAF-ban trigger).
//   2. Sibling plugin cache bridge — reads the local cache directories of
//      other LM Studio plugins (telegram-rag-cache, rss-rag-cache,
//      persistent-memory) so DeepResearch can seed evidence from data the
//      user's other plugins already scraped instead of stalling on live
//      RSS/Telegram fetches.
//   3. withHardTimeout — a bounded-time wrapper so a slow pass (e.g. FEEDS)
//      can never stall long enough to trip the 2-minute stall watchdog.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Minimum spacing applied between requests to the SAME engine (plus jitter). */
export const ENGINE_PACE_MIN_INTERVAL_MS = 1600;

/**
 * Per-engine serialized pacer. Each engine key gets its own FIFO chain of
 * tasks separated by `minIntervalMs` + 0-650ms of jitter, so N workers
 * querying DDG concurrently are spread out instead of fired simultaneously.
 */
export class EngineRequestPacer {
  private queues = new Map<string, Promise<void>>();
  private lastCallAt = new Map<string, number>();

  public async schedule<T>(
    engine: string,
    minIntervalMs: number,
    task: () => Promise<T>,
  ): Promise<T> {
    const prev = this.queues.get(engine) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(engine, prev.then(() => next));

    await prev;
    try {
      const now = Date.now();
      const last = this.lastCallAt.get(engine) ?? 0;
      const jitter = Math.floor(Math.random() * 650);
      const waitMs = Math.max(0, last + minIntervalMs + jitter - now);
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      this.lastCallAt.set(engine, Date.now());
      return await task();
    } finally {
      release();
    }
  }
}

export const globalEnginePacer = new EngineRequestPacer();

/**
 * One cached entry recovered from a sibling plugin's local store.
 */
export interface SiblingCacheHit {
  sourcePlugin: "telegram-rag-cache" | "rss-rag-cache" | "persistent-memory";
  title: string;
  url: string;
  content: string;
  timestamp?: string;
  score: number;
}

/** Bound the synchronous run-start scan so a huge sibling cache can't block. */
const MAX_SIBLING_FILE_BYTES = 2_000_000;
const MAX_SIBLING_FILES = 300;

const HOME = os.homedir();
const DEFAULT_SIBLING_PATHS: Record<SiblingCacheHit["sourcePlugin"], string[]> = {
  "telegram-rag-cache": [
    path.join(HOME, ".telegram-rag-cache"),
    path.join(HOME, ".lmstudio", "plugin-data", "mh825-telegram-rag-cache"),
    path.join(HOME, ".deep-swarm-research", "telegram-cache"),
  ],
  "rss-rag-cache": [
    path.join(HOME, ".rss-rag-cache"),
    path.join(HOME, ".lmstudio", "plugin-data", "mh825-rss-rag-cache"),
    path.join(HOME, ".deep-swarm-research", "rss-cache"),
  ],
  "persistent-memory": [
    path.join(HOME, ".persistent-memory"),
    path.join(HOME, ".lmstudio", "plugin-data", "khtsly-persistent-memory"),
  ],
};

/**
 * Keyword-match query over the sibling plugins' local caches. Synchronous and
 * cheap: missing directories are skipped via existsSync, malformed cache files
 * are ignored. `rootsOverride` exists for tests; production uses the defaults.
 */
export function querySiblingPluginCaches(
  queries: string[],
  maxResults = 10,
  rootsOverride?: Readonly<Partial<Record<SiblingCacheHit["sourcePlugin"], readonly string[]>>>,
): SiblingCacheHit[] {
  const terms = Array.from(
    new Set(
      queries
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3),
    ),
  );
  if (terms.length === 0) return [];

  const hits: SiblingCacheHit[] = [];

  for (const pluginName of Object.keys(DEFAULT_SIBLING_PATHS) as Array<SiblingCacheHit["sourcePlugin"]>) {
    const candidateDirs = rootsOverride?.[pluginName] ?? DEFAULT_SIBLING_PATHS[pluginName];
    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = walkJsonAndMdFiles(dir, 2);
      for (const file of files) {
        try {
          if (fs.statSync(file).size > MAX_SIBLING_FILE_BYTES) continue;
          const raw = fs.readFileSync(file, "utf-8");
          const lower = raw.toLowerCase();
          let matchedTerms = 0;
          for (const term of terms) {
            if (lower.includes(term)) matchedTerms++;
          }
          const score = matchedTerms / terms.length;
          if (score < 0.25) continue;

          if (file.endsWith(".json")) {
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed)
              ? parsed
              : parsed.items ?? parsed.entries ?? parsed.documents ?? parsed.memories ?? [parsed];
            for (const item of items) {
              const text = String(
                item.content ?? item.text ?? item.summary ?? item.body ?? "",
              ).trim();
              if (text.length < 60) continue;
              const itemLower = text.toLowerCase();
              const itemMatches = terms.filter((t) => itemLower.includes(t)).length;
              if (itemMatches === 0) continue;

              hits.push({
                sourcePlugin: pluginName,
                title: String(item.title ?? item.channel ?? path.basename(file)),
                url: String(
                  item.url ?? item.link ?? `local-plugin://${pluginName}/${path.basename(file)}`,
                ),
                content: text.slice(0, 6000),
                timestamp: item.timestamp ?? item.pubDate ?? item.createdAt,
                score: itemMatches / terms.length,
              });
            }
          } else {
            hits.push({
              sourcePlugin: pluginName,
              title: path.basename(file),
              url: `local-plugin://${pluginName}/${path.basename(file)}`,
              content: raw.slice(0, 6000),
              score,
            });
          }
        } catch {
          // Ignore malformed cache entries
        }
      }
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function walkJsonAndMdFiles(dir: string, maxDepth: number): string[] {
  if (maxDepth < 0) return [];
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= MAX_SIBLING_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkJsonAndMdFiles(full, maxDepth - 1));
      } else if (/\.(json|md|txt)$/i.test(entry.name)) {
        results.push(full);
      }
    }
  } catch {
    // Ignore permission errors
  }
  return results.slice(0, MAX_SIBLING_FILES);
}

/**
 * Hard timeout wrapper. Resolves with `fallbackValue` when `promise` has not
 * settled within `timeoutMs`, so a slow pass can never stall the pipeline into
 * the 2-minute watchdog. The underlying promise keeps running and its eventual
 * result is discarded (its own cleanup still runs).
 */
export async function withHardTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallbackValue: T,
  label: string,
  log?: (msg: string) => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          log?.(`[WARN] [${label}] Hard timeout (${timeoutMs}ms) reached — continuing pipeline.`);
          resolve(fallbackValue);
        }, timeoutMs);
        if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
