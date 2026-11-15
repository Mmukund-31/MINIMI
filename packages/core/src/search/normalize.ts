import type { SearchResult } from "../shared/types";

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|_hs|hsa_|mkt_tok$|igshid$|si$)/i;
const MAX_TITLE = 300;
const MAX_SNIPPET = 1_200;
const MAX_CONTENT = 6_000;

/**
 * Canonical URL used for de-duplication and citation identity:
 * lower-case host without "www.", no fragment, no tracking params,
 * sorted query, no trailing slash. Returns null for non-http(s) URLs.
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  let s = u.toString();
  if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
  return s.replace(/^http:\/\//, "https://");
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Strips control chars and collapses whitespace; bounds length (defends against oversized results). */
export function cleanText(s: string | undefined | null, max: number): string {
  if (!s) return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** Accepts only well-formed provider dates; never invents one. */
export function normalizePublishedDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  // Reject absurd values (future by > 2 days, or before 1995).
  if (t > Date.now() + 2 * 86_400_000 || t < Date.parse("1995-01-01")) return undefined;
  return new Date(t).toISOString();
}

export function normalizeResult(r: Partial<SearchResult> & { url: string }, defaults: { provider: string; query: string; retrievedAt: string }): SearchResult | null {
  const url = normalizeUrl(r.url);
  if (!url) return null;
  return {
    title: cleanText(r.title, MAX_TITLE) || domainOf(url),
    url,
    snippet: cleanText(r.snippet, MAX_SNIPPET),
    content: r.content ? cleanText(r.content, MAX_CONTENT) : undefined,
    publishedAt: normalizePublishedDate(r.publishedAt),
    retrievedAt: r.retrievedAt ?? defaults.retrievedAt,
    sourceDomain: domainOf(url),
    provider: r.provider ?? defaults.provider,
    providerScore: typeof r.providerScore === "number" && Number.isFinite(r.providerScore) ? Math.max(0, Math.min(1, r.providerScore)) : undefined,
    query: r.query ?? defaults.query,
  };
}

/** Removes duplicate URLs, keeping the richest/highest-scoring copy and merging metadata. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = byUrl.get(r.url);
    if (!existing) {
      byUrl.set(r.url, r);
      continue;
    }
    const better = (r.providerScore ?? 0) > (existing.providerScore ?? 0) ? r : existing;
    const other = better === r ? existing : r;
    byUrl.set(r.url, {
      ...better,
      snippet: better.snippet.length >= other.snippet.length ? better.snippet : other.snippet,
      content: (better.content?.length ?? 0) >= (other.content?.length ?? 0) ? better.content : other.content,
      publishedAt: better.publishedAt ?? other.publishedAt,
    });
  }
  return [...byUrl.values()];
}
