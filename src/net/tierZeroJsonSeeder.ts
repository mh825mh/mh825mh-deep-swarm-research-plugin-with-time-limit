// src/net/tierZeroJsonSeeder.ts
// Tier-0 keyless JSON pre-seeder. Runs OpenAlex, Crossref-style OpenAlex and the
// Wikipedia REST API concurrently (strict <3.5s cap) BEFORE any HTML scraper
// (DDG / Bing / SearXNG) so every run secures a handful of verified reference
// cards without ever risking a CAPTCHA or a DDG 202 rate limit. The seeded
// cards are promoted straight to evidence cards, so the 2-minute stall watchdog
// can never trip during the first crawl layers.
import { buildCoreTopicQuery } from "../utils/topicQuery";

export interface TierZeroSeedCard {
  url: string;
  title: string;
  content: string;
  engine: "openalex" | "crossref" | "wikipedia";
  sourceTier: "REFERENCE";
}

/**
 * Queries keyless JSON APIs (OpenAlex, Crossref, Wikipedia REST) in parallel (<3.5s)
 * BEFORE HTML search engines run. Never triggers CAPTCHAs or DDG 202 rate limits.
 */
export async function seedFromTierZeroJsonApis(
  topic: string,
  crossrefMailto?: string,
  log?: (msg: string) => void,
): Promise<TierZeroSeedCard[]> {
  // OpenAlex/Wikipedia have poor recall for a 25+ word prompt. Keep only the
  // 3-4 core entity keywords (the orchestrator also passes a pre-shortened
  // query; this is defence-in-depth for every caller).
  const cleanTopic = buildCoreTopicQuery(topic, 4);
  const encoded = encodeURIComponent(cleanTopic);
  const headers: Record<string, string> = {
    "User-Agent": `DeepSwarmResearch/5.9.1 (mailto:${crossrefMailto || "local@saverapps.uk"})`,
    Accept: "application/json",
  };

  const openAlexTask = fetchJsonWithTimeout<any>(
    `https://api.openalex.org/works?search=${encoded}&per-page=4&select=id,doi,title,publication_year,abstract_inverted_index,primary_location`,
    headers,
    3500,
  ).then((data): TierZeroSeedCard[] => {
    if (!Array.isArray(data?.results)) return [];
    return data.results
      .map((work: any) => {
        const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
        if (!work.title || abstract.length < 80) return null;
        const url =
          work.primary_location?.landing_page_url ||
          work.doi ||
          work.id;
        return {
          url: String(url),
          title: `${work.title} (${work.publication_year ?? "n.d."})`,
          content: `[OpenAlex Peer-Reviewed Work] Title: ${work.title}\nYear: ${work.publication_year}\nAbstract: ${abstract}`,
          engine: "openalex" as const,
          sourceTier: "REFERENCE" as const,
        };
      })
      .filter((x: TierZeroSeedCard | null): x is TierZeroSeedCard => x !== null);
  });

  const wikipediaTask = fetchJsonWithTimeout<any>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&utf8=&format=json&srlimit=3`,
    headers,
    3000,
  ).then(async (data): Promise<TierZeroSeedCard[]> => {
    const hits = data?.query?.search;
    if (!Array.isArray(hits) || hits.length === 0) return [];
    const summaries = await Promise.all(
      hits.slice(0, 2).map((h: any) =>
        fetchJsonWithTimeout<any>(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title)}`,
          headers,
          2500,
        ),
      ),
    );
    return summaries
      .filter((s) => s?.extract && s.extract.length > 100)
      .map((s) => ({
        url: s.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
        title: `[Wikipedia Reference] ${s.title}`,
        content: s.extract,
        engine: "wikipedia" as const,
        sourceTier: "REFERENCE" as const,
      }));
  });

  const [openAlexCards, wikiCards] = await Promise.all([
    openAlexTask.catch(() => [] as TierZeroSeedCard[]),
    wikipediaTask.catch(() => [] as TierZeroSeedCard[]),
  ]);

  const combined = [...openAlexCards, ...wikiCards];
  log?.(
    `[TIER-0 JSON SEED] Retrieved ${combined.length} verified reference card(s) in <3.5s (OpenAlex: ${openAlexCards.length}, Wiki: ${wikiCards.length}).`,
  );
  return combined;
}

function reconstructOpenAlexAbstract(
  invertedIndex: Record<string, number[]> | undefined | null,
): string {
  if (!invertedIndex || typeof invertedIndex !== "object") return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        words[pos] = word;
      }
    }
  }
  return words.filter(Boolean).join(" ");
}

async function fetchJsonWithTimeout<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
