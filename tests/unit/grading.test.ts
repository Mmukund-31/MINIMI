import { describe, expect, it } from "vitest";
import type { Comparison } from "@minimi/core";
import { gradeEntry, gradeOffering, structuralChecks, summarizeGrades, updateChecks, type GroundTruthEntry } from "../../evals/grading";

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

describe("updateChecks: launch claims are judged per clause (live 2026-11-20)", () => {
  it("doesn't attribute 'only Salesforce announced' to every vendor in the sentence", () => {
    const rows = ["HubSpot Sales Hub", "Pipedrive", "Salesforce Sales Cloud"].map((s) => row(s, "Major update", s.startsWith("Salesforce") ? "changed" : "uncertain", "feature", { category: "product_update", sourceIds: s.startsWith("Salesforce") ? ["S9"] : [] }));
    const sources = [{ id: "S9", title: "Salesforce and Microsoft announce Copilotforce", url: "https://salesforce.com/news/x", domain: "salesforce.com", kind: "official_changelog" as const, retrievedAt: "2026-11-20T00:00:00Z", publishedAt: "2026-11-17T00:00:00Z" }];
    const answer = "HubSpot, Pipedrive and Salesforce all remained on the same pricing tiers; only Salesforce announced a major product update.";
    expect(updateChecks({ comparisons: rows, sources, baselineDate: "2026-11-16T00:00:00Z", answer }).filter((v) => v.check === "unsupported-launch")).toEqual([]);
    const bad = "HubSpot launched a new AI agent this week.";
    expect(updateChecks({ comparisons: rows, sources, baselineDate: "2026-11-16T00:00:00Z", answer: bad }).map((v) => v.check)).toContain("unsupported-launch");
  });
});

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
  it("accepts the documented alternative outcome only with its historical-accuracy finding", () => {
    const alt = { ...exp, alsoCorrect: { status: "uncertain" as const, historicalAccuracy: "already_outdated" as const } };
    expect(gradeEntry(entry(alt), [row("Neon", "Launch", "uncertain", "pricing_model", { historicalAccuracy: "already_outdated" })]).grade).toBe("correct");
    expect(gradeEntry(entry(alt), [row("Neon", "Launch", "uncertain", "pricing_model", { historicalAccuracy: "unknown" })]).grade).toBe("abstained");
    expect(gradeEntry(entry(alt), [row("Neon", "Launch", "unchanged", "price_amount")]).grade).toBe("wrong");
  });
  it("Neon (corrected 2026-11-19): 'changed since' is wrong when the change predates the conversation", () => {
    const neon = { acceptable: [] as Comparison["status"][], dimension: "pricing_model" as const, forbidden: ["unchanged" as const], alsoCorrect: { status: "uncertain" as const, historicalAccuracy: "already_outdated" as const }, unknownTimingChange: "abstained" as const };
    expect(gradeEntry(entry(neon), [row("Neon", "Launch", "uncertain", "pricing_model", { historicalAccuracy: "already_outdated", changeTiming: "before_conversation" })]).grade).toBe("correct");
    expect(gradeEntry(entry(neon), [row("Neon", "Launch", "changed", "pricing_model", { changeTiming: "unknown" })]).grade).toBe("abstained");
    expect(gradeEntry(entry(neon), [row("Neon", "Launch", "changed", "pricing_model", { changeTiming: "after_conversation" })]).grade).toBe("wrong");
    expect(gradeEntry(entry(neon), [row("Neon", "Launch", "changed", "pricing_model")]).grade).toBe("wrong"); // old rows without timing
    expect(gradeEntry(entry(neon), [row("Neon", "Launch", "unchanged", "price_amount")]).grade).toBe("wrong");
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

describe("gradeOffering", () => {
  it("measures recall of omitted current plans", () => {
    const g = gradeOffering(
      { subject: "GitHub Copilot", plansExpected: ["Pro+", "Max"], url: "u", quote: "q", review: "provisional" },
      [{ subject: "GitHub Copilot", plansNotDiscussed: [{ plan: "Copilot Pro+", value: "$39", sourceId: "S1" }] }],
    );
    expect(g).toMatchObject({ found: ["Pro+"], missed: ["Max"], provisional: true });
  });
});

describe("updateChecks", () => {
  const upd = (subject: string, sourceIds: string[], status: Comparison["status"] = "changed"): Comparison => ({
    subject, category: "product_update", attribute: "Major update", status, dimension: "feature", explanation: "", evidenceIds: [], sourceIds, currentValue: "x",
  });
  const sources = [
    { id: "S1", title: "HubSpot launches Breeze agents", url: "https://hubspot.com/news/breeze", domain: "hubspot.com", retrievedAt: "x", kind: "official_changelog" as const, publishedAt: "2026-11-12T00:00:00Z" },
    { id: "S2", title: "CRM roundup", url: "https://blog.example.com/crm", domain: "blog.example.com", retrievedAt: "x", kind: "third_party" as const, publishedAt: "2026-11-12T00:00:00Z" },
    { id: "S3", title: "Salesforce Agentforce 2", url: "https://techcrunch.com/sf", domain: "techcrunch.com", retrievedAt: "x", kind: "news" as const, publishedAt: "2025-09-18T00:00:00Z" },
    { id: "S4", title: "Zoho update", url: "https://zoho.com/news", domain: "zoho.com", retrievedAt: "x", kind: "official_changelog" as const },
  ];
  const base = { sources, baselineDate: "2026-11-09T10:00:00Z", answer: "" };
  it("accepts a dated, official, correctly attributed update", () => {
    expect(updateChecks({ ...base, comparisons: [upd("HubSpot Sales Hub", ["S1"])] })).toEqual([]);
  });
  it("flags pre-baseline or undated dates, third-party-only and misattributed updates", () => {
    const v = updateChecks({ ...base, comparisons: [upd("Salesforce Sales Cloud", ["S3"]), upd("Zoho CRM", ["S4"]), upd("Pipedrive", ["S2"])] });
    const checks = v.map((x) => `${x.check}:${x.detail.split(":")[0]}`);
    expect(checks).toContain("update-date:Salesforce Sales Cloud");
    expect(checks).toContain("update-date:Zoho CRM");
    expect(checks).toContain("update-authority:Pipedrive");
    expect(checks).toContain("update-attribution:Pipedrive");
  });
  it("flags uncited launch claims for products without a confirmed update", () => {
    const comparisons = [upd("HubSpot Sales Hub", ["S1"]), upd("Pipedrive", [], "uncertain")];
    const v = updateChecks({ ...base, comparisons, answer: "HubSpot launched Breeze agents [S1]. Pipedrive released an AI assistant. Zoho shipped nothing big." });
    expect(v.map((x) => x.check)).toEqual(["unsupported-launch"]);
    expect(v[0]!.detail).toMatch(/Pipedrive/);
  });
});

describe("entity matching across subject and plan naming", () => {
  it("finds a row whose vendor name differs but whose plan names the product", () => {
    const rows = [row("Amazon Web Services", "AWS RDS for PostgreSQL (db.t4g.micro)", "uncertain", "evidence")];
    const g = gradeEntry({ subject: "AWS RDS for PostgreSQL", plan: "db.t4g.micro", url: "u", quote: null, expected: null, review: "not fetched" }, rows);
    expect(g.got?.status).toBe("uncertain");
  });
});
