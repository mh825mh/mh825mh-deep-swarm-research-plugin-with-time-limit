/**
 * @file utils/text.ts
 * Chunk-bounding helpers. Keeps evidence text compact and free of HTML
 * artifacts before it is fed to the LLM, which prevents KV-cache bloat from
 * oversized pages and noisy markup.
 */

import { EVIDENCE_CHUNK_MAX_CHARS } from "../constants";

const HTML_TAG_RE = /<[^>]*>/g;

/** Removes HTML tags, decodes a few common entities, and collapses whitespace. */
export function stripHtmlArtifacts(text: string): string {
  if (!text) return "";
  return text
    .replace(HTML_TAG_RE, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hard-caps an evidence chunk at `maxChars` (default 6,000 ≈ 1,500 tokens)
 * after stripping HTML artifacts and repetitive whitespace.
 */
export function boundEvidenceChunk(
  text: string,
  maxChars: number = EVIDENCE_CHUNK_MAX_CHARS,
): string {
  const cleaned = stripHtmlArtifacts(text);
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}
