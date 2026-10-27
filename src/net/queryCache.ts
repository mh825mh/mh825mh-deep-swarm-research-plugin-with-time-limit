/**
 * @file net/queryCache.ts
 * Two small run-scoped guards:
 *
 *   1. InRunQueryTracker — ensures each (engine, query) pair is attempted at
 *      most once per run, even when the same fallback query appears in the
 *      SEARXNG, DIRECT and API layers.
 *   2. sanitizeSearchQuery — strips evidence-card metadata ([OpenAlex ...],
 *      Title:, Abstract:, DOI:) before a failed claim is reused as a Critic
 *      retry query.
 */

/** Normalize a query for dedupe: case/whitespace insensitive. */
export function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Run-scoped (engine, query) claim registry. `shouldExecute()` is synchronous,
 * so it is safe across concurrently running workers in the same process.
 */
export class InRunQueryTracker {
  private readonly executed = new Set<string>();

  private key(engine: string, query: string): string {
    return `${engine.toLowerCase()}::${normalizeQueryKey(query)}`;
  }

  /** True if this pair has not run yet; marks it as executed when it returns true. */
  public shouldExecute(engine: string, query: string): boolean {
    const key = this.key(engine, query);
    if (this.executed.has(key)) return false;
    this.executed.add(key);
    return true;
  }

  /** Non-mutating check, useful for tests/diagnostics. */
  public hasRun(engine: string, query: string): boolean {
    return this.executed.has(this.key(engine, query));
  }

  public reset(): void {
    this.executed.clear();
  }

  public get size(): number {
    return this.executed.size;
  }
}

const SANITIZE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "from", "by", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "at", "into", "over",
]);

/**
 * Converts a raw claim/title into a short web-search query.
 *
 * Fixes Critic retries that appended full evidence-card metadata, e.g.
 * `[OpenAlex Peer-Reviewed Work] Title: ... Year: 2022 Abstract: In th...`.
 */
export function sanitizeSearchQuery(rawQuery: string, maxWords = 10): string {
  const cleaned = (rawQuery ?? "")
    // Bracketed metadata tags: [OpenAlex Peer-Reviewed Work], [Wiki], ...
    .replace(/\[[^\]]*\]/g, " ")
    // Metadata labels: everything after Abstract:/DOI:/URL:/Source: is dross.
    .replace(/\b(Abstract|DOI|URL|Source)\s*:[\s\S]*$/i, " ")
    .replace(/\b(Title|Year|Author|Authors)\s*:\s*/gi, " ")
    // Toxic boolean chains and year stuffing.
    .replace(/\(site:[^)]+\)/gi, " ")
    .replace(/\bsite:[^\s)]+/gi, " ")
    .replace(/\b202[4-9]\b/g, " ")
    // Punctuation that search engines treat as operators.
    .replace(/["'“”‘’():;,.!?—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of cleaned.split(" ")) {
    if (!word) continue;
    const lower = word.toLowerCase();
    if (lower.length < 2 || SANITIZE_STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    words.push(word);
    if (words.length >= Math.max(1, maxWords)) break;
  }

  return words.join(" ");
}
