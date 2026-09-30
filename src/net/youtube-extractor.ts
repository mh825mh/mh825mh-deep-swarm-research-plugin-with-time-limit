import { buildBrowserHeaders } from "./http";
import { ExtractedPage } from "../types";

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const ANDROID_CLIENT = {
  client: {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    hl: "en",
    gl: "US",
  },
};

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  );
}

export function isYouTubeUrl(url: string): boolean {
  try {
    return isYouTubeHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeVideoId(url: string): string | null {
  let id: string | null = null;
  try {
    const u = new URL(url);
    if (!isYouTubeHost(u.hostname)) return null;
    if (u.hostname.toLowerCase().endsWith("youtu.be")) {
      id = u.pathname.replace(/^\/+/, "").split(/[/?#]/)[0] || null;
    } else if (u.searchParams.has("v")) {
      id = u.searchParams.get("v");
    } else {
      const match = u.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (match) id = match[1];
    }
  } catch {
    return null;
  }
  if (!id) return null;
  const trimmed = id.trim();
  return VIDEO_ID_RE.test(trimmed) ? trimmed : null;
}

async function fetchInnerTube(
  videoId: string,
  signal: AbortSignal,
): Promise<Record<string, any> | null> {
  // Fetch the watch page to extract the INNERTUBE API key. YouTube gates the
  // legacy "captionTracks" blob on the page, but a fresh innerTube player POST
  // (ANDROID client) returns working timedtext URLs.
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageRes = await fetch(watchUrl, {
    signal,
    headers: buildBrowserHeaders(watchUrl),
  });
  if (!pageRes.ok) return null;
  const html = await pageRes.text();

  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const apiKey = keyMatch ? keyMatch[1] : undefined;
  if (!apiKey) return null;

  const res = await fetch(`${INNERTUBE_PLAYER_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...buildBrowserHeaders(INNERTUBE_PLAYER_URL),
    },
    body: JSON.stringify({ context: ANDROID_CLIENT, videoId }),
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, any>;
}

function pickTrack(tracks: any[]): any | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const manual = tracks.filter((t) => !t.kind || t.kind !== "asr");
  const pool = manual.length > 0 ? manual : tracks;
  return (
    pool.find((t) => t.languageCode === "en") ??
    pool.find((t) => t.languageCode === "en-US") ??
    pool[0] ??
    null
  );
}

function parseTranscriptXml(xml: string): { lines: string[] } | null {
  const lines: string[] = [];
  const regex = /<text start="([\d.]+)" dur="[\d.]+">([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const startSec = parseFloat(match[1]);
    const mins = Math.floor(startSec / 60).toString().padStart(2, "0");
    const secs = Math.floor(startSec % 60).toString().padStart(2, "0");
    const text = match[2]
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n/g, " ")
      .trim();

    if (text) lines.push(`[${mins}:${secs}] ${text}`);
  }

  return lines.length > 0 ? { lines } : null;
}

export async function extractYouTubeTranscript(
  url: string,
  signal: AbortSignal,
  maxChars: number = 6000,
): Promise<{ text: string; title: string; description: string } | null> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  try {
    const data = await fetchInnerTube(videoId, signal);
    if (!data) return null;

    const title = data?.videoDetails?.title ?? url;
    const description = (data?.videoDetails?.shortDescription ?? "").slice(0, 250);

    const fallbackText =
      description.slice(0, maxChars) || "No transcript or description available.";

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const track = pickTrack(tracks);
    if (!track?.baseUrl) {
      return {
        text: fallbackText,
        title,
        description,
      };
    }

    // YouTube adds &exp=xpe (proof-of-origin gating) to timedtext URLs it
    // refuses to serve anonymously; treat those like "no captions available".
    const baseUrl = String(track.baseUrl).replace("&fmt=srv3", "");
    if (baseUrl.includes("exp=xpe")) {
      return { text: fallbackText, title, description };
    }

    const capRes = await fetch(baseUrl, {
      signal,
      headers: buildBrowserHeaders(baseUrl),
    });
    if (!capRes.ok) return null;
    const xml = await capRes.text();

    const parsed = parseTranscriptXml(xml);
    if (!parsed) {
      return {
        text: description.slice(0, maxChars) || "Failed to parse transcript.",
        title,
        description,
      };
    }

    // maxChars is a ceiling on the whole transcript; page-level slicing happens
    // later in buildYouTubePage so a caller can walk the video in chunks.
    const kept: string[] = [];
    let total = 0;
    for (const line of parsed.lines) {
      if (total + line.length + 1 > maxChars) break;
      kept.push(line);
      total += line.length + 1;
    }

    return {
      text: kept.join("\n"),
      title,
      description,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}

/**
 * Wrap an extracted transcript in the shared ExtractedPage shape so every
 * consumer (swarm worker, Read Page, Multi-Read) sees one structure.
 *
 * Pages are cut on line boundaries, never mid-line, so a chunk never starts
 * with a truncated "[MM:SS] ..." fragment. A chunk may overshoot `contentLimit`
 * by up to one line in exchange for that guarantee.
 */
export function buildYouTubePage(
  url: string,
  data: { text: string; title: string; description: string },
  contentLimit: number,
  page: number = 1,
): ExtractedPage {
  const lines = data.text ? data.text.split("\n") : [];
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const added = currentLen === 0 ? line.length : currentLen + 1 + line.length;
    if (current.length > 0 && added > contentLimit) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = line.length;
    } else {
      current.push(line);
      currentLen = added;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  const totalPages = Math.max(1, chunks.length);
  const text = chunks[page - 1] ?? "";

  return {
    url,
    finalUrl: url,
    title: data.title || url,
    description: data.description || "",
    published: null,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    outlinks: [],
    page,
    totalPages,
  };
}