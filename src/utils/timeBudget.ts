/**
 * @file utils/timeBudget.ts
 * Wall-clock budget resolution for a research run.
 *
 * A session limit of `0` means "no user session limit", but the run is still
 * bounded by the selected LLM Call Mode runtime cap. Resolving that here (rather
 * than multiplying `0 * 0.8` at the call site) is what prevents a 0 ms crawl
 * budget from exiting the pipeline immediately after the Feeds pass.
 */

/** Mode cap used when the caller supplies an invalid/zero cap. */
export const FALLBACK_MODE_CAP_MS = 20 * 60 * 1000;

/** Fraction of the effective runtime reserved for crawling (20% for synthesis). */
export const CRAWL_FRACTION = 0.8;

/**
 * Resolve the wall-clock runtime for a run.
 *
 * - `sessionLimitMs <= 0`, `NaN`, or `Infinity` -> use the mode cap.
 * - otherwise -> `min(sessionLimitMs, modeCapMs)`.
 * - an invalid mode cap falls back to 20 minutes.
 */
export function resolveEffectiveRuntimeMs(
  sessionLimitMs: number,
  modeCapMs: number,
): number {
  const cap =
    Number.isFinite(modeCapMs) && modeCapMs > 0
      ? modeCapMs
      : FALLBACK_MODE_CAP_MS;

  if (!Number.isFinite(sessionLimitMs) || sessionLimitMs <= 0) return cap;
  return Math.min(sessionLimitMs, cap);
}

/** Crawl budget: 80% of the effective runtime, always a finite positive number. */
export function computeCrawlBudgetMs(
  sessionLimitMs: number,
  modeCapMs: number,
): number {
  return Math.floor(resolveEffectiveRuntimeMs(sessionLimitMs, modeCapMs) * CRAWL_FRACTION);
}
