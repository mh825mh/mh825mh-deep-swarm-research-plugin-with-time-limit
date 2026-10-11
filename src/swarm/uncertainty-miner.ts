/**
 * @file swarm/uncertainty-miner.ts
 * Epistemic uncertainty mining: reads a reasoning model's ` thinking` trace and
 * extracts the unresolved questions it flagged (e.g. "no data on X", "conflicts
 * with Y", "need to verify Z") so they can be converted into targeted follow-up
 * search queries.
 *
 * Pure and deterministic - no LLM call - so it can run on every round cheaply
 * and its output is unit-testable.
 */

/** Patterns that indicate the model flagged an epistemic gap. */
const UNCERTAINTY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:it is |is |remains )?unclear\b/i,
  /\bno (?:data|evidence|information|research|studies|sources?|literature|figures?)\b/i,
  /\black(?:s|ing|ed)?(?: of)? (?:data|evidence|information|research|studies|sources?|details|clarity)\b/i,
  /\bconflicts? with\b/i,
  /\bcontradict(?:s|ory|ion|ions|ed|ing)?\b/i,
  /\bneed(?:s|ed)? to (?:verify|confirm|check|validate|investigate|establish|determine|clarify)\b/i,
  /\b(?:insufficient|inadequate|limited|scarce|sparse) (?:evidence|data|information|research|studies|detail)\b/i,
  /\bcannot (?:be )?(?:determine|determined|confirm|confirmed|verify|verified|establish|established|ascertain|ascertained)\b/i,
  /\b(?:unresolved|unanswered|unknown|uncertain|uncertainty|open question)\b/i,
  /\b(?:difficult|hard|impossible) to (?:determine|establish|verify|confirm|assess)\b/i,
  /\bnot (?:clear|known|established|confirmed|verified|evident|documented)\b/i,
  /\b(?:further|more|additional) (?:research|investigation|data|evidence|study|studies|analysis|verification)\b/i,
  /\b(?:verify|verification|validate|validation) (?:is |was )?(?:needed|required|necessary)\b/i,
  /\bmust (?:verify|confirm|check|validate|investigate)\b/i,
  /\bquestion(?:s)? (?:remain|remains|remained)\b/i,
  /\b(?:disputed|questionable|dubious|debatable)\b/i,
  /\bneeds? (?:verification|checking|confirmation|corroboration)\b/i,
];

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "in",
  "on", "of", "and", "or", "for", "to", "how", "what", "why", "when", "where",
  "which", "who", "whom", "does", "do", "did", "with", "from", "that", "this",
  "these", "those", "could", "would", "should", "about", "their", "there",
  "here", "it", "its", "as", "at", "by", "if", "but", "not", "no", "whether",
  "may", "might", "can", "cannot", "need", "needs", "needed", "unclear", "data",
  "evidence", "information", "research", "study", "studies", "source", "sources",
  "claim", "claims", "conflict", "conflicts", "contradicts", "verify",
  "verification", "confirm", "unknown", "uncertain", "uncertainty", "further",
  "more", "additional", "insufficient", "limited", "lack", "lacks", "lacking",
  "question", "questions", "remain", "remains", "documented", "evident",
  "established", "disputed", "will", "also", "than", "then", "remains",
]);

const MAX_QUERIES = 8;
const MAX_QUERY_CHARS = 200;

/** Splits a reasoning trace into sentence/clause fragments. */
function splitClauses(thinkBlock: string): ReadonlyArray<string> {
  return thinkBlock
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Extracts the distinctive (non-stopword) terms from a clause. */
function distinctiveTerms(clause: string): string[] {
  return clause
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/**
 * Extracts unresolved-question search queries from a model's reasoning trace.
 *
 * @param thinkBlock Raw reasoning text (the contents of a ` thinking` block).
 * @param baseTopic  The run's research topic, prepended to each derived query.
 * @returns Deduped, length-capped search queries. Empty when nothing is flagged.
 */
export function extractUncertaintyQueries(
  thinkBlock: string,
  baseTopic: string,
): string[] {
  if (!thinkBlock || !thinkBlock.trim()) return [];
  const topic = (baseTopic || "").replace(/\s+/g, " ").trim();

  const queries: string[] = [];
  const seen = new Set<string>();

  for (const clause of splitClauses(thinkBlock)) {
    if (!UNCERTAINTY_PATTERNS.some((re) => re.test(clause))) continue;
    const terms = distinctiveTerms(clause);
    if (terms.length === 0) continue;

    // Keep the most specific clause terms; the topic anchors the query.
    const focused = terms.slice(0, 8).join(" ");
    const query = `${topic} ${focused}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_QUERY_CHARS);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= MAX_QUERIES) break;
  }

  return queries;
}
