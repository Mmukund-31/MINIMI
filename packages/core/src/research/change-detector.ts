import { normalizeForMatch, subjectMatches } from "../shared/text";
import type { Comparison, ComparisonDimension, Evidence, HistoricalClaim, OfferingNote, Source, SourceKind } from "../shared/types";
import { textMentionsSubject } from "./evidence";
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
  dimension: ComparisonDimension;
  explanation: string;
}

/**
 * Compares two price statements. Dimensions are checked in order (currency →
 * pricing model → billing terms → amount); only identical terms reach the
 * amount check, so "changed" with dimension price_amount always means the
 * same plan on the same terms now costs a different amount.
 */
export function comparePrices(prev: ParsedPrice, cur: ParsedPrice): PriceComparisonResult {
  const r = (status: Comparison["status"], dimension: ComparisonDimension, explanation: string): PriceComparisonResult => ({ status, dimension, explanation });
  if (prev.isCustom && cur.isCustom) return r("unchanged", "price_amount", "Both then and now: custom pricing (contact sales).");
  if (prev.isCustom !== cur.isCustom) return r("uncertain", "pricing_model", "One side is custom/contact-sales pricing, so the values can't be compared directly.");
  if (prev.isFree && cur.isFree) return r("unchanged", "price_amount", "Free then and now.");
  if (prev.amount === null || cur.amount === null) {
    const same = normalizeForMatch(prev.raw) === normalizeForMatch(cur.raw);
    return same ? r("unchanged", "price_amount", "Identical wording.") : r("uncertain", "evidence", "Couldn't extract a numeric price from both statements.");
  }
  if (prev.currency && cur.currency && prev.currency !== cur.currency) {
    return r("not_comparable", "currency", `Different currencies (${prev.currency} vs ${cur.currency}); no monetary verdict.`);
  }
  if (prev.usageUnit !== cur.usageUnit) {
    // Flat plan price vs metered rate (or two different meters): a pricing-model difference, not an amount difference.
    const describe = (p: ParsedPrice) => (p.usageUnit ? `usage-based (per ${p.usageUnit})` : "a flat plan price");
    return r("not_comparable", "pricing_model", `Different pricing models: ${describe(prev)} then, ${describe(cur)} now.`);
  }
  if (prev.period && cur.period && prev.period !== cur.period) {
    return r("not_comparable", "billing_terms", `Different billing units (per ${prev.period} vs per ${cur.period}); no monetary verdict.`);
  }
  if (prev.billing && cur.billing && prev.billing !== cur.billing) {
    return r("not_comparable", "billing_terms", `Different billing terms (billed ${prev.billing} vs billed ${cur.billing}); no monetary verdict.`);
  }
  const equal = Math.abs(prev.amount - cur.amount) < 0.005;
  if (equal) return r("unchanged", "price_amount", "Same price on comparable terms.");
  // From here on the amounts differ, so every remaining ambiguity blocks a "changed" verdict.
  if (prev.perSeat !== cur.perSeat && prev.amount !== 0 && cur.amount !== 0) {
    return r("not_comparable", "billing_terms", "One price is per seat/user and the other is a total or flat fee; no monetary verdict.");
  }
  if (!prev.period !== !cur.period) return r("uncertain", "billing_terms", "Prices differ, but one statement doesn't give the billing period.");
  if (!prev.billing !== !cur.billing) {
    return r("uncertain", "billing_terms", "Prices differ, but one source doesn't state monthly vs annual billing, which often explains a gap of this size.");
  }
  if (prev.isFloor !== cur.isFloor) return r("uncertain", "pricing_model", "One value is a starting/minimum price and the other a flat price.");
  const delta = cur.amount - prev.amount;
  const pct = prev.amount !== 0 ? ` (${delta > 0 ? "+" : ""}${((delta / prev.amount) * 100).toFixed(0)}%)` : "";
  return r("changed", "price_amount", `Price ${delta > 0 ? "increased" : "decreased"} from ${prev.amount} to ${cur.amount}${pct}.`);
}

const isOfficial = (e: Evidence) => e.sourceKind === "official_pricing" || e.sourceKind === "official";

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
      out.push({ ...base, status: "uncertain", dimension: "evidence", explanation: "No current pricing evidence was found in the sources searched.", evidenceIds: [], sourceIds: [] });
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
        dimension: generic ? "evidence" : "plan_availability",
        explanation: generic
          ? `The earlier answer didn't name the plan, and several current plans exist (${plans}), so they can't be matched reliably.`
          : `No current price for the "${claim.attribute}" plan in the sources (it may have been renamed or removed, or just isn't shown). Current plans seen: ${plans}.`,
        evidenceIds: forSubject.map((e) => e.id),
        sourceIds: [...new Set(forSubject.map((e) => e.sourceId))],
      });
      continue;
    }
    const prev = parsePrice(claim.value);
    // Authority first; among equally authoritative sources prefer the one on comparable terms
    // (e.g. the flat plan price rather than a usage add-on listed for the same plan).
    const comparable = (e: Evidence) => (comparePrices(prev, parsePrice(e.value)).status === "not_comparable" ? 0 : 1);
    // Among equally authoritative sources, a price verified against the named plan outranks an
    // unverified one (e.g. an FAQ stating "Launch plan … $0.106 per CU-hour" over an older blog
    // post quoting a superseded rate with no plan attached). The gates themselves are unchanged.
    const verified = (e: Evidence) => (e.planVerified === false ? 0 : 1);
    // Ownership tier first (vendor-owned > news > third-party), then plan verification, then page type:
    // a vendor's comparison page that ties "Pro … $39" to the plan beats its own pricing page whose
    // card layout doesn't.
    const tier = (e: Evidence) => (KIND_RANK[e.sourceKind] >= 3 ? 3 : KIND_RANK[e.sourceKind]);
    const ranked = pickBest(samePlan).sort(
      (a, b) => tier(b) - tier(a) || verified(b) - verified(a) || KIND_RANK[b.sourceKind] - KIND_RANK[a.sourceKind] || comparable(b) - comparable(a),
    );
    const best = ranked[0]!;
    const bestParsed = parsePrice(best.value);
    const result = comparePrices(prev, bestParsed);

    // Conflict check among equally-authoritative comparable sources.
    const peers = ranked.filter((e) => e !== best && KIND_RANK[e.sourceKind] === KIND_RANK[best.sourceKind]);
    // For a pricing-model verdict, only disagreement about the model matters (two usage rates
    // that differ still agree the plan is usage-based); for amounts, any differing comparable price.
    const conflicting = peers.filter((e) => {
      const p = parsePrice(e.value);
      if (result.dimension === "pricing_model") return (p.usageUnit === null) !== (bestParsed.usageUnit === null);
      return comparePrices(bestParsed, p).status === "changed";
    });
    const rateSpread = result.dimension === "pricing_model" ? peers.filter((e) => e.value !== best.value).map((e) => e.value) : [];
    const lowerDisagree = ranked.filter(
      (e) => KIND_RANK[e.sourceKind] < KIND_RANK[best.sourceKind] && comparePrices(bestParsed, parsePrice(e.value)).status === "changed",
    );

    let status = result.status;
    let dimension = result.dimension;
    let explanation = result.explanation;
    const verdict = () => status === "changed" || status === "unchanged";

    // Pricing-model change: a flat price then, a metered (usage-based) price now (or vice versa).
    // Confirmed only when an official page shows it and no same-plan source still shows a flat price
    // of the old shape (a usage rate alone could just be an overage add-on).
    if (dimension === "pricing_model" && result.status === "not_comparable") {
      const stillFlat = samePlan.some((e) => {
        const p = parsePrice(e.value);
        return p.usageUnit === prev.usageUnit && p.amount !== null && isOfficial(e);
      });
      if (isOfficial(best) && best.planVerified !== false && !stillFlat) {
        status = "changed";
        explanation = `Pricing model changed: ${prev.usageUnit ? "usage-based" : "flat"} (${claim.value}) then, ${bestParsed.usageUnit ? `usage-based (per ${bestParsed.usageUnit})` : "flat"} now. The amounts can't be compared directly.`;
        if (rateSpread.length) explanation += ` Official pages quote different rates (${[best.value, ...rateSpread].join(" vs ")}), so the exact current rate is unconfirmed.`;
      } else {
        status = "uncertain";
        explanation = stillFlat
          ? `${result.explanation} The official page also still lists a flat price, so the usage rate may be an add-on rather than a new pricing model.`
          : !isOfficial(best)
            ? `${result.explanation} This may be a pricing-model change, but no official pricing page confirms it.`
            : `${result.explanation} This may be a pricing-model change, but the official page doesn't clearly tie this rate to the "${claim.attribute}" plan.`;
      }
    }

    if (conflicting.length > 0) {
      status = "uncertain";
      dimension = "evidence";
      explanation = `Sources of similar authority disagree on the current price (${[best, ...conflicting].map((e) => e.value).join(" vs ")}).`;
    } else if (lowerDisagree.length > 0) {
      explanation += ` A less authoritative source lists a different price (${lowerDisagree[0]!.value}); the ${best.sourceKind.replace("_", " ")} source was preferred.`;
    }

    // Historical cutoff: a page published before the conversation can't show a change *since* it.
    // If that page is the vendor's own and the price is tied to the plan, it shows something else:
    // the earlier answer was likely already out of date when it was given.
    let historicalAccuracy: Comparison["historicalAccuracy"] = "unknown";
    if (status === "changed" && best.publishedAt && Date.parse(best.publishedAt) < Date.parse(claim.statedAt)) {
      status = "uncertain";
      if (isOfficial(best) && best.planVerified !== false) {
        historicalAccuracy = "already_outdated";
        explanation = `The vendor's own page, published ${best.publishedAt.slice(0, 10)} (before our conversation on ${claim.statedAt.slice(0, 10)}), already listed ${best.value}. The earlier answer was likely out of date when given, rather than the price changing since.`;
      } else {
        explanation = `The differing value comes from a page published ${best.publishedAt.slice(0, 10)}, before our conversation (${claim.statedAt.slice(0, 10)}), so it doesn't show a change since then.`;
      }
    }
    // Plausibility: a >5× jump or <⅕ drop on identical terms is far more often a scraping artifact
    // ("$2323" for a doubled "$23") than a real price change.
    if (status === "changed" && dimension === "price_amount" && prev.amount && bestParsed.amount) {
      const ratio = bestParsed.amount / prev.amount;
      if (ratio > 5 || ratio < 0.2) {
        status = "uncertain";
        explanation = `The current value (${best.value}) differs from ${claim.value} by more than 5×, which is more likely a page-rendering artifact than a real change; not confirmed.`;
      }
    }
    // Attribution: a price not tied to the named plan can't prove a change.
    if (status === "changed" && best.planVerified === false) {
      status = "uncertain";
      explanation += " The source doesn't clearly tie this price to the plan, so the change isn't confirmed.";
    } else if (status === "unchanged" && best.planVerified === false) {
      explanation += " (The source doesn't name the plan next to this price.)";
    }

    const stale = staleYear(best.sourceTitle + " " + best.sourceUrl, best.retrievedAt);
    if (best.sourceKind === "third_party" && stale && !best.publishedAt && verdict()) {
      status = "uncertain";
      explanation = `The only current source is a third-party page that appears to date from ${stale}, so this can't be confirmed.`;
    } else if (!isOfficial(best) && verdict()) {
      explanation += " No official pricing page confirmed this; based on a third-party source.";
    }
    const used = [best, ...conflicting];
    if (status === "unchanged") historicalAccuracy = "consistent";
    out.push({
      ...base,
      currentValue: best.value,
      status,
      dimension,
      historicalAccuracy,
      explanation,
      evidenceIds: used.map((e) => e.id),
      sourceIds: [...new Set(used.map((e) => e.sourceId))],
    });
  }
  return out;
}

/**
 * Completeness of the earlier answer: plans currently listed on vendor-owned pages (price tied to
 * the plan) that none of the earlier claims discussed. This is reported separately from changes:
 * a plan missing from the earlier answer may be new, or may simply have been left out.
 */
export function assessOffering(claims: HistoricalClaim[], evidence: Evidence[]): OfferingNote[] {
  const subjects = [...new Set(claims.filter((c) => c.category === "pricing").map((c) => c.subject))];
  const notes: OfferingNote[] = [];
  for (const subject of subjects) {
    const discussed = claims.filter((c) => subjectMatches(c.subject, subject) && c.category === "pricing");
    const extra = new Map<string, { plan: string; value: string; sourceId: string }>();
    for (const e of evidence) {
      if (e.category !== "pricing" || !isOfficial(e) || e.planVerified !== true || !subjectMatches(e.subject, subject)) continue;
      if (isGenericAttribute(e.attribute)) continue;
      if (discussed.some((c) => planMatches(e.attribute, c.attribute, subject))) continue;
      const key = normalizeForMatch(e.attribute);
      if (!extra.has(key)) extra.set(key, { plan: e.attribute, value: e.value, sourceId: e.sourceId });
    }
    if (extra.size) notes.push({ subject, plansNotDiscussed: [...extra.values()].slice(0, 6) });
  }
  return notes;
}

/**
 * Replaces the generic "no evidence" explanation with the actual reason, derived from the
 * sources that were retrieved: vendor pages found but none stated a price for the plan
 * (typically JavaScript-rendered or bot-blocked pricing pages) vs no vendor page found at all.
 */
export function explainMissingEvidence(comparisons: Comparison[], sources: Source[]): Comparison[] {
  return comparisons.map((c) => {
    if (c.category !== "pricing" || c.evidenceIds.length > 0 || c.dimension !== "evidence") return c;
    const own = sources.filter((s) => (s.kind === "official_pricing" || s.kind === "official" || s.kind === "official_changelog") && textMentionsSubject(`${s.title} ${s.url}`, c.subject));
    const explanation = own.length
      ? `${own.length} page(s) on the vendor's own site were found (e.g. "${own[0]!.title.slice(0, 60)}"), but none stated a price for this plan in the retrievable text. The pricing page may render prices with JavaScript or block automated access, so this stays unverified.`
      : "No page on the vendor's own site was found, and no other source stated a price for this plan, so this stays unverified.";
    return { ...c, explanation };
  });
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
        dimension: "feature",
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
        dimension: "feature",
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
        dimension: "feature",
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
