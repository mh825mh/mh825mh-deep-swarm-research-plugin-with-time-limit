import { describe, it, expect } from "vitest";
import { isPrivateIp, isPrivateUrl, isDnsRisky } from "../src/net/ssrf";
import {
  isFastFailFetchHost,
  shouldBypassFlareSolverr,
} from "../src/net/waterfallFetcher";

describe("isPrivateIp", () => {
  it("detects RFC1918 private IPv4 addresses", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("detects loopback and link-local", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("rejects public IPv4 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("detects private/local IPv6 addresses", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("handles IPv4-mapped IPv6 addresses", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("isPrivateUrl", () => {
  it("blocks localhost and private hosts", () => {
    expect(isPrivateUrl("http://localhost")).toBe(true);
    expect(isPrivateUrl("http://127.0.0.1")).toBe(true);
    expect(isPrivateUrl("http://10.1.2.3/path")).toBe(true);
    expect(isPrivateUrl("http://192.168.0.10:8080")).toBe(true);
  });

  it("allows public URLs", () => {
    expect(isPrivateUrl("https://example.com")).toBe(false);
    expect(isPrivateUrl("https://en.wikipedia.org/wiki/Foo")).toBe(false);
  });

  it("blocks special-use DNS suffixes", () => {
    expect(isPrivateUrl("http://intranet.local")).toBe(true);
    expect(isPrivateUrl("http://router.home.arpa")).toBe(true);
  });

  it("returns true for malformed URLs (fail-closed)", () => {
    expect(isPrivateUrl("not-a-url")).toBe(true);
    expect(isPrivateUrl("")).toBe(true);
  });
});

describe("isDnsRisky", () => {
  it("flags URL hosts that are literal private IPv4/IPv6 addresses", async () => {
    expect(await isDnsRisky("http://10.0.0.5")).toBe(true);
    expect(await isDnsRisky("http://[::1]/")).toBe(true);
  });

  it("passes public literal IP URLs", async () => {
    expect(await isDnsRisky("http://8.8.8.8")).toBe(false);
    expect(await isDnsRisky("http://1.1.1.1")).toBe(false);
  });

  it("fails closed on malformed URLs", async () => {
    expect(await isDnsRisky("")).toBe(true);
    expect(await isDnsRisky("not-a-url")).toBe(true);
  });
});

describe("FlareSolverr host guards", () => {
  it("bypasses FlareSolverr for archive and unsolvable publishers", () => {
    expect(
      shouldBypassFlareSolverr("https://web.archive.org/web/2/https://x.test/a"),
    ).toBe(true);
    expect(shouldBypassFlareSolverr("https://archive.org/details/x")).toBe(true);
    expect(
      shouldBypassFlareSolverr("https://www.sciencedirect.com/science/article/abs/pii/1"),
    ).toBe(true);
    expect(shouldBypassFlareSolverr("https://www.researchgate.net/publication/1")).toBe(true);
  });

  it("still allows FlareSolverr for ordinary blocked hosts", () => {
    expect(shouldBypassFlareSolverr("https://example.com/article")).toBe(false);
  });

  it("fails fast on Sciencedirect/ResearchGate before the waterfall", () => {
    expect(isFastFailFetchHost("https://www.sciencedirect.com/science/article/abs/pii/1")).toBe(true);
    expect(isFastFailFetchHost("https://www.researchgate.net/publication/1")).toBe(true);
    expect(isFastFailFetchHost("https://example.com/article")).toBe(false);
  });
});