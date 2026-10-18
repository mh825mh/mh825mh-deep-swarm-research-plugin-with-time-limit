/**
 * @file scoring/heuristics.ts
 * Deterministic fast-path pre-filter for evidence snippets. Rejects obviously
 * unusable cards (too short, off-query, boilerplate/paywall) BEFORE they consume
 * an LLM critic call. Pure heuristics — no model, no network.
 */

import {
  BOILERPLATE_SIGNATURE_RE,
  HEURISTIC_HIGH_TIER_SCORE,
  HEURISTIC_MEDIUM_TIER_SCORE,
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

/** Lexical quality bucket used to decide whether a card is worth an LLM retry. */
export type LexicalTier = "high" | "medium" | "low";

export interface LexicalScore {
  /** 0..1 blended lexical score (topic coverage + substance). */
  readonly score: number;
  readonly tier: LexicalTier;
  /** Fraction of distinctive query tokens present in the snippet. */
  readonly overlap: number;
}

const TOKEN_RE = /[a-z0-9]+/gi;

function tokenize(value: string): string[] {
  return value.toLowerCase().match(TOKEN_RE) ?? [];
}

/** Distinctive query tokens (length > 3, deduped). */
function queryTokens(query: string): string[] {
  return Array.from(new Set(tokenize(query).filter((t) => t.length > 3)));
}

/** Fraction of distinctive query tokens that appear in the snippet. */
function overlapRatio(item: HeuristicInput, tokens: ReadonlyArray<string>): number {
  if (tokens.length === 0) return 1;
  const haystack = new Set(tokenize(`${item.title ?? ""} ${item.text ?? ""}`));
  const matched = tokens.filter((t) => haystack.has(t)).length;
  return matched / tokens.length;
}

function tierFor(score: number): LexicalTier {
  if (score >= HEURISTIC_HIGH_TIER_SCORE) return "high";
  if (score >= HEURISTIC_MEDIUM_TIER_SCORE) return "medium";
  return "low";
}

/**
 * Deterministic lexical quality score — a cheap BM25-flavoured ranking of how
 * much substantive, on-topic text a snippet contains. Blends topic-token
 * coverage with a saturating substance term so a long wall of navigation text
 * can never outrank a shorter but precise passage. No model, no network.
 */
export function lexicalScore(item: HeuristicInput): LexicalScore {
  const tokens = queryTokens(item.query ?? "");
  const overlap = overlapRatio(item, tokens);
  const length = (item.text ?? "").trim().length;
  // Saturates at 4x the minimum length so 720+ chars score "full substance".
  const substance = Math.min(1, length / (HEURISTIC_MIN_TEXT_LEN * 4));
  const titleHit =
    tokens.length > 0 &&
    tokens.some((t) => (item.title ?? "").toLowerCase().includes(t))
      ? 0.1
      : 0;
  const score = Math.min(1, overlap * 0.65 + substance * 0.35 + titleHit);
  return { score, tier: tierFor(score), overlap };
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

  const tokens = queryTokens(item.query ?? "");
  if (tokens.length > 0) {
    const overlap = overlapRatio(item, tokens);
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
