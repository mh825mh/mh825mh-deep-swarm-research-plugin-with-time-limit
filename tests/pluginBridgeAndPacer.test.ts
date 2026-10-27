import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EngineRequestPacer,
  querySiblingPluginCaches,
  withHardTimeout,
  type SiblingCacheHit,
} from "../src/swarm/pluginBridgeAndPacer";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sibling-cache-"));
}

describe("withHardTimeout", () => {
  it("passes through a value that settles before the timeout", async () => {
    const value = await withHardTimeout(Promise.resolve(42), 5_000, 0, "Test");
    expect(value).toBe(42);
  });

  it("returns the fallback and logs when the timeout fires", async () => {
    const logs: string[] = [];
    const value = await withHardTimeout(
      new Promise<string>(() => {}),
      20,
      "fallback",
      "Feeds",
      (m) => logs.push(m),
    );
    expect(value).toBe("fallback");
    expect(logs.join("\n")).toContain("Hard timeout");
  });

  it("propagates a rejection that settles before the timeout", async () => {
    await expect(
      withHardTimeout(Promise.reject(new Error("boom")), 5_000, "fb", "Test"),
    ).rejects.toThrow("boom");
  });

  it("resolves with the fallback when the work rejects after the timeout", async () => {
    const lateReject = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("late failure")), 40);
    });
    const value = await withHardTimeout(lateReject, 10, "fallback", "Feeds");
    expect(value).toBe("fallback");
    // Let the late rejection settle; Promise.race already attached a handler.
    await new Promise((r) => setTimeout(r, 60));
  });
});

describe("EngineRequestPacer", () => {
  it("serializes same-engine tasks and preserves order", async () => {
    const pacer = new EngineRequestPacer();
    const events: string[] = [];
    const make = (label: string) =>
      pacer.schedule("ddg", 0, async () => {
        events.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 25));
        events.push(`${label}:end`);
        return label;
      });

    const [a, b] = await Promise.all([make("A"), make("B")]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    // The first task must finish entirely before the second begins.
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("runs different engines concurrently", async () => {
    const pacer = new EngineRequestPacer();
    const started: string[] = [];
    const slow = (label: string) =>
      pacer.schedule(label, 0, async () => {
        started.push(label);
        await new Promise((r) => setTimeout(r, 40));
        return label;
      });

    await Promise.all([slow("ddg"), slow("searxng")]);
    expect(started).toEqual(["ddg", "searxng"]);
  });
});

describe("querySiblingPluginCaches", () => {
  it("returns [] when no query term is long enough", () => {
    expect(querySiblingPluginCaches(["ai"])).toEqual([]);
  });

  it("finds matching JSON items and ranks them by score", () => {
    const roots = {
      "telegram-rag-cache": [path.join(tmpDir(), "empty")],
      "rss-rag-cache": [tmpDir()],
      "persistent-memory": [path.join(tmpDir(), "empty")],
    };
    const rssDir = roots["rss-rag-cache"][0];
    fs.writeFileSync(
      path.join(rssDir, "items.json"),
      JSON.stringify({
        items: [
          {
            title: "Photovoltaic efficiency record",
            url: "https://example.com/solar",
            content:
              "Researchers reported a new photovoltaic efficiency record using tandem perovskite cells in a lab setting.",
            pubDate: "2026-01-15",
          },
          {
            title: "Unrelated",
            url: "https://example.com/other",
            content:
              "nothing here mentions the requested terms at all, this is filler text to exceed the length gate",
          },
          { title: "Too short", url: "https://example.com/short", content: "efficiency" },
        ],
      }),
    );

    const hits: SiblingCacheHit[] = querySiblingPluginCaches(
      ["photovoltaic efficiency improvements"],
      10,
      roots,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].sourcePlugin).toBe("rss-rag-cache");
    expect(hits[0].url).toBe("https://example.com/solar");
    expect(hits[0].timestamp).toBe("2026-01-15");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("recovers markdown/text cache files", () => {
    const roots = {
      "telegram-rag-cache": [tmpDir()],
      "rss-rag-cache": [path.join(tmpDir(), "empty")],
      "persistent-memory": [path.join(tmpDir(), "empty")],
    };
    const tgDir = roots["telegram-rag-cache"][0];
    fs.writeFileSync(
      path.join(tgDir, "notes.md"),
      "Notes on hydrogen fuel cell efficiency gains observed in recent trials.",
    );

    const hits = querySiblingPluginCaches(["hydrogen fuel cell efficiency"], 5, roots);
    expect(hits).toHaveLength(1);
    expect(hits[0].sourcePlugin).toBe("telegram-rag-cache");
    expect(hits[0].url.startsWith("local-plugin://telegram-rag-cache/")).toBe(true);
  });
});
