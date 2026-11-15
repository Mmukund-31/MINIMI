import type { SearchResult, Source, SourceKind } from "../shared/types";

export interface SubjectHint {
  name: string;
  /** Model-suggested official domain; used only as a ranking hint, never as evidence. */
  officialDomain?: string | null;
}

export type QueryPurpose = "pricing" | "product_update" | "general";

const REPUTABLE_NEWS = new Set([
  "techcrunch.com", "theverge.com", "reuters.com", "bloomberg.com", "venturebeat.com", "zdnet.com", "wired.com",
  "arstechnica.com", "cnbc.com", "ft.com", "theregister.com", "infoq.com", "siliconangle.com", "geekwire.com",
  "businessinsider.com", "forbes.com", "axios.com", "theinformation.com",
]);
const LOW_TRUST = /(^|\.)(reddit\.com|quora\.com|pinterest\.|facebook\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com)$/;

const PRICING_HINT = /(pricing|prices?|plans?|cost|billing)/i;
const CHANGELOG_HINT = /(changelog|release[-_ ]?notes?|releases|what'?s[-_ ]new|whats-new|blog|news|announc|press|launch|product[-_ ]updates?)/i;

function brandTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !["the", "cloud", "hub", "sales", "crm", "and", "for", "inc", "database", "postgres", "hosting"].includes(t));
}

export function isOfficialDomain(domain: string, subjects: SubjectHint[]): boolean {
  const labels = domain.split(".");
  return subjects.some((s) => {
    const od = s.officialDomain?.toLowerCase().replace(/^www\./, "").trim();
    if (od && (domain === od || domain.endsWith(`.${od}`))) return true;
    const toks = brandTokens(s.name);
    return toks.length > 0 && labels.slice(0, -1).some((l) => l === toks[0]);
  });
}

export function classifySource(r: SearchResult, subjects: SubjectHint[]): SourceKind {
  const official = isOfficialDomain(r.sourceDomain, subjects);
  let path: string;
  try {
    path = new URL(r.url).pathname;
  } catch {
    path = "";
  }
  const hay = `${path} ${r.title}`;
  if (official && PRICING_HINT.test(hay)) return "official_pricing";
  if (official && CHANGELOG_HINT.test(hay)) return "official_changelog";
  if (official) return "official";
  if (REPUTABLE_NEWS.has(r.sourceDomain)) return "news";
  return "third_party";
}

const KIND_WEIGHT: Record<QueryPurpose, Record<SourceKind, number>> = {
  pricing: { official_pricing: 0.6, official: 0.35, official_changelog: 0.3, news: 0.15, third_party: 0.05 },
  product_update: { official_changelog: 0.55, official: 0.4, official_pricing: 0.2, news: 0.3, third_party: 0.05 },
  general: { official_pricing: 0.35, official_changelog: 0.35, official: 0.35, news: 0.25, third_party: 0.1 },
};

export function scoreSource(r: SearchResult, kind: SourceKind, purpose: QueryPurpose, now: Date): number {
  let score = 0.4 * (r.providerScore ?? 0.5) + KIND_WEIGHT[purpose][kind];
  if (r.publishedAt) {
    const ageDays = (now.getTime() - Date.parse(r.publishedAt)) / 86_400_000;
    if (ageDays <= 30) score += 0.1;
    else if (ageDays <= 120) score += 0.05;
    else if (ageDays > 365) score -= 0.15; // stale article: demote even if the provider ranked it first
  }
  if (LOW_TRUST.test(r.sourceDomain)) score -= 0.15;
  return Math.round(score * 1000) / 1000;
}

/**
 * Ranks de-duplicated results and selects up to `maxSources`, guaranteeing
 * each query contributes its best results before filling by global score (so
 * one subject cannot crowd out the other four). Assigns stable ids S1..Sn.
 */
export function rankSources(
  results: SearchResult[],
  opts: { subjects: SubjectHint[]; purposeByQuery: Map<string, QueryPurpose>; maxSources: number; now?: Date; perQueryFloor?: number },
): Source[] {
  const now = opts.now ?? new Date();
  const scored = results.map((r) => {
    const kind = classifySource(r, opts.subjects);
    const purpose = opts.purposeByQuery.get(r.query) ?? "general";
    return { r, kind, score: scoreSource(r, kind, purpose, now) };
  });
  const byQuery = new Map<string, typeof scored>();
  for (const s of scored) {
    const arr = byQuery.get(s.r.query) ?? [];
    arr.push(s);
    byQuery.set(s.r.query, arr);
  }
  const chosen = new Map<string, (typeof scored)[number]>();
  const floor = opts.perQueryFloor ?? 2;
  for (const arr of byQuery.values()) {
    for (const s of [...arr].sort((a, b) => b.score - a.score).slice(0, floor)) {
      if (chosen.size < opts.maxSources) chosen.set(s.r.url, s);
    }
  }
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (chosen.size >= opts.maxSources) break;
    if (!chosen.has(s.r.url)) chosen.set(s.r.url, s);
  }
  return [...chosen.values()]
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ ...s.r, id: `S${i + 1}`, kind: s.kind, rankScore: s.score }));
}
