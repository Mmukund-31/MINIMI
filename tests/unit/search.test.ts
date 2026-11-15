import { describe, expect, it } from "vitest";
import {
  AppError,
  CachedSearch,
  createRepositories,
  dedupeResults,
  normalizePublishedDate,
  normalizeResult,
  normalizeUrl,
  openDatabase,
  rankSources,
  TavilySearchProvider,
  type SearchResult,
} from "@minimi/core";

describe("normalizeUrl", () => {
  it("canonicalises host, strips tracking params, fragments and trailing slashes", () => {
    expect(normalizeUrl("https://WWW.HubSpot.com/pricing/sales/?utm_source=x&b=2&a=1#plans")).toBe("https://hubspot.com/pricing/sales?a=1&b=2");
    expect(normalizeUrl("http://example.com/")).toBe("https://example.com");
  });
  it("rejects non-http(s) URLs", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://x.com/file")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("normalizeResult / dates", () => {
  it("never invents publication dates and rejects implausible ones", () => {
    expect(normalizePublishedDate(undefined)).toBeUndefined();
    expect(normalizePublishedDate("garbage")).toBeUndefined();
    expect(normalizePublishedDate("2999-01-01")).toBeUndefined();
    expect(normalizePublishedDate("2026-11-01T10:00:00Z")).toBe("2026-11-01T10:00:00.000Z");
  });
  it("bounds oversized content and strips control characters", () => {
    const r = normalizeResult({ url: "https://a.com", title: "T\u0000itle", snippet: "x".repeat(5000) }, { provider: "p", query: "q", retrievedAt: "2026-11-15T00:00:00Z" })!;
    expect(r.title).toBe("T itle");
    expect(r.snippet.length).toBe(1200);
  });
});

const res = (url: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  title: "t",
  url,
  snippet: "s",
  retrievedAt: "2026-11-15T00:00:00Z",
  sourceDomain: new URL(url).hostname.replace(/^www\./, ""),
  provider: "fixture",
  query: "q1",
  ...extra,
});

describe("dedupeResults", () => {
  it("merges duplicates keeping the best score and richest metadata", () => {
    const out = dedupeResults([
      res("https://a.com/x", { providerScore: 0.2, snippet: "short", publishedAt: "2026-11-01T00:00:00.000Z" }),
      res("https://a.com/x", { providerScore: 0.9, snippet: "a much longer snippet" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ providerScore: 0.9, snippet: "a much longer snippet", publishedAt: "2026-11-01T00:00:00.000Z" });
  });
});

describe("rankSources", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  it("ranks the official pricing page above a higher-scored third-party page and demotes stale articles", () => {
    const ranked = rankSources(
      [
        res("https://blog-aggregator.com/hubspot-pricing", { providerScore: 0.99, publishedAt: "2023-01-01T00:00:00.000Z" }),
        res("https://www.hubspot.com/pricing/sales", { providerScore: 0.6 }),
      ],
      { subjects: [{ name: "HubSpot", officialDomain: null }], purposeByQuery: new Map([["q1", "pricing"]]), maxSources: 5, now },
    );
    expect(ranked[0]!.url).toContain("hubspot.com");
    expect(ranked[0]!.kind).toBe("official_pricing");
    expect(ranked[0]!.id).toBe("S1");
    expect(ranked[1]!.kind).toBe("third_party");
  });
  it("guarantees each query contributes before filling by global score", () => {
    const many = Array.from({ length: 6 }, (_, i) => res(`https://a.com/${i}`, { providerScore: 0.9, query: "q1" }));
    const other = res("https://b.com/only", { providerScore: 0.1, query: "q2" });
    const ranked = rankSources([...many, other], { subjects: [], purposeByQuery: new Map(), maxSources: 4, now });
    expect(ranked.map((r) => r.url)).toContain("https://b.com/only");
    expect(ranked).toHaveLength(4);
  });
});

describe("TavilySearchProvider", () => {
  const okBody = { results: [{ title: "Neon Pricing", url: "https://neon.com/pricing?utm_medium=x", content: "Launch from $5/month", score: 0.8, published_date: "2026-11-01" }] };

  it("normalises results", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch;
    const p = new TavilySearchProvider("k", { timeoutMs: 1000, fetchImpl });
    const out = await p.search("neon pricing", { maxResults: 5 });
    expect(out[0]).toMatchObject({ url: "https://neon.com/pricing", sourceDomain: "neon.com", providerScore: 0.8, provider: "tavily", query: "neon pricing" });
    expect(out[0]!.publishedAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("retries once on 5xx and maps auth failures", async () => {
    let calls = 0;
    const flaky = (async () => (++calls === 1 ? new Response("err", { status: 502 }) : new Response(JSON.stringify(okBody)))) as typeof fetch;
    expect(await new TavilySearchProvider("k", { timeoutMs: 5000, fetchImpl: flaky }).search("q", { maxResults: 3 })).toHaveLength(1);
    expect(calls).toBe(2);
    const denied = (async () => new Response("no", { status: 401 })) as typeof fetch;
    await expect(new TavilySearchProvider("k", { timeoutMs: 1000, fetchImpl: denied }).search("q", { maxResults: 3 })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("times out instead of hanging", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const err = await new TavilySearchProvider("k", { timeoutMs: 50, fetchImpl: hang }).search("q", { maxResults: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("SEARCH_TIMEOUT");
  });
});

describe("CachedSearch", () => {
  it("serves repeated queries from the SQLite cache and never caches failures", async () => {
    const db = openDatabase(":memory:");
    const repos = createRepositories(db);
    let calls = 0;
    const provider = { name: "fake", search: async () => (++calls, [res("https://a.com")]) };
    const cached = new CachedSearch(provider, repos.searchCache, 6);
    expect((await cached.search("Neon pricing", { maxResults: 5 })).cached).toBe(false);
    expect((await cached.search("  neon   PRICING ", { maxResults: 5 })).cached).toBe(true);
    expect(calls).toBe(1);

    const failing = new CachedSearch({ name: "bad", search: async () => { throw new Error("boom"); } }, repos.searchCache, 6);
    await expect(failing.search("x", { maxResults: 5 })).rejects.toThrow("boom");
    await expect(failing.search("x", { maxResults: 5 })).rejects.toThrow("boom");
  });
});
