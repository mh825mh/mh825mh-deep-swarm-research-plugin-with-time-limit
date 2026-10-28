/**
@file net/extractor.ts
Extracts clean structured content from raw HTML.
Uses Mozilla Readability as the primary extractor,
with a tag-stripping fallback for pages it cannot parse.
Aggressive boilerplate removal runs BEFORE Readability (nav, footer,
sidebar, cookie banners, ads, social widgets, comments). Outlink limit
is configurable and scales with the depth profile. Whitespace
normalization preserves paragraph structure.
*/
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { ExtractedPage, Outlink } from "../types";
import { stripInjection } from "./scrub";
import {
  DESCRIPTION_FALLBACK_CHARS,
  MIN_READABILITY_TEXT_LEN,
  OUTLINK_TEXT_MIN_LEN,
  OUTLINK_TEXT_MAX_LEN,
  FINGERPRINT_HEAD_WORDS,
  FINGERPRINT_MID_WORDS,
  FINGERPRINT_TAIL_WORDS,
} from "../constants";

const virtualConsole = new VirtualConsole();
virtualConsole.on("error", () => {});

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  hr: "---",
  bulletListMarker: "-",
});

const STRIP_BEFORE_PARSE_RE =
  /<style[\s\S]*?<\/style>|<link[^>]+rel=["']stylesheet["'][^>]*>/gi;

const BOILERPLATE_SELECTORS: ReadonlyArray<string> = [
  "nav", "header", "footer", ".nav", ".navbar", ".navigation", ".header",
  ".footer", ".sidebar", ".side-bar", ".widget", ".cookie-banner",
  ".cookie-consent", ".cookie-notice", ".gdpr", ".consent", ".popup",
  ".modal", ".overlay", ".ad", ".ads", ".advertisement", ".advert",
  ".banner-ad", ".social-share", ".social-links", ".share-buttons",
  ".sharing", ".related-posts", ".related-articles", ".recommended",
  ".comments", ".comment-section", "#comments", ".newsletter", ".subscribe",
  ".subscription", ".signup", ".sign-up", ".breadcrumb", ".breadcrumbs",
  ".pagination", ".pager", ".menu", ".toc", ".table-of-contents",
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="complementary"]', '[aria-label*="cookie"]', '[class*="cookie"]',
  '[id*="cookie"]', '[class*="gdpr"]', '[class*="popup"]', '[class*="modal"]',
  '[class*="overlay"]', '[class*="sidebar"]', '[class*="footer"]',
  '[class*="header"]', '[class*="nav-"]', '[class*="ad-"]', '[class*="promo"]',
  "aside", "figcaption", "noscript", "iframe", ".paywall", ".meteredPaywall",
  ".subscription-wall", ".article-body-paywall", "#piano_wrapper",
  ".fancybox-overlay", ".mfp-wrap", ".tp-modal", ".newsletter-popup",
  ".email-subscribe", ".inline-signup", ".subscribe-modal", ".newsletter-signup",
  ".newsletter-container", ".mc-modal", ".cookie-wall", ".consent-wall",
  "#onetrust-consent-sdk",
];

function stripBoilerplate(doc: Document): void {
  const mediaSelectors = "img, picture, video, audio, svg, canvas, iframe, object, embed";
  doc.querySelectorAll(mediaSelectors).forEach((el) => el.remove());

  const hiddenSelectors = '[aria-hidden="true"], [style*="display:none"], [style*="display: none"], [style*="visibility:hidden"], [style*="opacity: 0"]';
  doc.querySelectorAll(hiddenSelectors).forEach((el) => el.remove());

  for (const selector of BOILERPLATE_SELECTORS) {
    try {
      const elements = doc.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        el.remove();
      }
    } catch {}
  }

  try {
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const style = (el as HTMLElement).getAttribute("style") ?? "";
      if (
        /display\s*:\s*none/i.test(style) ||
        /visibility\s*:\s*hidden/i.test(style)
      ) {
        el.remove();
      }
    }
  } catch {}
}

/**
 * Nodes removed from the cloned document immediately before Readability /
 * Turndown / chunking. These never contain evidence prose but bloat the token
 * budget and can carry prompt-injection payloads, so they are dropped
 * explicitly (in addition to the broader `stripBoilerplate` sweep).
 */
const HARD_STRIP_SELECTORS: ReadonlyArray<string> = [
  "script",
  "style",
  "noscript",
  "svg",
  "nav",
  "footer",
  "header",
];

function stripNonContentNodes(doc: Document | Element): void {
  for (const selector of HARD_STRIP_SELECTORS) {
    try {
      for (const el of Array.from(doc.querySelectorAll(selector))) el.remove();
    } catch {
      /* ignore unsupported selector */
    }
  }
}

const DEFAULT_MAX_OUTLINKS = 40;

export function extractPage(
  html: string,
  sourceUrl: string,
  finalUrl: string,
  contentLimit: number,
  maxOutlinks: number = DEFAULT_MAX_OUTLINKS,
  page: number = 1,
): ExtractedPage {
  // Check if html is empty to prevent JSDOM from throwing
  if (!html) html = "<html><body></body></html>";

  const cleanedHtml = html.replace(STRIP_BEFORE_PARSE_RE, "");
  const dom = new JSDOM(cleanedHtml, { url: finalUrl, virtualConsole });
  const doc = dom.window.document;

  stripBoilerplate(doc);

  const title = extractTitle(doc);
  const description = extractDescription(doc);
  const published = extractPublishedDate(doc, finalUrl);
  const outlinks = extractOutlinks(doc, finalUrl, maxOutlinks);
  const { text, totalLength } = extractText(doc, html, contentLimit, page);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  dom.window.close();

  return {
    url: sourceUrl,
    finalUrl,
    title,
    description: description || text.slice(0, DESCRIPTION_FALLBACK_CHARS),
    published,
    text,
    wordCount,
    outlinks,
    page,
    totalPages: Math.ceil(Math.max(1, totalLength) / contentLimit),
  };
}

function extractTitle(doc: Document): string {
  return (
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.title?.trim() ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    ""
  );
}

function extractDescription(doc: Document): string {
  return (
    doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ||
    ""
  );
}

const DATE_META_SELECTORS: ReadonlyArray<string> = [
  'meta[property="article:published_time"]',
  'meta[name="date"]',
  'meta[name="pubdate"]',
  'meta[name="DC.date"]',
  'meta[itemprop="datePublished"]',
  'time[itemprop="datePublished"]',
  "time[datetime]",
];

const URL_DATE_RE = /(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])/;

function extractPublishedDate(doc: Document, url: string): string | null {
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    try {
      const data = JSON.parse(script.textContent ?? "{}") as Record<string, unknown>;
      const raw = data["datePublished"] ?? data["dateModified"] ?? data["uploadDate"];
      if (typeof raw === "string") return toIsoDate(raw);
    } catch {
      /* skip malformed JSON-LD */
    }
  }

  for (const selector of DATE_META_SELECTORS) {
    const el = doc.querySelector(selector);
    const val = el?.getAttribute("content") ?? el?.getAttribute("datetime");
    if (val) {
      const parsed = toIsoDate(val);
      if (parsed) return parsed;
    }
  }

  const m = URL_DATE_RE.exec(url);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function toIsoDate(raw: string): string | null {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function extractText(
  doc: Document,
  rawHtml: string,
  limit: number,
  page: number,
): { text: string; totalLength: number } {
  const start = (page - 1) * limit;
  const end = start + limit;

  try {
    const cloned = doc.cloneNode(true) as Document;
    // Drop non-content nodes from the clone before Readability/Turndown sees it.
    stripNonContentNodes(cloned);
    const article = new Readability(cloned, {
      classesToPreserve: ["table", "data-table", "code", "pre", "highlight", "math", "latex", "language-"],
      charThreshold: 100,
    }).parse();

    if (article?.content) {
      const markdown = turndownService.turndown(article.content);
      const cleaned = markdown
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (cleaned.length > MIN_READABILITY_TEXT_LEN) {
        const scrubbed = stripInjection(cleaned);
        return { text: scrubbed.slice(start, end), totalLength: scrubbed.length };
      }
    }
  } catch {
    /* fall through */
  }

  // BUGFIX: Use optional chaining and fallback to avoid crashing on null `doc.body`
  const fallbackHtml = doc.body?.innerHTML || doc.documentElement?.innerHTML || "";
  
  const stripped = fallbackHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const scrubbed = stripInjection(stripped);
  return { text: scrubbed.slice(start, end), totalLength: scrubbed.length };
}

function extractOutlinks(
  doc: Document,
  baseUrl: string,
  maxOutlinks: number = DEFAULT_MAX_OUTLINKS,
): ReadonlyArray<Outlink> {
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    baseHost = "";
  }

  const seen: Set<string> = new Set();
  const links: Outlink[] = [];

  for (const el of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (links.length >= maxOutlinks) break;
    const href = el.href;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!href.startsWith("http")) continue;
    if (seen.has(href)) continue;
    if (text.length < OUTLINK_TEXT_MIN_LEN || text.length > OUTLINK_TEXT_MAX_LEN) continue;
    try {
      if (new URL(href).hostname === baseHost) continue;
    } catch {
      continue;
    }
    seen.add(href);
    links.push({ text, href });
  }
  return links;
}

export function contentFingerprint(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length <= FINGERPRINT_HEAD_WORDS + FINGERPRINT_MID_WORDS + FINGERPRINT_TAIL_WORDS) {
    return words.join(" ");
  }
  const head = words.slice(0, FINGERPRINT_HEAD_WORDS);
  const midStart = Math.floor((words.length - FINGERPRINT_MID_WORDS) / 2);
  const mid = words.slice(midStart, midStart + FINGERPRINT_MID_WORDS);
  const tail = words.slice(-FINGERPRINT_TAIL_WORDS);
  return [...head, ...mid, ...tail].join(" ");
}

const RELEVANCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "how", "what", "why", "when",
  "are", "was", "were", "you", "your", "this", "its", "them", "they", "about",
  "into", "which", "their", "there", "where", "will", "would", "can", "could",
  "does", "over", "under", "also", "much", "many", "more", "than", "then",
  "his", "her", "him", "who", "but", "not", "via", "per", "etc",
]);

export function computeRelevance(
  text: string,
  title: string,
  snippet: string,
  topicKws: ReadonlyArray<string>,
  query?: string,
): number {
  if (topicKws.length === 0) return 0.5;

  const lowerText = text.toLowerCase();
  const lowerHaystack = `${text} ${title} ${snippet}`.toLowerCase();
  const lowerKws = topicKws.map((k) => k.toLowerCase());

  // Core-term match ratio contributes 0.0-0.6. At least one core term is still
  // required so a completely unrelated page cannot score.
  const matchedKws = lowerKws.filter((kw) => lowerText.includes(kw));
  if (matchedKws.length === 0) return 0.0;
  const coreScore = 0.6 * (matchedKws.length / lowerKws.length);

  // Full query / dimension-term overlap contributes 0.0-0.4. This distributes
  // scores instead of clamping every on-topic page to 1.00.
  const queryTerms = new Set(
    (query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (term) => term.length > 2 && !RELEVANCE_STOPWORDS.has(term),
      ),
  );
  const queryMatches =
    queryTerms.size === 0
      ? 0
      : [...queryTerms].filter((term) => lowerHaystack.includes(term)).length;
  const queryScore =
    queryTerms.size === 0
      ? 0
      : 0.4 * (queryMatches / queryTerms.size);

  let score = coreScore + queryScore;

  // Penalize off-topic noise keywords (e.g., LLMs, SEO linkfarms, gaming streams)
  const noiseTerms = ["subscribe", "newsletter", "discord", "livestream", "affiliate link", "chatgpt", "large language model"];
  const noiseHits = noiseTerms.filter((term) => lowerText.includes(term)).length;
  if (noiseHits > 3) score *= 0.6;

  const wordCount = text.split(/\s+/).length;
  const urlCount = (text.match(/https?:\/\/[^\s)]+/g) || []).length;
  if (urlCount / Math.max(1, wordCount) > 0.05) score *= 0.4;

  // Keep a realistic ceiling; 1.00 was masking any ranking distinction.
  return Math.min(0.92, Math.max(0, score));
}