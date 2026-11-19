import { parsePrice } from "./price";
import type { Plan } from "./schemas";

export type PlannedSearch = Plan["searches"][number];
export type PlannedClaim = Plan["historicalClaims"][number];

const looksLikePrice = (s: string) => parsePrice(s).amount !== null || /\b(free|contact sales)\b/i.test(s);

/**
 * Repairs common structural slips in model-extracted claims, deterministically:
 *  - price written into `attribute` ("$90 per seat…") → moved to `value`;
 *  - plan name folded into `subject` ("HubSpot Sales Hub Professional") →
 *    split into the planned subject ("HubSpot Sales Hub") + plan ("Professional");
 *  - vendor name repeated in `attribute` ("Neon Launch") → "Launch".
 * Claims are still verified against memory afterwards; this only fixes shape.
 */
/**
 * Labels of derived figures (team totals, yearly sums) rather than vendor plans, e.g.
 * "Cost for 10 developers", "Total for 20 seats", "Annual total". These are calculations
 * from the earlier answer, not published prices, so they are never compared.
 */
export function isDerivedClaim(attribute: string): boolean {
  return /\b(cost|price|total)\s+for\b|\bfor\s+\d+\s+(developers?|users?|seats?|people|members)\b|\b(team|annual|yearly|monthly)\s+total\b|^total\b|\b\d+\s+(seats?|users?|developers?)\b/i.test(attribute);
}

export function normalizeClaims(claims: PlannedClaim[], subjects: Plan["subjects"]): PlannedClaim[] {
  const names = [...subjects.map((s) => s.name)].sort((a, b) => b.length - a.length);
  return claims.filter((c) => !isDerivedClaim(c.attribute)).map((c) => {
    let { subject, attribute, value } = c;
    if (looksLikePrice(attribute) && !looksLikePrice(value)) [attribute, value] = [value, attribute];
    else if (looksLikePrice(attribute) && looksLikePrice(value)) attribute = "";
    const lower = subject.toLowerCase();
    const parent = names.find((n) => lower.startsWith(n.toLowerCase()) && lower.length > n.length);
    if (parent) {
      const rest = subject.slice(parent.length).replace(/^[\s:–-]+/, "").trim();
      subject = parent;
      if (!attribute || looksLikePrice(attribute)) attribute = rest;
    } else {
      const exact = names.find((n) => n.toLowerCase() === lower);
      if (exact) subject = exact;
    }
    if (attribute.toLowerCase().startsWith(subject.toLowerCase() + " ")) attribute = attribute.slice(subject.length).trim();
    return { ...c, subject, attribute: attribute || "price", value };
  });
}

/**
 * Deterministic post-processing of the model's research plan.
 *
 * The model proposes searches; this function guarantees the properties the
 * answer depends on, whatever the model did:
 *  - duplicate queries are removed;
 *  - when the user asked about launches/updates, every subject gets an
 *    update-focused search (otherwise "no updates found" would be a claim
 *    about searches that never ran);
 *  - pricing/general searches are ordered before update searches, so a tight
 *    budget never starves the price checks;
 *  - the total never exceeds the search budget.
 */
export function finalizeSearchPlan(
  plan: Plan,
  opts: { wantsUpdates: boolean; maxSearches: number; monthYear: string },
): PlannedSearch[] {
  const seen = new Set<string>();
  const unique = plan.searches.filter((s) => {
    const k = s.query.trim().toLowerCase().replace(/\s+/g, " ");
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const primary = unique.filter((s) => s.purpose !== "product_update");
  const updates = unique.filter((s) => s.purpose === "product_update");

  if (opts.wantsUpdates) {
    for (const subj of plan.subjects) {
      const covered = updates.some((u) => (u.subject ?? "").toLowerCase() === subj.name.toLowerCase() || u.query.toLowerCase().includes(subj.name.toLowerCase().split(" ")[0]!));
      if (!covered) updates.push({ query: `${subj.name} new features announcement ${opts.monthYear}`, purpose: "product_update", subject: subj.name });
    }
  }

  return [...primary, ...updates].slice(0, opts.maxSearches);
}

/** Subjects that received an update-focused search in the executed plan. */
export function updateSearchedSubjects(searches: PlannedSearch[], executedQueries: Set<string>): (subject: string) => boolean {
  const done = searches.filter((s) => s.purpose === "product_update" && executedQueries.has(s.query));
  return (subject: string) =>
    done.some((s) => (s.subject ?? "").toLowerCase() === subject.toLowerCase() || s.query.toLowerCase().includes(subject.toLowerCase().split(" ")[0]!));
}
