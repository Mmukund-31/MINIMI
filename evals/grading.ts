/**
 * Live-evaluation grading. Pure functions so they are unit-tested offline.
 *
 * Two kinds of checks:
 *  1. Ground-truth grading of verdicts against evals/ground-truth.json
 *     (human-reviewed; entries not yet confirmed are reported as provisional).
 *  2. Structural checks that need no ground truth: source authority behind
 *     verdicts, term compatibility of "changed" amounts, historical cutoff,
 *     citation validity, and quote-to-plan attribution.
 */
import { parsePrice, planMatches, subjectMatches, type Comparison, type OfferingNote, type SourceRef } from "@minimi/core";

export interface GroundTruthEntry {
  subject: string;
  plan: string;
  url: string;
  quote: string | null;
  expected: {
    acceptable: Comparison["status"][];
    dimension: Comparison["dimension"];
    forbidden?: Comparison["status"][];
    /** A second correct outcome, e.g. recognising the earlier answer was already out of date. */
    alsoCorrect?: { status: Comparison["status"]; historicalAccuracy: NonNullable<Comparison["historicalAccuracy"]> };
    /**
     * When dated official evidence shows the difference predates the conversation, "changed since"
     * is wrong; but "changed" with changeTiming "unknown" (difference reported, timing explicitly
     * not claimed) is graded as an abstention on the timing question.
     */
    unknownTimingChange?: "abstained";
    note?: string;
  } | null;
  review: string;
}

export type Grade = "correct" | "abstained" | "wrong" | "missing" | "ungraded";

export interface GradedEntry {
  subject: string;
  plan: string;
  grade: Grade;
  got?: { status: Comparison["status"]; dimension: Comparison["dimension"]; currentValue?: string; changeTiming?: Comparison["changeTiming"]; historicalAccuracy?: Comparison["historicalAccuracy"] };
  provisional: boolean;
  reason: string;
}

/** Vendor/product naming varies ("Amazon Web Services" + plan "AWS RDS for PostgreSQL ..."), so match on subject or subject+plan. */
export function rowMentionsEntity(c: Comparison, subject: string): boolean {
  return subjectMatches(c.subject, subject) || subjectMatches(`${c.subject} ${c.attribute}`, subject);
}

export function findRow(entry: { subject: string; plan: string }, comparisons: Comparison[]): Comparison | undefined {
  return comparisons.find((c) => c.category === "pricing" && rowMentionsEntity(c, entry.subject) && planMatches(c.attribute, entry.plan, entry.subject));
}

/**
 * correct   : status acceptable (and for "changed", the right dimension)
 * abstained : uncertain / not_comparable where a verdict was expected (honest, but unhelpful)
 * wrong     : a confident verdict (changed / unchanged) that ground truth contradicts, or a forbidden status
 * missing   : no row for this subject + plan (entity or plan coverage failure)
 * ungraded  : no reviewed expectation (price not visible / not fetched)
 */
export function gradeEntry(entry: GroundTruthEntry, comparisons: Comparison[]): GradedEntry {
  const row = findRow(entry, comparisons);
  const base = { subject: entry.subject, plan: entry.plan, provisional: entry.review !== "human-confirmed" };
  const got = row ? { status: row.status, dimension: row.dimension, currentValue: row.currentValue, ...(row.changeTiming ? { changeTiming: row.changeTiming } : {}), ...(row.historicalAccuracy && row.historicalAccuracy !== "unknown" ? { historicalAccuracy: row.historicalAccuracy } : {}) } : undefined;
  if (!entry.expected) return { ...base, got, grade: "ungraded", reason: entry.review };
  if (!row) return { ...base, grade: "missing", reason: "no comparison row for this subject and plan" };
  const exp = entry.expected;
  if (exp.forbidden?.includes(row.status)) return { ...base, got, grade: "wrong", reason: `status '${row.status}' is ruled out by ground truth` };
  if (exp.alsoCorrect && row.status === exp.alsoCorrect.status && row.historicalAccuracy === exp.alsoCorrect.historicalAccuracy) {
    return { ...base, got, grade: "correct", reason: `matches ground truth (${row.historicalAccuracy})` };
  }
  if (exp.unknownTimingChange && row.status === "changed" && row.changeTiming === "unknown" && row.dimension === exp.dimension) {
    return { ...base, got, grade: "abstained", reason: "reported the difference but couldn't date it (timing unknown); ground truth: it predates the conversation" };
  }
  if (exp.acceptable.includes(row.status)) {
    if (row.status === "changed" && row.dimension !== exp.dimension) {
      return { ...base, got, grade: "wrong", reason: `changed, but on dimension '${row.dimension}' (expected '${exp.dimension}')` };
    }
    return { ...base, got, grade: "correct", reason: "matches ground truth" };
  }
  if (row.status === "uncertain" || row.status === "not_comparable") {
    return { ...base, got, grade: "abstained", reason: `expected ${exp.acceptable.join("/")}, system abstained (${row.status})` };
  }
  return { ...base, got, grade: "wrong", reason: `expected ${exp.acceptable.join("/")}, got confident '${row.status}'` };
}

/** Ground truth for completeness: current plans an earlier answer omitted. */
export interface OfferingTruth {
  subject: string;
  plansExpected: string[];
  url: string;
  quote: string;
  review: string;
}

export interface OfferingGrade {
  subject: string;
  found: string[];
  missed: string[];
  provisional: boolean;
}

/** Recall of omitted current plans (completeness). Missing ones are reported, not failed: coverage depends on search. */
export function gradeOffering(t: OfferingTruth, notes: OfferingNote[]): OfferingGrade {
  const listed = notes.filter((n) => subjectMatches(n.subject, t.subject)).flatMap((n) => n.plansNotDiscussed.map((p) => p.plan));
  const found = t.plansExpected.filter((p) => listed.some((l) => planMatches(l, p, t.subject)));
  return { subject: t.subject, found, missed: t.plansExpected.filter((p) => !found.includes(p)), provisional: t.review !== "human-confirmed" };
}

export interface StructuralViolation {
  check: "authority" | "compatibility" | "cutoff" | "citation" | "update-date" | "update-authority" | "update-attribution" | "unsupported-launch";
  detail: string;
}

const LAUNCH_VERB = /\b(launched|launches|released|releases|introduced|introduces|announced|announces|shipped|ships|rolled out|unveiled|debuted)\b/i;

/**
 * Product-update checks. Every "changed" feature row must cite a source that names the
 * product, is the vendor's own page or reputable news, and is dated after the conversation.
 * Answer sentences that claim a launch for a product with no such row, and cite nothing,
 * are flagged as unsupported.
 */
export function updateChecks(input: { comparisons: Comparison[]; sources: SourceRef[]; baselineDate?: string; answer: string }): StructuralViolation[] {
  const out: StructuralViolation[] = [];
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const features = input.comparisons.filter((c) => c.category === "product_update");
  for (const c of features.filter((x) => x.status === "changed")) {
    const srcs = c.sourceIds.map((id) => byId.get(id)).filter((s): s is SourceRef => Boolean(s));
    if (!srcs.some((s) => s.publishedAt && (!input.baselineDate || Date.parse(s.publishedAt) >= Date.parse(input.baselineDate)))) {
      out.push({ check: "update-date", detail: `${c.subject}: update reported as changed without a source dated after the conversation` });
    }
    if (!srcs.some((s) => s.kind !== "third_party")) {
      out.push({ check: "update-authority", detail: `${c.subject}: update rests only on third-party sources` });
    }
    const name = c.subject.toLowerCase().split(/[^a-z0-9]+/).find((t) => t.length >= 3) ?? "";
    if (name && !srcs.some((s) => `${s.title} ${s.url}`.toLowerCase().includes(name))) {
      out.push({ check: "update-attribution", detail: `${c.subject}: cited update source doesn't name the product` });
    }
  }
  // Unsupported launch claims in the answer text.
  const confirmed = new Set(features.filter((c) => c.status === "changed").map((c) => c.subject));
  const subjects = [...new Set(input.comparisons.map((c) => c.subject))];
  // Per clause: "HubSpot … remained on the same tiers; only Salesforce announced X" claims a launch for Salesforce only.
  for (const sentence of input.answer.split(/(?<=[.!?])\s+|\n+|;\s+|\s[–—]\s/)) {
    if (!LAUNCH_VERB.test(sentence) || /\[S\d+\]/.test(sentence) || /\b(no|not|none|nothing|without)\b/i.test(sentence)) continue;
    for (const subject of subjects) {
      const name = subject.toLowerCase().split(/[^a-z0-9]+/).find((t) => t.length >= 3);
      if (name && sentence.toLowerCase().includes(name) && !confirmed.has(subject)) {
        out.push({ check: "unsupported-launch", detail: `answer claims a launch for ${subject} without a cited, dated update: "${sentence.slice(0, 120)}"` });
      }
    }
  }
  return out;
}

/** Checks every pricing verdict without needing ground truth. */
export function structuralChecks(input: {
  comparisons: Comparison[];
  sources: SourceRef[];
  baselineDate?: string;
  answer: string;
  retrievedSourceIds: Set<string>;
}): StructuralViolation[] {
  const out: StructuralViolation[] = [];
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  for (const c of input.comparisons.filter((x) => x.category === "pricing")) {
    const srcs = c.sourceIds.map((id) => byId.get(id)).filter((s): s is SourceRef => Boolean(s));
    const verdict = c.status === "changed" || c.status === "unchanged";
    // Authority: a verdict must rest on an official page, or say plainly that it doesn't.
    if (verdict && !srcs.some((s) => s.kind === "official_pricing" || s.kind === "official") && !/third-party/i.test(c.explanation)) {
      out.push({ check: "authority", detail: `${c.subject} ${c.attribute}: '${c.status}' without an official source or a third-party qualification` });
    }
    // Compatibility: an amount change must be between prices on the same terms.
    if (c.status === "changed" && c.dimension === "price_amount" && c.previousValue && c.currentValue) {
      const a = parsePrice(c.previousValue);
      const b = parsePrice(c.currentValue);
      const clash = (["currency", "period", "billing", "usageUnit"] as const).filter((k) => a[k] && b[k] && a[k] !== b[k]);
      if (a.perSeat !== b.perSeat) clash.push("perSeat" as never);
      if (clash.length) out.push({ check: "compatibility", detail: `${c.subject} ${c.attribute}: amount change across different ${clash.join(", ")}` });
    }
    // Cutoff: a change "since" the conversation can't rest on a page published before it.
    if (c.status === "changed" && input.baselineDate) {
      for (const s of srcs) {
        if (s.publishedAt && Date.parse(s.publishedAt) < Date.parse(input.baselineDate)) {
          out.push({ check: "cutoff", detail: `${c.subject}: 'changed' cites ${s.id}, published ${s.publishedAt.slice(0, 10)} before the conversation` });
        }
      }
    }
  }
  for (const m of input.answer.matchAll(/\[(S\d+)\]/g)) {
    if (!input.retrievedSourceIds.has(m[1]!)) out.push({ check: "citation", detail: `answer cites ${m[1]} which was not retrieved` });
  }
  return out;
}

export function summarizeGrades(graded: GradedEntry[]): Record<Grade, number> & { gradable: number; accuracy: string; provisional: boolean } {
  const counts = { correct: 0, abstained: 0, wrong: 0, missing: 0, ungraded: 0 } as Record<Grade, number>;
  for (const g of graded) counts[g.grade]++;
  const gradable = graded.length - counts.ungraded;
  return {
    ...counts,
    gradable,
    accuracy: gradable ? `${counts.correct}/${gradable}` : "n/a",
    provisional: graded.some((g) => g.grade !== "ungraded" && g.provisional),
  };
}
