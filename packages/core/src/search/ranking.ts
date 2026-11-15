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

/**
 * The registrable label of a hostname: "hubspot" for docs.hubspot.com,
 * "example" for shop.example.co.uk. Only this label can identify the owner;
 * subdomains can be created by anyone (neon.selfhost.dev is not Neon's).
 */
export function registrableLabel(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] ?? "";
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const compoundSuffix = tld.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(second);
  return compoundSuffix && labels.length >= 3 ? labels[labels.length - 3]! : second;
}

/** Review sites, aggregators and platforms that are never a vendor's own domain. */
const NEVER_OFFICIAL = /(^|\.)(g2|capterra|getapp|trustradius|softwareadvice|gartner|medium|reddit|quora|wikipedia|youtube|linkedin|github\.io|substack|producthunt|crunchbase)\./;

/**
 * Accepts a model-suggested official domain only if it is a plausible bare
 * hostname and not a review/aggregator site. It is used to target searches and
 * as a ranking hint, never as evidence by itself.
 */
export function trustedDomainHint(hint: string | null | undefined): string | null {
  const d = hint?.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!d || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
  if (NEVER_OFFICIAL.test(`${d}.`) || NEVER_OFFICIAL.test(d)) return null;
  return d;
}

export function isOfficialDomain(domain: string, subjects: SubjectHint[]): boolean {
  const owner = registrableLabel(domain);
  return subjects.some((s) => {
    // Model-suggested domain is a hint, accepted only if it is the exact host or a parent of it.
    const od = trustedDomainHint(s.officialDomain);
    if (od && (domain === od || domain.endsWith(`.${od}`))) return true;
    return brandTokens(s.name).some((t) => t === owner);
  });
}

/** A year in a title/URL older than `now` ("Pipedrive pricing 2024"), when the page has no publish date. */
function titleYearIsStale(r: SearchResult, now: Date): boolean {
  if (r.publishedAt) return false;
  const years = [...`${r.title} ${r.url}`.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  return years.length > 0 && Math.max(...years) < now.getUTCFullYear();
}

/** Does the result text mention the subject it was searched for? */
export function mentionsSubject(r: SearchResult, subject: string | null | undefined): boolean {
  if (!subject) return true;
  const toks = brandTokens(subject);
  if (toks.length === 0) return true;
  const text = `${r.title} ${r.snippet} ${r.content ?? ""} ${r.url}`.toLowerCase();
  return toks.some((t) => text.includes(t));
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
  if (titleYearIsStale(r, now)) score -= 0.2; // undated page that names an earlier year
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
  opts: {
    subjects: SubjectHint[];
    purposeByQuery: Map<string, QueryPurpose>;
    /** Subject each query was about; results that never mention it are demoted. */
    subjectByQuery?: Map<string, string | null>;
    maxSources: number;
    now?: Date;
    perQueryFloor?: number;
  },
): Source[] {
  const now = opts.now ?? new Date();
  const scored = results.map((r) => {
    const kind = classifySource(r, opts.subjects);
    const purpose = opts.purposeByQuery.get(r.query) ?? "general";
    let score = scoreSource(r, kind, purpose, now);
    if (!mentionsSubject(r, opts.subjectByQuery?.get(r.query))) score -= 0.4; // off-topic for its query
    return { r, kind, score: Math.round(score * 1000) / 1000 };
  });
  const byQuery = new Map<string, typeof scored>();
  for (const s of scored) {
    const arr = byQuery.get(s.r.query) ?? [];
    arr.push(s);
    byQuery.set(s.r.query, arr);
  }
  const chosen = new Map<string, (typeof scored)[number]>();
  const floor = opts.perQueryFloor ?? 2;
  // Deterministic, pricing-first allocation (independent of which search finished first):
  // round 1 gives every query its best result, round 2 its second best, and so on.
  const PRIORITY: Record<QueryPurpose, number> = { pricing: 0, general: 1, product_update: 2 };
  const queries = [...byQuery.keys()].sort(
    (a, b) => PRIORITY[opts.purposeByQuery.get(a) ?? "general"] - PRIORITY[opts.purposeByQuery.get(b) ?? "general"] || a.localeCompare(b),
  );
  const sortedPerQuery = new Map(queries.map((q) => [q, [...byQuery.get(q)!].sort((a, b) => b.score - a.score)]));
  for (let round = 0; round < floor; round++) {
    for (const q of queries) {
      const s = sortedPerQuery.get(q)![round];
      if (s && chosen.size < opts.maxSources && !chosen.has(s.r.url)) chosen.set(s.r.url, s);
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
