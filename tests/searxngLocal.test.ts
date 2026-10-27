// tests/searxngLocal.test.ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARXNG_LOCAL_URL,
  isSearxLocalKnownUnavailable,
  normalizeSearxBase,
  probeSearxLocal,
  resetSearxLocalStats,
  searxEndpointsFor,
  getSearxLocalStats,
} from "../src/net/search-engines";
import { isSsrfAllowed } from "../src/net/http";

describe("searxEndpointsFor", () => {
  it("uses the configured local endpoint first, then the public one", () => {
    const endpoints = searxEndpointsFor("http://127.0.0.1:8888", "quantum", 10);
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0].local).toBe(true);
    expect(endpoints[0].url).toContain("http://127.0.0.1:8888/search?q=quantum");
    expect(endpoints[1].local).toBe(false);
    expect(endpoints[1].url).toContain("https://searx.be/search?q=quantum");
  });

  it("falls back to public only when no local URL is configured", () => {
    const endpoints = searxEndpointsFor("", "quantum", 10);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].local).toBe(false);
  });

  it("normalizes trailing slashes and /search suffixes", () => {
    expect(normalizeSearxBase("http://127.0.0.1:8888/")).toBe("http://127.0.0.1:8888");
    expect(normalizeSearxBase("http://127.0.0.1:8888/search")).toBe("http://127.0.0.1:8888");
  });
});

describe("searx local availability state", () => {
  it("fails fast on a dead local endpoint and marks it unavailable", async () => {
    resetSearxLocalStats();
    expect(isSearxLocalKnownUnavailable()).toBe(false);
    // Port 1 is reserved (IPV6_NODE except on some systems use 65599); EADDRNOTAVAIL/refused → unreachable.
    await probeSearxLocal("http://127.0.0.1:1");
    expect(getSearxLocalStats().reachable).toBe(false);
    expect(getSearxLocalStats().configured).toBe(true);
    expect(isSearxLocalKnownUnavailable()).toBe(true);
  });

  it("treats an empty URL as not configured", async () => {
    resetSearxLocalStats();
    await probeSearxLocal("  ");
    expect(getSearxLocalStats().configured).toBe(false);
    expect(isSearxLocalKnownUnavailable()).toBe(true);
  });

  it("resets the probe state", async () => {
    await probeSearxLocal("http://127.0.0.1:1");
    resetSearxLocalStats();
    expect(getSearxLocalStats().configured).toBe(false);
    expect(isSearxLocalKnownUnavailable()).toBe(false);
  });
});

describe("ssrf allowance", () => {
  it("limits the local exemption to the configured origin only", () => {
    expect(isSsrfAllowed(DEFAULT_SEARXNG_LOCAL_URL, [DEFAULT_SEARXNG_LOCAL_URL])).toBe(true);
    expect(isSsrfAllowed("http://192.168.1.10/admin", [DEFAULT_SEARXNG_LOCAL_URL])).toBe(false);
    expect(isSsrfAllowed("https://searx.be/", [DEFAULT_SEARXNG_LOCAL_URL])).toBe(false);
    expect(isSsrfAllowed(DEFAULT_SEARXNG_LOCAL_URL, [])).toBe(false);
  });
});
