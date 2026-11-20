import { subjectMatches } from "../shared/text";
import type { Evidence, PlanStatusNote, Source } from "../shared/types";
import { planMatches } from "./change-detector";
import { parsePrice } from "./price";

/** Wording that marks a plan as no longer sold. */
export const LEGACY_WORDING = /\blegacy\b|\bno longer (?:available|offered|sold)\b|\b(?:aren['’]?t|are not|isn['’]?t|is not|not) (?:available|offered) (?:to|for) new\b|\bdiscontinued\b|\bgrandfathered\b|\bretired\b/i;
/** Wording that says new customers specifically can't buy it. */
export const NEW_CUSTOMER_WORDING = /\bnew (?:customers|users|subscribers|sign-?ups)\b|\bno longer (?:available|offered|sold)\b/i;

const vendorOwnedKind = (k: Source["kind"]) => k === "official_pricing" || k === "official" || k === "official_changelog";
const vendorOwned = (e: Evidence) => vendorOwnedKind(e.sourceKind);

/**
 * Legacy plans flagged by the extractor (vendor-owned finding whose legacy wording was verified
 * verbatim in the source, see validateEvidence). The successor is attached only when the vendor
 * also lists a current price for it.
 */
export function assessPlanStatus(evidence: Evidence[], sources: Array<Source & { subject?: string }> = []): PlanStatusNote[] {
  const notes: PlanStatusNote[] = [];
  const pricing = evidence.filter((e) => e.category === "pricing" && e.evidenceType === "current" && vendorOwned(e));
  const currentPrice = (subject: string, plan: string) =>
    pricing.find((c) => c.planStatus !== "legacy" && subjectMatches(c.subject, subject) && planMatches(c.attribute, plan, subject) && parsePrice(c.value).amount !== null);
  for (const e of pricing) {
    if (e.planStatus !== "legacy" || !e.statusQuote) continue;
    if (notes.some((n) => subjectMatches(n.subject, e.subject) && planMatches(n.plan, e.attribute, e.subject))) continue;
    let successor: PlanStatusNote["successor"];
    if (e.successor && !planMatches(e.successor, e.attribute, e.subject)) {
      const cur = currentPrice(e.subject, e.successor);
      if (cur) successor = { plan: cur.attribute, value: cur.value, sourceId: cur.sourceId };
    }
    notes.push({ subject: e.subject, plan: e.attribute, value: e.value, sourceId: e.sourceId, statusQuote: e.statusQuote, ...(successor ? { successor } : {}) });
  }
  // Deterministic: legacy-plan tables on the vendor's own pages (the extractor doesn't always flag them).
  for (const s of sources) {
    if (!vendorOwnedKind(s.kind) || !s.subject) continue;
    const table = parseLegacyTable(`${s.snippet}\n${s.content ?? ""}`);
    if (!table) continue;
    for (const row of table.rows) {
      const existing = notes.find((n) => subjectMatches(n.subject, s.subject!) && planMatches(n.plan, row.plan, s.subject!));
      const fromRow = row.comparable && !planMatches(row.comparable, row.plan, s.subject) ? (row.comparablePrice ? { plan: row.comparable, value: row.comparablePrice, sourceId: s.id } : (() => {
        const cur = currentPrice(s.subject!, row.comparable!);
        if (cur) return { plan: cur.attribute, value: cur.value, sourceId: cur.sourceId };
        // The vendor's own current "Plan | Price" table (same or another vendor-owned page).
        for (const o of [s, ...sources.filter((x) => x !== s && vendorOwnedKind(x.kind) && x.subject && subjectMatches(x.subject, s.subject!))]) {
          const hit = parsePlanPriceTable(`${o.snippet}\n${o.content ?? ""}`).find((r) => planMatches(r.plan, row.comparable!, s.subject!));
          if (hit) return { plan: hit.plan, value: hit.price, sourceId: o.id };
        }
        return undefined;
      })()) : undefined;
      if (existing) {
        if (!existing.successor && fromRow) existing.successor = fromRow;
        continue;
      }
      notes.push({ subject: s.subject, plan: row.plan, value: row.price, sourceId: s.id, statusQuote: table.statusQuote, ...(fromRow ? { successor: fromRow } : {}) });
    }
  }
  return notes.slice(0, 12);
}

/**
 * The vendor's current-plans table ("Plan | Price | …", not a legacy table), in markdown or
 * flattened form. Used only to price a legacy plan's named successor.
 */
export function parsePlanPriceTable(text: string): Array<{ plan: string; price: string }> {
  const lines = text.split("\n");
  const out: Array<{ plan: string; price: string }> = [];
  for (let start = 0; start < lines.length; start++) {
    const l0 = lines[start]!;
    if (!/^\s*\|/.test(l0) || /legacy/i.test(l0) || !/(^|\|)\s*plans?\s*(\||$)/i.test(l0)) continue;
    const cells: string[] = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (!l || /^[-:|\s]+$/.test(l)) continue;
      if (!l.startsWith("|")) break;
      for (const c of l.split("|").map((x) => x.trim())) if (c && !/^:?-{3,}:?$/.test(c)) cells.push(c);
    }
    const h0 = cells.findIndex((c) => /^plans?$/i.test(c));
    if (h0 < 0 || !/^(price|pricing|cost)/i.test(cells[h0 + 1] ?? "")) continue;
    let h1 = h0 + 2;
    while (h1 < cells.length && /^(included|usage|features?|seats?|models?|credits?|third-party|best for)/i.test(cells[h1]!)) h1++;
    const ncols = h1 - h0;
    const data = cells.slice(h1);
    for (let i = 0; i + ncols <= data.length; i += ncols) {
      const [plan, price] = [data[i]!, data[i + 1]!];
      if (plan.length > 40 || !/[$€£₹¥]\s?\d|^free$/i.test(price)) break;
      out.push({ plan, price });
    }
    if (out.length) return out;
  }
  return out;
}

export interface LegacyTable {
  /** Verbatim sentence from the page that says legacy plans aren't sold to new customers, else the header. */
  statusQuote: string;
  rows: Array<{ plan: string; price: string; comparable?: string; comparablePrice?: string }>;
}

const HEADER_CELL = /^(legacy plans?|plans?|price|pricing|cost|monthly price|comparable|closest|equivalent|replac|successor|new plan|current plan|maps? to)/i;

/**
 * Parses a "Legacy plan | Price | Comparable plan" table from page text, in markdown form (one row
 * per line) or flattened HTML form (one cell per line). Returns null if the page has no table whose
 * header starts with "Legacy plan".
 */
export function parseLegacyTable(text: string): LegacyTable | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*\|/.test(l) && /\blegacy plans?\b/i.test(l));
  if (start < 0) return null;
  const cells: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!l || /^[-:|\s]+$/.test(l)) continue; // blank or separator row ("|---|", " --- ")
    if (!l.startsWith("|")) break;
    for (const c of l.split("|").map((x) => x.trim())) if (c && !/^:?-{3,}:?$/.test(c)) cells.push(c);
  }
  const h0 = cells.findIndex((c) => /^legacy plans?\b/i.test(c));
  if (h0 < 0) return null;
  let h1 = h0 + 1;
  while (h1 < cells.length && HEADER_CELL.test(cells[h1]!)) h1++;
  const header = cells.slice(h0, h1);
  const ncols = header.length;
  if (ncols < 2) return null;
  const priceCol = header.findIndex((c) => /^(price|pricing|cost|monthly price)/i.test(c));
  const compCol = header.findIndex((c) => /^(comparable|closest|equivalent|replac|successor|new plan|current plan|maps? to)/i.test(c));
  const rows: LegacyTable["rows"] = [];
  const data = cells.slice(h1);
  for (let i = 0; i + ncols <= data.length; i += ncols) {
    const row = data.slice(i, i + ncols);
    const plan = row[0]!;
    const price = priceCol > 0 ? row[priceCol]! : "";
    if (plan.length > 60 || !price || !/[$€£₹¥]\s?\d|\bfree\b/i.test(price)) break; // not a plan row: table ended
    let comparable: string | undefined;
    let comparablePrice: string | undefined;
    if (compCol > 0) {
      const raw = row[compCol]!;
      const m = /^(.*?)\s*\(([^)]*[$€£₹¥]\s?\d[^)]*)\)\s*$/.exec(raw);
      comparable = (m ? m[1]! : raw).trim() || undefined;
      comparablePrice = m ? m[2]!.trim() : undefined;
    }
    rows.push({ plan, price, ...(comparable ? { comparable } : {}), ...(comparablePrice ? { comparablePrice } : {}) });
  }
  if (rows.length === 0) return null;
  const sentence = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .find((x) => x.length >= 20 && x.length <= 300 && !x.startsWith("|") && NEW_CUSTOMER_WORDING.test(x));
  return { statusQuote: sentence ?? header.join(" | "), rows };
}
