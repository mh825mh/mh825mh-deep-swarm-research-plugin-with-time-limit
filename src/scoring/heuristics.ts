/**
 * @file scoring/heuristics.ts
 * Deterministic fast-path pre-filter for evidence snippets. Rejects obviously
 * unusable cards (too short, off-query, boilerplate/paywall) BEFORE they consume
 * an LLM critic call. Pure heuristics — no model, no network.
 */

import {
  BOILERPLATE_SIGNATURE_RE,
  HEURISTIC_MIN_KEYWORD_OVERLAP,
  HEURISTIC_MIN_TEXT_LEN,
} from "../constants";

export interface HeuristicInput {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly query: string;
}

export interface HeuristicResult {
  readonly pass: boolean;
  readonly reason?: string;
}

const TOKEN_RE = /[a-z0-9]+/gi;

function tokenize(value: string): string[] {
  return value.toLowerCase().match(TOKEN_RE) ?? [];
}

/**
 * Applies the three deterministic gates in order of cost:
 *   1. min length  — reject snippets shorter than HEURISTIC_MIN_TEXT_LEN.
 *   2. boilerplate — reject paywall / bot-wall signatures.
 *   3. overlap     — reject when query-keyword overlap is below the threshold.
 */
export function passesHeuristicFilter(item: HeuristicInput): HeuristicResult {
  const text = (item.text ?? "").trim();

  if (text.length < HEURISTIC_MIN_TEXT_LEN) {
    return {
      pass: false,
      reason: `too short (${text.length} < ${HEURISTIC_MIN_TEXT_LEN} chars)`,
    };
  }

  if (BOILERPLATE_SIGNATURE_RE.test(`${item.title ?? ""} ${text}`)) {
    return { pass: false, reason: "boilerplate/paywall signature detected" };
  }

  const queryTokens = Array.from(
    new Set(tokenize(item.query ?? "").filter((t) => t.length > 3)),
  );
  if (queryTokens.length > 0) {
    const haystack = new Set(tokenize(`${item.title ?? ""} ${text}`));
    const matched = queryTokens.filter((t) => haystack.has(t)).length;
    const overlap = matched / queryTokens.length;
    if (overlap < HEURISTIC_MIN_KEYWORD_OVERLAP) {
      return {
        pass: false,
        reason: `query overlap ${(overlap * 100).toFixed(0)}% < ${(
          HEURISTIC_MIN_KEYWORD_OVERLAP * 100
        ).toFixed(0)}%`,
      };
    }
  }

  return { pass: true };
}
