import { normalizeForMatch, subjectMatches } from "../shared/text";
import type { Comparison, Evidence, HistoricalClaim, SourceKind } from "../shared/types";
import { parsePrice, type ParsedPrice } from "./price";

/**
 * Deterministic comparison engine. The LLM never decides whether something
 * changed: it only extracts quoted values; this module compares them.
 *
 * Statuses:
 *  changed         comparable terms, different values, backed by evidence
 *  unchanged       comparable terms, same value, backed by evidence
 *  uncertain       missing/conflicting evidence, or terms that can't be confirmed equal
 *  not_comparable  different plan, currency, billing period or unit
 */

const KIND_RANK: Record<SourceKind, number> = { official_pricing: 5, official: 4, official_changelog: 3, news: 2, third_party: 1 };

/**
 * Plan-name equivalence. Vendor/brand words (from `subject`) and filler words
 * are ignored, then the shorter name's tokens must all appear in the longer
 * one: "Neon Launch" ≈ "Launch (usage-based)", "Pro" ≈ "Supabase Pro",
 * but "Professional" ≠ "Growth" and "Pro" ≠ "Pro+".
 */
export function planMatches(a: string, b: string, subject = ""): boolean {
  const brand = new Set(normalizeForMatch(subject).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 3));
  const tokens = (s: string) =>
    new Set(
      normalizeForMatch(s)
        .replace(/\b(plan|plans|tier|edition|the|package|subscription|monthly|annual|annually|yearly|usage|based|on|demand)\b/g, " ")
        .replace(/[^a-z0-9+ ]/g, " ")
        .split(/\s+/)
        .filter((t) => t && !brand.has(t)),
    );
  let ta = tokens(a);
  let tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) {
    // The subject itself contained the plan name (e.g. subject "Freshsales Pro"): compare without brand removal.
    brand.clear();
    ta = tokens(a);
    tb = tokens(b);
    if (ta.size === 0 || tb.size === 0) return false;
  }
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...small].every((t) => large.has(t));
}

interface PriceComparisonResult {
  status: Comparison["status"];
  explanation: string;
}

export function comparePrices(prev: ParsedPrice, cur: ParsedPrice): PriceComparisonResult {
  if (prev.isCustom && cur.isCustom) return { status: "unchanged", explanation: "Both then and now: custom pricing (contact sales)." };
  if (prev.isCustom !== cur.isCustom) {
    return { status: "uncertain", explanation: "One side is custom/contact-sales pricing, so the values can't be compared directly." };
  }
  if (prev.isFree && cur.isFree) return { status: "unchanged", explanation: "Free then and now." };
  if (prev.amount === null || cur.amount === null) {
    const same = normalizeForMatch(prev.raw) === normalizeForMatch(cur.raw);
    return same
      ? { status: "unchanged", explanation: "Identical wording." }
      : { status: "uncertain", explanation: "Couldn't extract a numeric price from both statements." };
  }
  if (prev.currency && cur.currency && prev.currency !== cur.currency) {
    return { status: "not_comparable", explanation: `Different currencies (${prev.currency} vs ${cur.currency}).` };
  }
  if (prev.usageUnit !== cur.usageUnit) {
    // A flat plan price vs a metered rate (or two different meters) is never a like-for-like comparison.
    const describe = (p: ParsedPrice) => (p.usageUnit ? `per ${p.usageUnit} (usage-based)` : "a plan price");
    return { status: "not_comparable", explanation: `Different pricing models: ${describe(prev)} vs ${describe(cur)}.` };
  }
  if (prev.period && cur.period && prev.period !== cur.period) {
    return { status: "not_comparable", explanation: `Different billing units (per ${prev.period} vs per ${cur.period}).` };
  }
  if (prev.billing && cur.billing && prev.billing !== cur.billing) {
    return { status: "not_comparable", explanation: `Different billing terms (billed ${prev.billing} vs billed ${cur.billing}).` };
  }
  const equal = Math.abs(prev.amount - cur.amount) < 0.005;
  if (equal) return { status: "unchanged", explanation: "Same price on comparable terms." };
  // From here on the amounts differ, so every remaining ambiguity blocks a "changed" verdict.
  if (prev.perSeat !== cur.perSeat && prev.amount !== 0 && cur.amount !== 0) {
    return { status: "not_comparable", explanation: "One price is per seat/user and the other is a total or flat fee." };
  }
  if (!prev.period !== !cur.period) {
    return { status: "uncertain", explanation: "Prices differ, but one statement doesn't give the billing period." };
  }
  if (!prev.billing !== !cur.billing) {
    return {
      status: "uncertain",
      explanation: "Prices differ, but one source doesn't state monthly vs annual billing, which often explains a gap of this size.",
    };
  }
  if (prev.isFloor !== cur.isFloor) {
    return { status: "uncertain", explanation: "One value is a starting/minimum price and the other a flat price." };
  }
  const delta = cur.amount - prev.amount;
  const pct = prev.amount !== 0 ? ` (${delta > 0 ? "+" : ""}${((delta / prev.amount) * 100).toFixed(0)}%)` : "";
  return { status: "changed", explanation: `Price ${delta > 0 ? "increased" : "decreased"} from ${prev.amount} to ${cur.amount}${pct}.` };
}

export function isGenericAttribute(attribute: string): boolean {
  return /^(the\s+)?(price|prices|pricing|cost|costs|plan|plans|base price|entry plan|entry price|starting price|paid plan)\s*$/i.test(attribute.trim());
}

/** A year in a page title/URL that is older than the retrieval year (e.g. "Pipedrive pricing 2024"). */
export function staleYear(text: string, retrievedAt: string): number | null {
  const current = new Date(retrievedAt).getUTCFullYear();
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) return null;
  const newest = Math.max(...years);
  return newest < current ? newest : null;
}

function pickBest(evs: Evidence[]): Evidence[] {
  return [...evs].sort(
    (a, b) =>
      KIND_RANK[b.sourceKind] - KIND_RANK[a.sourceKind] ||
      (Date.parse(b.publishedAt ?? "1970") || 0) - (Date.parse(a.publishedAt ?? "1970") || 0),
  );
}

export function comparePricing(claims: HistoricalClaim[], evidence: Evidence[]): Comparison[] {
  const current = evidence.filter((e) => e.category === "pricing" && e.evidenceType === "current");
  const out: Comparison[] = [];
  for (const claim of claims.filter((c) => c.category === "pricing")) {
    const forSubject = current.filter((e) => subjectMatches(e.subject, claim.subject));
    const base = { subject: claim.subject, category: "pricing" as const, attribute: claim.attribute, previousValue: claim.value };
    if (forSubject.length === 0) {
      out.push({ ...base, status: "uncertain", explanation: "No current pricing evidence was found in the sources searched.", evidenceIds: [], sourceIds: [] });
      continue;
    }
    // A generic label ("price", "pricing") identifies no plan: usable only if the vendor has a single current price.
    const generic = isGenericAttribute(claim.attribute);
    const distinctPlans = new Set(forSubject.map((e) => normalizeForMatch(e.attribute)));
    const samePlan = generic ? (distinctPlans.size === 1 ? forSubject : []) : forSubject.filter((e) => planMatches(e.attribute, claim.attribute, claim.subject));
    if (samePlan.length === 0) {
      const plans = [...new Set(forSubject.map((e) => `${e.attribute}: ${e.value}`))].slice(0, 3).join("; ");
      out.push({
        ...base,
        currentValue: undefined,
        status: "uncertain",
        explanation: generic
          ? `The earlier answer didn't name the plan, and several current plans exist (${plans}), so they can't be matched reliably.`
          : `No current price for the "${claim.attribute}" plan in the sources (it may have been renamed or removed, or just isn't shown). Current plans seen: ${plans}.`,
        evidenceIds: forSubject.map((e) => e.id),
        sourceIds: [...new Set(forSubject.map((e) => e.sourceId))],
      });
      continue;
    }
    const prev = parsePrice(claim.value);
    const ranked = pickBest(samePlan);
    const best = ranked[0]!;
    const bestParsed = parsePrice(best.value);
    const result = comparePrices(prev, bestParsed);

    // Conflict check among equally-authoritative comparable sources.
    const peers = ranked.filter((e) => e !== best && KIND_RANK[e.sourceKind] === KIND_RANK[best.sourceKind]);
    const conflicting = peers.filter((e) => {
      const p = parsePrice(e.value);
      return comparePrices(bestParsed, p).status === "changed";
    });
    const lowerDisagree = ranked.filter(
      (e) => KIND_RANK[e.sourceKind] < KIND_RANK[best.sourceKind] && comparePrices(bestParsed, parsePrice(e.value)).status === "changed",
    );

    let status = result.status;
    let explanation = result.explanation;
    if (conflicting.length > 0) {
      status = "uncertain";
      explanation = `Sources of similar authority disagree on the current price (${[best, ...conflicting].map((e) => e.value).join(" vs ")}).`;
    } else if (lowerDisagree.length > 0) {
      explanation += ` A less authoritative source lists a different price (${lowerDisagree[0]!.value}); the ${best.sourceKind.replace("_", " ")} source was preferred.`;
    }
    const stale = staleYear(best.sourceTitle + " " + best.sourceUrl, best.retrievedAt);
    if (best.sourceKind === "third_party" && stale && !best.publishedAt && (status === "changed" || status === "unchanged")) {
      status = "uncertain";
      explanation = `The only current source is a third-party page that appears to date from ${stale}, so this can't be confirmed.`;
    } else if (best.sourceKind === "third_party" && (status === "changed" || status === "unchanged")) {
      explanation += " Based on a third-party source only; check the official pricing page.";
    }
    const used = [best, ...conflicting];
    out.push({
      ...base,
      currentValue: best.value,
      status,
      explanation,
      evidenceIds: used.map((e) => e.id),
      sourceIds: [...new Set(used.map((e) => e.sourceId))],
    });
  }
  return out;
}

export function compareProductUpdates(
  subjects: string[],
  evidence: Evidence[],
  baselineDate: string | undefined,
  /** Subjects that actually had an update-focused search; others are reported as "not checked". */
  searchedFor?: (subject: string) => boolean,
): Comparison[] {
  const updates = evidence.filter((e) => e.category === "product_update");
  const baseline = baselineDate ? Date.parse(baselineDate) : undefined;
  const out: Comparison[] = [];
  for (const subject of subjects) {
    const mine = updates.filter((e) => subjectMatches(e.subject, subject) && e.significance === "major");
    const after = mine.filter((e) => e.publishedAt && (baseline === undefined || Date.parse(e.publishedAt) >= baseline));
    const undated = mine.filter((e) => !e.publishedAt);
    for (const e of pickBest(after).slice(0, 2)) {
      out.push({
        subject,
        category: "product_update",
        attribute: "Major update",
        currentValue: e.value,
        status: "changed",
        explanation: `Published ${e.publishedAt!.slice(0, 10)}${baselineDate ? `, after ${baselineDate.slice(0, 10)}` : ""}.`,
        evidenceIds: [e.id],
        sourceIds: [e.sourceId],
      });
    }
    if (after.length === 0 && undated.length > 0) {
      const e = pickBest(undated)[0]!;
      out.push({
        subject,
        category: "product_update",
        attribute: "Possible update",
        currentValue: e.value,
        status: "uncertain",
        explanation: "The source gives no publication date, so it may predate our conversation.",
        evidenceIds: [e.id],
        sourceIds: [e.sourceId],
      });
    }
    if (after.length === 0 && undated.length === 0) {
      const checked = searchedFor ? searchedFor(subject) : true;
      out.push({
        subject,
        category: "product_update",
        attribute: "Major update",
        status: "uncertain",
        explanation: checked
          ? "No major update dated after our conversation appeared in the sources searched. That isn't proof nothing shipped."
          : "Not checked: the search budget was spent on pricing, so no update-focused search ran for this subject.",
        evidenceIds: [],
        sourceIds: [],
      });
    }
  }
  return out;
}
