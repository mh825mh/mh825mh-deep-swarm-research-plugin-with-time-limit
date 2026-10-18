// src/synthesis/verify.ts
// Independent citation verifier (item 6 + item 7). After synthesis, this
// checks that every `[n]` citation index written by the model maps to a real
// ledger card AND that any URL appearing in the synthesis equals a ledger
// card's canonical URL. This is the deterministic guardrail that makes
// "citations are keys into the ledger" true: the model can never invent a URL
// that survives the report.
import { CitationCheckResult } from "../types";

/** Card ids are `E<k>` where k is the 1-based index into the source array. */
const CARD_ID_RE = /^E(\d{1,3})$/i;

// Bare inline citation like [1] — the model is instructed to use "Exact Index
// Format" so unescaped brackets are authoritative.
const INLINE_CITE_RE = /(?<!\\)\[(\d{1,3})\]/g;
const URL_RE = /https?:\/\/[^\s)\]>"'`]+/gi;

export type VerifyLedgerEntry = {
  readonly id: string;
  readonly canonicalUrl: string;
  /** Resolved URL carried on the card; preferred for provenance comparison. */
  readonly sourceUrl?: string;
  /** `[n]` anchor the card expects the synthesis to use. */
  readonly citationAnchor?: string;
};

function indexOfCardId(id: string): number | null {
  const m = CARD_ID_RE.exec(id);
  return m ? parseInt(m[1], 10) : null;
}

function normalizeCompareUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    let host = u.hostname.replace(/^www\./, "").toLowerCase();
    let path = u.pathname;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}${u.search ? u.search.toLowerCase() : ""}`;
  } catch {
    return raw.trim();
  }
}

function extractInlineIndices(markdown: string): ReadonlyArray<number> {
  const indices: number[] = [];
  for (const m of markdown.matchAll(INLINE_CITE_RE)) {
    indices.push(parseInt(m[1], 10));
  }
  return indices;
}

/**
 * Verifies a synthesized report against the graded ledger. Returns PASS only
 * when every inline citation index resolves to a ledger card and every URL in
 * the markdown equals a ledger canonical URL.
 */
export function verifyCitations(
  markdown: string,
  ledger: ReadonlyArray<VerifyLedgerEntry>,
): CitationCheckResult {
  const cardIds = new Set(ledger.map((l) => l.id));
  // A card's provenance is its resolved (post-redirect) URL when present,
  // falling back to the canonical URL. Both are registered so a synthesis that
  // legitimately cites either form still resolves.
  const canonicalUrls = new Set<string>();
  for (const entry of ledger) {
    canonicalUrls.add(normalizeCompareUrl(entry.canonicalUrl));
    if (entry.sourceUrl) canonicalUrls.add(normalizeCompareUrl(entry.sourceUrl));
  }

  const orphanIndices: string[] = [];
  for (const n of extractInlineIndices(markdown)) {
    if (!cardIds.has(`E${n}`)) {
      orphanIndices.push(`E${n}`);
    }
  }

  const foreignUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const rawUrl of markdown.matchAll(URL_RE)) {
    const url = rawUrl[0].replace(/[.,;:!?]+$/, "");
    const key = normalizeCompareUrl(url);
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    if (!canonicalUrls.has(key)) {
      foreignUrls.push(url);
    }
  }

  return {
    pass: orphanIndices.length === 0 && foreignUrls.length === 0,
    orphanIndices: [...new Set(orphanIndices)],
    foreignUrls: [...new Set(foreignUrls)],
  };
}

/** Resolves a citation index to its ledger entry (1-based), if any. */
export function resolveCitation(
  index: number,
  ledger: ReadonlyArray<VerifyLedgerEntry>,
): VerifyLedgerEntry | undefined {
  return ledger.find((l) => l.id.toUpperCase() === `E${index}`);
}

export { indexOfCardId };