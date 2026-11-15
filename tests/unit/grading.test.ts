import { describe, expect, it } from "vitest";
import type { Comparison } from "@minimi/core";
import { gradeEntry, structuralChecks, summarizeGrades, type GroundTruthEntry } from "../../evals/grading";

const row = (subject: string, attribute: string, status: Comparison["status"], dimension: Comparison["dimension"], extra: Partial<Comparison> = {}): Comparison => ({
  subject,
  category: "pricing",
  attribute,
  status,
  dimension,
  explanation: "",
  evidenceIds: [],
  sourceIds: [],
  ...extra,
});
const entry = (expected: GroundTruthEntry["expected"], review = "provisional"): GroundTruthEntry => ({ subject: "Neon", plan: "Launch", url: "u", quote: "q", expected, review });

describe("gradeEntry", () => {
  const exp = { acceptable: ["changed" as const], dimension: "pricing_model" as const };
  it("grades a matching verdict as correct", () => {
    expect(gradeEntry(entry(exp), [row("Neon", "Launch plan", "changed", "pricing_model")]).grade).toBe("correct");
  });
  it("treats 'changed' on the wrong dimension as wrong", () => {
    expect(gradeEntry(entry(exp), [row("Neon", "Launch", "changed", "price_amount")]).grade).toBe("wrong");
  });
  it("distinguishes honest abstention from a confident wrong answer", () => {
    expect(gradeEntry(entry(exp), [row("Neon", "Launch", "uncertain", "pricing_model")]).grade).toBe("abstained");
    expect(gradeEntry(entry(exp), [row("Neon", "Launch", "unchanged", "price_amount")]).grade).toBe("wrong");
  });
  it("respects forbidden statuses, missing rows and unreviewed entries", () => {
    const f = { acceptable: ["uncertain" as const], dimension: "plan_availability" as const, forbidden: ["unchanged" as const] };
    expect(gradeEntry(entry(f), [row("Neon", "Launch", "unchanged", "price_amount")]).grade).toBe("wrong");
    expect(gradeEntry(entry(exp), [row("Supabase", "Pro", "unchanged", "price_amount")]).grade).toBe("missing");
    expect(gradeEntry(entry(null, "not visible"), []).grade).toBe("ungraded");
  });
  it("marks results provisional until a human confirms the ground truth", () => {
    const s = summarizeGrades([gradeEntry(entry(exp), [row("Neon", "Launch", "changed", "pricing_model")])]);
    expect(s).toMatchObject({ correct: 1, gradable: 1, accuracy: "1/1", provisional: true });
    expect(summarizeGrades([gradeEntry(entry(exp, "human-confirmed"), [row("Neon", "Launch", "changed", "pricing_model")])]).provisional).toBe(false);
  });
});

describe("structuralChecks", () => {
  const sources = [
    { id: "S1", title: "t", url: "u1", domain: "neon.com", retrievedAt: "x", kind: "official_pricing" as const },
    { id: "S2", title: "t", url: "u2", domain: "blog.com", retrievedAt: "x", kind: "third_party" as const, publishedAt: "2026-01-01T00:00:00Z" },
  ];
  const base = { sources, baselineDate: "2026-11-10T00:00:00Z", answer: "", retrievedSourceIds: new Set(["S1", "S2"]) };
  it("flags unqualified third-party verdicts, incompatible amount changes, pre-cutoff evidence and bad citations", () => {
    const v = structuralChecks({
      ...base,
      answer: "See [S1] and [S9].",
      comparisons: [
        row("A", "Pro", "unchanged", "price_amount", { sourceIds: ["S2"] }),
        row("B", "Pro", "changed", "price_amount", { sourceIds: ["S1"], previousValue: "$20 per month", currentValue: "$200 per year" }),
        row("C", "Pro", "changed", "price_amount", { sourceIds: ["S2"], previousValue: "$20/month", currentValue: "$25/month", explanation: "third-party" }),
      ],
    });
    expect(v.map((x) => x.check).sort()).toEqual(["authority", "citation", "compatibility", "cutoff"]);
  });
  it("passes clean, well-sourced verdicts", () => {
    expect(structuralChecks({ ...base, answer: "[S1]", comparisons: [row("A", "Pro", "changed", "price_amount", { sourceIds: ["S1"], previousValue: "$20/month", currentValue: "$25/month" })] })).toEqual([]);
  });
});

describe("entity matching across subject and plan naming", () => {
  it("finds a row whose vendor name differs but whose plan names the product", () => {
    const rows = [row("Amazon Web Services", "AWS RDS for PostgreSQL (db.t4g.micro)", "uncertain", "evidence")];
    const g = gradeEntry({ subject: "AWS RDS for PostgreSQL", plan: "db.t4g.micro", url: "u", quote: null, expected: null, review: "not fetched" }, rows);
    expect(g.got?.status).toBe("uncertain");
  });
});
