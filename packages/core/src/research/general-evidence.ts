/**
 * General research evidence (fact lookups, research and comparisons). The pricing pipeline keeps
 * its own stricter model (research/evidence.ts + change-detector.ts); this one is
 * domain-independent:
 *
 *   sources ──(LLM proposes atomic claims + verbatim quotes)──► verifyClaims (code)
 *           ──► ResearchEvidence (per source: authority, relevance, verified claims, confidence)
 *           ──► assessCoverage (entities × aspects; gaps; sources that differ) ──► gapQueries
 *
 * Every confidence and coverage verdict is computed here, never by the model.
 */
import type { Source, SourceKind } from "../shared/types";
import { normalizeForMatch, subjectMatches, truncate } from "../shared/text";
import { looksLikeInjection, quoteFound, sourceText, textMentionsSubject } from "./evidence";
import type { ClaimExtraction } from "./schemas";

export type SourceAuthority = "official" | "primary" | "secondary";

export interface VerifiedClaim {
  id: string;
  sourceId: string;
  entity: string | null;
  aspect: string | null;
  claim: string;
  quote: string;
  /** 0–1, computed in code: source authority, plus corroboration by another domain. */
  confidence: number;
}

export interface ResearchEvidence {
  id: string;
  title: string;
  url: string;
  domain: string;
  excerpt: string;
  publishedAt?: string;
  retrievedAt: string;
  sourceAuthority: SourceAuthority;
  /** 0–1 from the ranking order (1 = best ranked). */
  relevance: number;
  claims: Array<{ id: string; claim: string; supportingQuote: string; confidence: number }>;
}

export type CellStatus = "verified" | "mentioned" | "gap";

export interface CoverageCell {
  entity: string | null;
  aspect: string | null;
  status: CellStatus;
  claimIds: string[];
  sourceIds: string[];
}

export interface CoverageConflict {
  entity: string | null;
  aspect: string | null;
  kind: "date" | "version";
  values: Array<{ value: string; sourceId: string }>;
}

export interface Coverage {
  cells: CoverageCell[];
  conflicts: CoverageConflict[];
  /** Research rounds run (1 or 2). */
  rounds: number;
  followUpQueries: string[];
}

const PRIMARY_DOMAINS = /(^|\.)(arxiv\.org|ietf\.org|w3\.org|github\.com|who\.int|europa\.eu|un\.org|sec\.gov)$/;

export function authorityOf(kind: SourceKind, domain: string): SourceAuthority {
  if (kind === "official" || kind === "official_pricing" || kind === "official_changelog") return "official";
  if (kind === "news" || /\.(gov|edu)(\.[a-z]{2})?$/.test(domain) || PRIMARY_DOMAINS.test(domain)) return "primary";
  return "secondary";
}

const AUTHORITY_BASE: Record<SourceAuthority, number> = { official: 0.9, primary: 0.8, secondary: 0.6 };

const norm = (s: string) => normalizeForMatch(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const contentWords = (s: string) => norm(s).split(" ").filter((w) => w.length >= 4);

/** Maps a model-supplied label onto one of the listed labels (exact, then word overlap), else null. */
function matchLabel(label: string | null, listed: string[], isEntity: boolean): string | null {
  if (!label || listed.length === 0) return null;
  const exact = listed.find((x) => norm(x) === norm(label));
  if (exact) return exact;
  if (isEntity) return listed.find((x) => subjectMatches(x, label) || subjectMatches(label, x)) ?? null;
  const words = new Set(contentWords(label));
  return listed.find((x) => contentWords(x).some((w) => words.has(w))) ?? null;
}

/**
 * Keeps a proposed claim only if its quote occurs verbatim in the cited source, the source isn't
 * quarantined, and the claim adds no number its quote doesn't contain (paraphrases may reword, not
 * invent figures). Entity/aspect labels are mapped onto the requested ones.
 */
export function verifyClaims(
  extraction: ClaimExtraction,
  sources: Source[],
  opts: { entities: string[]; aspects: string[] },
): { claims: VerifiedClaim[]; rejected: Array<{ claim: string; reason: string }> } {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const claims: VerifiedClaim[] = [];
  const rejected: Array<{ claim: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const c of extraction.claims) {
    const src = byId.get(c.sourceId);
    if (!src) {
      rejected.push({ claim: c.claim, reason: `unknown source ${c.sourceId}` });
      continue;
    }
    if (looksLikeInjection(c.claim) || looksLikeInjection(c.quote)) {
      rejected.push({ claim: c.claim, reason: "instruction-like content" });
      continue;
    }
    if (!quoteFound(sourceText(src), c.quote)) {
      rejected.push({ claim: c.claim, reason: "quote not found in source" });
      continue;
    }
    const quoteNums = new Set(figures(c.quote));
    const invented = figures(c.claim).filter((n) => !quoteNums.has(n) && !figures(sourceText(src)).includes(n));
    if (invented.length) {
      rejected.push({ claim: c.claim, reason: `figures not in quote: ${invented.join(", ")}` });
      continue;
    }
    const key = `${c.sourceId}|${norm(c.claim)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let entity = matchLabel(c.entity, opts.entities, true);
    // With a single entity, an unlabelled claim from a source that names it is about that entity.
    if (!entity && opts.entities.length === 1 && namesEntity(`${c.claim} ${sourceText(src)}`, opts.entities[0]!)) entity = opts.entities[0]!;
    // A claim labelled with an entity its source never names in full is not evidence for that entity.
    if (entity && !namesEntity(sourceText(src), entity)) {
      rejected.push({ claim: c.claim, reason: `source doesn't name ${entity}` });
      continue;
    }
    const aspect = matchLabel(c.aspect, opts.aspects, false);
    claims.push({ id: `C${claims.length + 1}`, sourceId: src.id, entity, aspect, claim: truncate(c.claim, 300), quote: truncate(c.quote, 300), confidence: AUTHORITY_BASE[authorityOf(src.kind, src.sourceDomain)] });
  }
  // Corroboration: the same cell supported by another domain raises confidence.
  for (const c of claims) {
    const domain = byId.get(c.sourceId)!.sourceDomain;
    const corroborated = claims.some((o) => o !== c && o.entity === c.entity && o.aspect === c.aspect && byId.get(o.sourceId)!.sourceDomain !== domain);
    if (corroborated) c.confidence = Math.min(1, Math.round((c.confidence + 0.1) * 100) / 100);
  }
  return { claims, rejected };
}

/** Numbers that matter for verification (>10 or non-integer), as normalised strings. */
export function figures(text: string): string[] {
  return [...text.replace(/,(?=\d{3}\b)/g, "").matchAll(/\d+(?:\.\d+)*/g)]
    .map((m) => m[0])
    .filter((n) => n.includes(".") || Number(n) > 10);
}

export function buildResearchEvidence(sources: Source[], claims: VerifiedClaim[]): ResearchEvidence[] {
  const n = Math.max(1, sources.length);
  return sources.map((s, i) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    domain: s.sourceDomain,
    excerpt: truncate(s.snippet || s.content || "", 300),
    publishedAt: s.publishedAt ?? undefined,
    retrievedAt: s.retrievedAt,
    sourceAuthority: authorityOf(s.kind, s.sourceDomain),
    relevance: Math.round((1 - i / n) * 100) / 100,
    claims: claims.filter((c) => c.sourceId === s.id).map((c) => ({ id: c.id, claim: c.claim, supportingQuote: c.quote, confidence: c.confidence })),
  }));
}

/**
 * Entities × aspects coverage. A cell is "verified" when a quote-verified claim answers it,
 * "mentioned" when a source names the entity and the aspect but no claim was extracted from it
 * (follow-up round results; checked again by the claim gate at answer time), otherwise a "gap".
 */
export function assessCoverage(input: { entities: string[]; aspects: string[]; claims: VerifiedClaim[]; sources: Source[]; round: number; followUpQueries?: string[] }): Coverage {
  const entities: Array<string | null> = input.entities.length ? input.entities.slice(0, 5) : [null];
  const aspects: Array<string | null> = input.aspects.length ? input.aspects.slice(0, 6) : [null];
  const cells: CoverageCell[] = [];
  for (const entity of entities) {
    for (const aspect of aspects) {
      const claims = input.claims.filter((c) => (entity === null || c.entity === entity) && (aspect === null || c.aspect === aspect));
      if (claims.length) {
        cells.push({ entity, aspect, status: "verified", claimIds: claims.map((c) => c.id), sourceIds: [...new Set(claims.map((c) => c.sourceId))] });
        continue;
      }
      const mentioning = input.sources.filter((s) => mentionsCell(sourceText(s), entity, aspect));
      cells.push({ entity, aspect, status: mentioning.length ? "mentioned" : "gap", claimIds: [], sourceIds: mentioning.map((s) => s.id).slice(0, 3) });
    }
  }
  return { cells, conflicts: findConflicts(input.claims, input.sources), rounds: input.round, followUpQueries: input.followUpQueries ?? [] };
}

const GENERIC = new Set(["the", "and", "for", "app", "cloud", "inc", "ltd", "corp", "database", "platform", "software", "tool", "tools", "pro", "plan"]);

/**
 * Does the text name the entity itself: every distinctive token of its name, not just one?
 * Live 2026-11-20: pages about other "Zentrix" products were taken as evidence for the fictional
 * "Zentrix QuantumDB 9". Unknown or generic names pass.
 */
export function namesEntity(text: string, entity: string): boolean {
  const toks = norm(entity).split(" ").filter((t) => t.length >= 3 && !GENERIC.has(t));
  if (toks.length === 0) return true;
  const hay = norm(text).replace(/\s+/g, "");
  return toks.every((t) => hay.includes(t));
}

/** Does a source text plausibly address this cell? (Entity named in full; at least half the aspect's content words present.) */
export function mentionsCell(text: string, entity: string | null, aspect: string | null): boolean {
  if (entity && !namesEntity(text, entity)) return false;
  if (!aspect) return true;
  const words = contentWords(aspect);
  if (words.length === 0) return true;
  const hay = ` ${norm(text)} `;
  const hits = words.filter((w) => hay.includes(` ${w}`)).length;
  return hits >= Math.ceil(words.length / 2);
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Full calendar dates stated in text, as YYYY-MM-DD. */
export function statedDates(text: string): string[] {
  const out = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  const add = (y: number, m: number, d: number) => {
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100) out.add(`${y}-${pad(m)}-${pad(d)}`);
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(+m[1]!, +m[2]!, +m[3]!);
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/g)) add(+m[3]!, MONTHS[m[2]!.toLowerCase()] ?? 0, +m[1]!);
  for (const m of text.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) add(+m[3]!, MONTHS[m[1]!.toLowerCase()] ?? 0, +m[2]!);
  return [...out];
}

const versions = (text: string) => [...new Set([...text.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]!))];

/**
 * Sources that differ: within one cell, claims from different domains that each state a full date
 * (or a three-part version) with no value in common. Reported, never resolved by code.
 */
function findConflicts(claims: VerifiedClaim[], sources: Source[]): CoverageConflict[] {
  const domainOf = new Map(sources.map((s) => [s.id, s.sourceDomain]));
  const groups = new Map<string, VerifiedClaim[]>();
  for (const c of claims) {
    const k = `${c.entity ?? ""}|${c.aspect ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const out: CoverageConflict[] = [];
  for (const group of groups.values()) {
    for (const [kind, read] of [["date", statedDates], ["version", versions]] as const) {
      const stated = group.map((c) => ({ c, vals: read(`${c.claim} ${c.quote}`) })).filter((x) => x.vals.length);
      const domains = new Set(stated.map((x) => domainOf.get(x.c.sourceId)));
      if (domains.size < 2) continue;
      const shared = stated[0]!.vals.filter((v) => stated.every((x) => x.vals.includes(v)));
      if (shared.length) continue;
      const values = stated.map((x) => ({ value: x.vals[0]!, sourceId: x.c.sourceId }));
      if (new Set(values.map((v) => v.value)).size < 2) continue;
      out.push({ entity: group[0]!.entity, aspect: group[0]!.aspect, kind, values });
      break;
    }
  }
  return out;
}

/**
 * Targeted follow-up queries, one per gap (entity + aspect), never repeating an earlier query.
 * With no entities/aspects to target, a single broadened query (the question itself).
 */
export function gapQueries(coverage: Coverage, opts: { question: string; previous: string[]; max: number; year?: string }): string[] {
  const prev = new Set(opts.previous.map((q) => norm(q)));
  const out: string[] = [];
  const push = (q: string) => {
    const t = truncate(q.replace(/\s+/g, " ").trim(), 150);
    if (t.length >= 3 && !prev.has(norm(t)) && !out.some((o) => norm(o) === norm(t))) out.push(t);
  };
  for (const cell of coverage.cells.filter((c) => c.status === "gap")) {
    if (out.length >= opts.max) break;
    if (cell.aspect) push(`${cell.entity ?? ""} ${cell.aspect}${opts.year ? ` ${opts.year}` : ""}`);
    else if (cell.entity && !textMentionsSubject(opts.question, cell.entity)) push(`${cell.entity} ${opts.question}`);
    else push(opts.question);
  }
  return out.slice(0, opts.max);
}

export const coverageSummary = (c: Coverage): { total: number; verified: number; mentioned: number; gaps: number } => ({
  total: c.cells.length,
  verified: c.cells.filter((x) => x.status === "verified").length,
  mentioned: c.cells.filter((x) => x.status === "mentioned").length,
  gaps: c.cells.filter((x) => x.status === "gap").length,
});

export const cellLabel = (c: { entity: string | null; aspect: string | null }, question = "the question"): string =>
  [c.entity, c.aspect].filter(Boolean).join(" · ") || question;
