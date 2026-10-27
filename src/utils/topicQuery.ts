/**
 * @file utils/topicQuery.ts
 * Deterministic query hygiene for the non-LLM planner.
 *
 * Long research prompts (25+ words) are fine for the model, but they are toxic
 * for keyless JSON APIs (OpenAlex/Wikipedia) and HTML scrapers (DDG/SearXNG),
 * and they break when we append operators/years on top. These helpers keep the
 * core entity terms, strip search operators and framing words, and hard-cap the
 * number of keywords.
 */

/** Search operators that must never be carried into a deterministic query. */
const OPERATOR_RE = /\b(?:site|inurl|intitle|filetype):[^\s)]+/gi;

/**
 * Framing / generic words that add noise to a topic-derived query. This is the
 * union of the planner's stopwords and the "core mechanisms / evidence /
 * primary sources" scaffolding common in long research prompts.
 */
const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than",
  "of", "in", "on", "at", "to", "for", "from", "with", "without", "by", "as",
  "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "their", "there", "here",
  "what", "which", "who", "whom", "whose", "why", "when", "where", "how",
  "does", "do", "did", "can", "could", "should", "would", "will", "may", "might", "must",
  "about", "into", "over", "under", "between", "across", "during", "before", "after",
  "above", "below", "up", "down", "out", "off", "again", "further", "once",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "too", "very", "just", "also",
  // Prompt scaffolding
  "according", "tradition", "traditional", "characteristics", "traits",
  "overview", "core", "mechanism", "mechanisms", "evidence", "primary",
  "sources", "source", "expert", "analysis", "analyze", "competing", "views",
  "current", "state", "recent", "developments", "development", "latest",
  "new", "updates", "update", "key", "important", "main", "major", "role",
  "impact", "effects", "effect", "implications", "system", "systems", "based",
  "related", "around", "information", "findings", "data", "results", "result",
  "review", "reviews", "studies", "study", "research", "question", "questions",
  "issues", "issue", "aspects", "nature", "types", "trends", "examples",
  "reasons", "definition", "explained", "introduction", "guide",
  "hypothetical", "scenarios", "lead", "today", "now", "future", "potential",
  "next", "coming", "prospect", "forecast", "predict", "prediction", "emerging",
]);

function stripOperators(text: string): string {
  return text.replace(OPERATOR_RE, " ");
}

/**
 * Tokenize a topic/query: remove search operators, quotes, bullets, and
 * punctuation while preserving internal hyphens and digits.
 */
export function tokenizeTopicQuery(text: string): string[] {
  return stripOperators(text ?? "")
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^A-Za-z0-9-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length > 1)
    // Boolean glue left behind after stripping "(site:a OR site:b)".
    .filter((token) => !/^(and|or)$/i.test(token));
}

/**
 * Build a short entity-focused query (3–4 words is the useful range for
 * OpenAlex/Wikipedia and for DDG/SearXNG HTML result pages).
 */
export function buildCoreTopicQuery(topic: string, maxWords = 4): string {
  const tokens = tokenizeTopicQuery(topic);
  const salient = tokens.filter(
    (token) => token.length > 2 && !QUERY_STOPWORDS.has(token.toLowerCase()),
  );
  const picked = (salient.length > 0 ? salient : tokens).slice(0, Math.max(1, maxWords));

  if (picked.length > 0) return picked.join(" ");

  // Last-resort fallback so an all-stopword topic still produces a query.
  return (topic ?? "").trim().split(/\s+/).slice(0, Math.max(1, maxWords)).join(" ");
}

/** Hard-cap a query to `maxWords` keywords and strip operators/punctuation. */
export function capQueryKeywords(query: string, maxWords = 10): string {
  return tokenizeTopicQuery(query).slice(0, Math.max(1, maxWords)).join(" ");
}

/**
 * Compose a topic-derived query with a short deterministic suffix while keeping
 * the total keyword count at or below `maxWords`.
 */
export function buildSafeSearchQuery(
  topic: string,
  suffix: string,
  maxWords = 10,
): string {
  const suffixTokens = tokenizeTopicQuery(suffix);
  const coreBudget = Math.max(1, maxWords - suffixTokens.length);
  const core = buildCoreTopicQuery(topic, coreBudget);
  return capQueryKeywords([core, ...suffixTokens].join(" "), maxWords);
}
