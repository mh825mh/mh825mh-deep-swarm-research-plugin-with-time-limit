import { describe, it, expect } from "vitest";
import {
  isYouTubeUrl,
  extractYouTubeVideoId,
  buildYouTubePage,
} from "../src/net/youtube-extractor";

const ID = "ohW3H6E6XYs";

describe("isYouTubeUrl", () => {
  it("matches the YouTube host variants", () => {
    expect(isYouTubeUrl(`https://youtu.be/${ID}`)).toBe(true);
    expect(isYouTubeUrl(`https://youtu.be/${ID}?si=lY1W2frB6lkP7ArA`)).toBe(true);
    expect(isYouTubeUrl(`https://www.youtube.com/watch?v=${ID}`)).toBe(true);
    expect(isYouTubeUrl(`https://m.youtube.com/watch?v=${ID}`)).toBe(true);
    expect(isYouTubeUrl(`https://www.youtube.com/shorts/${ID}`)).toBe(true);
    expect(isYouTubeUrl(`https://www.youtube.com/embed/${ID}`)).toBe(true);
    expect(isYouTubeUrl(`https://www.youtube.com/live/${ID}`)).toBe(true);
  });

  it("rejects unrelated hosts and unparseable input", () => {
    expect(isYouTubeUrl("https://example.com/watch?v=abc")).toBe(false);
    expect(isYouTubeUrl("https://notyoutube.com/watch?v=abc")).toBe(false);
    expect(isYouTubeUrl("https://vimeo.com/12345678901")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
    expect(isYouTubeUrl("")).toBe(false);
  });
});

describe("extractYouTubeVideoId", () => {
  it("extracts the id from every supported URL shape", () => {
    expect(extractYouTubeVideoId(`https://youtu.be/${ID}?si=lY1W2frB6lkP7ArA`)).toBe(ID);
    expect(extractYouTubeVideoId(`https://youtu.be/${ID}/`)).toBe(ID);
    expect(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}&t=42`)).toBe(ID);
    expect(extractYouTubeVideoId(`https://www.youtube.com/shorts/${ID}?feature=share`)).toBe(ID);
    expect(extractYouTubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(extractYouTubeVideoId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
  });

  it("rejects URLs with no usable 11-character id", () => {
    expect(extractYouTubeVideoId("https://youtu.be/")).toBeNull();
    expect(extractYouTubeVideoId("https://youtu.be/short")).toBeNull();
    expect(extractYouTubeVideoId("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=")).toBeNull();
    expect(extractYouTubeVideoId("garbage")).toBeNull();
  });
});

describe("buildYouTubePage", () => {
  const data = {
    title: "A title",
    description: "A description",
    text: "[00:01] one\n[00:05] two\n[00:09] three\n[00:12] four",
  };

  it("maps transcript data onto the shared ExtractedPage shape", () => {
    const p = buildYouTubePage("https://youtu.be/x", data, 200, 1);
    expect(p.url).toBe("https://youtu.be/x");
    expect(p.finalUrl).toBe("https://youtu.be/x");
    expect(p.title).toBe("A title");
    expect(p.description).toBe("A description");
    expect(p.published).toBeNull();
    expect(p.outlinks).toEqual([]);
    expect(p.text).toBe(data.text);
    expect(p.totalPages).toBe(1);
    expect(p.wordCount).toBeGreaterThan(0);
  });

  it("chunks on line boundaries and reports totalPages", () => {
    const long = Array.from({ length: 40 }, (_, i) => `[00:${i}] line number ${i}`).join("\n");
    const limit = 120;
    const total = buildYouTubePage("https://youtu.be/x", { ...data, text: long }, limit, 1);
    expect(total.totalPages).toBeGreaterThan(1);

    for (let page = 1; page <= total.totalPages; page++) {
      const p = buildYouTubePage("https://youtu.be/x", { ...data, text: long }, limit, page);
      expect(p.page).toBe(page);
      // Every chunk must start on a whole transcript line, never mid-line.
      expect(p.text.startsWith("[00:")).toBe(true);
      // No line may be silently dropped between adjacent pages.
      expect(p.text.length).toBeGreaterThan(0);
    }

    // Concatenating all pages must reconstruct the transcript exactly.
    const joined = Array.from({ length: total.totalPages }, (_, idx) =>
      buildYouTubePage("https://youtu.be/x", { ...data, text: long }, limit, idx + 1).text,
    ).join("\n");
    expect(joined).toBe(long);
  });

  it("returns empty text past the end without crashing", () => {
    // A 20-char limit forces one 10-char line per chunk, so all 4 lines paginate.
    const p = buildYouTubePage("https://youtu.be/x", data, 20, 99);
    expect(p.text).toBe("");
    expect(p.wordCount).toBe(0);
    expect(p.totalPages).toBe(4);
  });

  it("handles an empty transcript and falls back to the url for a title", () => {
    const p = buildYouTubePage(
      "https://youtu.be/x",
      { title: "", description: "", text: "" },
      1000,
      1,
    );
    expect(p.text).toBe("");
    expect(p.totalPages).toBe(1);
    expect(p.title).toBe("https://youtu.be/x");
  });
});
