import type { SearchResult } from "../shared/types";
import { pageDate } from "./page-date";

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|_hs|hsa_|mkt_tok$|igshid$|si$)/i;
const MAX_TITLE = 300;
const MAX_SNIPPET = 1_200;
const MAX_CONTENT = 6_000;
/** Full-page mode (timing check only): enough text to reach pricing sections further down. */
const MAX_FULL_CONTENT = 40_000;

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

export function normalizeResult(r: Partial<SearchResult> & { url: string }, defaults: { provider: string; query: string; retrievedAt: string; fullText?: boolean }): SearchResult | null {
  const url = normalizeUrl(r.url);
  if (!url) return null;
  // Dated from the untruncated text; bylines only from full page text.
  const dated = r.pageDate ?? pageDate(url, r.content, { fullText: defaults.fullText });
  return {
    ...(dated ? { pageDate: dated } : {}),
    title: cleanText(r.title, MAX_TITLE) || domainOf(url),
    url,
    snippet: cleanText(r.snippet, MAX_SNIPPET),
    content: r.content ? cleanText(r.content, defaults.fullText ? MAX_FULL_CONTENT : MAX_CONTENT) : undefined,
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
      pageDate: better.pageDate ?? other.pageDate,
    });
  }
  return mergeSamePage([...byUrl.values()]);
}

/** Owner label of a host: "neon" for neon.tech and neon.com (mirrors/redirect wrappers of one page). */
function ownerLabel(domain: string): string {
  const labels = domain.split(".");
  return labels.length >= 2 ? labels[labels.length - 2]! : domain;
}

/**
 * The same page often arrives under several URLs (canonical, redirect wrapper with
 * tracking params, old domain) with *different* excerpts. Merge results with the same
 * owner and title, joining their distinct verbatim chunks so no evidence is lost and
 * the page uses one source slot instead of several.
 */
export function mergeSamePage(results: SearchResult[]): SearchResult[] {
  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    const title = r.title.toLowerCase().replace(/\s+/g, " ").trim();
    const key = title.length >= 12 ? `${ownerLabel(r.sourceDomain)}|${title}` : `url|${r.url}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0]!;
    const best = [...g].sort((a, b) => (b.providerScore ?? 0) - (a.providerScore ?? 0) || a.url.length - b.url.length)[0]!;
    const chunks: string[] = [];
    for (const r of g) for (const t of [r.snippet, r.content ?? ""]) if (t && !chunks.some((c) => c.includes(t))) chunks.push(t);
    return {
      ...best,
      snippet: best.snippet,
      content: chunks.join("\n…\n").slice(0, 8_000),
      publishedAt: g.map((r) => r.publishedAt).find(Boolean),
      pageDate: g.map((r) => r.pageDate).find(Boolean),
    };
  });
}
