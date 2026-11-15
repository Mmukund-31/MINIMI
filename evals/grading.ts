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
import { parsePrice, planMatches, subjectMatches, type Comparison, type SourceRef } from "@minimi/core";

export interface GroundTruthEntry {
  subject: string;
  plan: string;
  url: string;
  quote: string | null;
  expected: { acceptable: Comparison["status"][]; dimension: Comparison["dimension"]; forbidden?: Comparison["status"][]; note?: string } | null;
  review: string;
}

export type Grade = "correct" | "abstained" | "wrong" | "missing" | "ungraded";

export interface GradedEntry {
  subject: string;
  plan: string;
  grade: Grade;
  got?: { status: Comparison["status"]; dimension: Comparison["dimension"]; currentValue?: string };
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
  const got = row ? { status: row.status, dimension: row.dimension, currentValue: row.currentValue } : undefined;
  if (!entry.expected) return { ...base, got, grade: "ungraded", reason: entry.review };
  if (!row) return { ...base, grade: "missing", reason: "no comparison row for this subject and plan" };
  const exp = entry.expected;
  if (exp.forbidden?.includes(row.status)) return { ...base, got, grade: "wrong", reason: `status '${row.status}' is ruled out by ground truth` };
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

export interface StructuralViolation {
  check: "authority" | "compatibility" | "cutoff" | "citation";
  detail: string;
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
