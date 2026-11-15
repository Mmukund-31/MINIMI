import { describe, expect, it } from "vitest";
import {
  comparePricing,
  focusedExcerpt,
  isOfficialDomain,
  planAttributionVerified,
  rankSources,
  registrableLabel,
  subjectMatches,
  textMentionsSubject,
  validateEvidence,
  type Evidence,
  type SearchResult,
  type Source,
} from "@minimi/core";

describe("official-domain detection uses the registrable domain", () => {
  it("extracts the owner label", () => {
    expect(registrableLabel("docs.github.com")).toBe("github");
    expect(registrableLabel("shop.example.co.uk")).toBe("example");
    expect(registrableLabel("neon.selfhost.dev")).toBe("selfhost");
  });
  it("rejects look-alike subdomains, accepts real ones and explicit hints", () => {
    expect(isOfficialDomain("neon.selfhost.dev", [{ name: "Neon" }])).toBe(false);
    expect(isOfficialDomain("neon.com", [{ name: "Neon" }])).toBe(true);
    expect(isOfficialDomain("docs.github.com", [{ name: "GitHub Copilot" }])).toBe(true);
    expect(isOfficialDomain("aws.amazon.com", [{ name: "AWS RDS", officialDomain: "aws.amazon.com" }])).toBe(true);
    expect(isOfficialDomain("aws.amazon.com", [{ name: "AWS RDS", officialDomain: null }])).toBe(false);
  });
});

describe("subjectMatches requires the shorter name's tokens", () => {
  it("matches name variants but not different products of the same company", () => {
    expect(subjectMatches("HubSpot", "HubSpot Sales Hub")).toBe(true);
    expect(subjectMatches("AWS RDS", "AWS RDS for PostgreSQL")).toBe(true);
    expect(subjectMatches("Google Cloud SQL", "Google Workspace")).toBe(false);
    expect(subjectMatches("Salesforce Sales Cloud", "Salesforce Marketing Cloud")).toBe(false);
  });
});

const res = (url: string, title: string, snippet: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  title,
  url,
  snippet,
  retrievedAt: "2026-11-15T00:00:00Z",
  sourceDomain: new URL(url).hostname.replace(/^www\./, ""),
  provider: "fixture",
  query: "Render pricing",
  providerScore: 0.9,
  ...extra,
});

describe("focusedExcerpt", () => {
  it("keeps the price table from deep inside a long page instead of the navigation at the top", () => {
    const page = `${"Navigation Products Solutions Resources ".repeat(60)}| Plan | Price |\n| Pro | $39/user/month, billed annually |\n${"Footer links ".repeat(80)}`;
    const ex = focusedExcerpt(page, 600, ["Pro"]);
    expect(ex.length).toBeLessThanOrEqual(700);
    expect(ex).toContain("$39/user/month, billed annually");
  });
  it("returns short text unchanged", () => {
    expect(focusedExcerpt("Pro $10/month", 600)).toBe("Pro $10/month");
  });
});

describe("source allocation is pricing-first and deterministic", () => {
  it("gives pricing queries their slots before update queries regardless of arrival order", () => {
    const mk = (q: string, i: number) => res(`https://x${q.length}${i}.example.com/${i}`, `${q} ${i}`, `${q} text`, { query: q, providerScore: 0.9 });
    const updates = [0, 1, 2].map((i) => mk("Render new features", i));
    const pricing = [0, 1].map((i) => mk("Render pricing", i));
    const ranked = rankSources([...updates, ...pricing], {
      subjects: [],
      purposeByQuery: new Map([["Render pricing", "pricing"], ["Render new features", "product_update"]] as const),
      maxSources: 3,
      perQueryFloor: 2,
    });
    expect(ranked.filter((s) => s.query === "Render pricing")).toHaveLength(2);
  });
});

describe("ranking: relevance and staleness", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  const opts = {
    subjects: [{ name: "Render", officialDomain: null }],
    purposeByQuery: new Map([["Render pricing", "pricing" as const]]),
    subjectByQuery: new Map([["Render pricing", "Render"]]),
    maxSources: 5,
    now,
  };
  it("demotes results that never mention the searched subject", () => {
    const ranked = rankSources([res("https://blog.example.com/a", "Top 10 hosting picks", "Heroku and Fly.io compared."), res("https://reviews.example.org/b", "Render review", "Render Basic $19/month.", { providerScore: 0.5 })], opts);
    expect(ranked[0]!.url).toContain("reviews.example.org");
  });
  it("demotes undated pages whose title names an earlier year", () => {
    const ranked = rankSources([res("https://a.example.com/x", "Render pricing 2023", "Render $7/month"), res("https://b.example.com/y", "Render pricing guide", "Render $19/month", { providerScore: 0.6 })], opts);
    expect(ranked[0]!.url).toContain("b.example.com");
  });
});

const src = (id: string, title: string, snippet: string, kind: Source["kind"] = "third_party"): Source => ({
  id,
  title,
  url: `https://site${id}.example.com/p`,
  snippet,
  retrievedAt: "2026-11-15T00:00:00Z",
  sourceDomain: `site${id}.example.com`,
  provider: "fixture",
  query: "q",
  kind,
  rankScore: 1,
});

describe("evidence: entity and plan attribution", () => {
  it("rejects a quote from a page that is about a different vendor", () => {
    const r = validateEvidence(
      { findings: [{ subject: "Neon", category: "pricing", attribute: "Launch", value: "$25 per month", quote: "costs $25 per month", sourceId: "S1" }], updates: [] },
      [src("S1", "Best databases", "Supabase Pro costs $25 per month.")],
    );
    expect(r.evidence).toHaveLength(0);
    expect(r.rejected[0]!.reason).toBe("source does not mention the subject");
  });
  it("flags prices that cannot be tied to the named plan", () => {
    const page = "Render pricing. Starter $7/month. Standard $25/month. Pro $85/month.";
    const ok = validateEvidence({ findings: [{ subject: "Render", category: "pricing", attribute: "Standard", value: "$25/month", quote: "Standard $25/month", sourceId: "S1" }], updates: [] }, [src("S1", "Render", page)]);
    expect(ok.evidence[0]!.planVerified).toBe(true);
    const bad = validateEvidence({ findings: [{ subject: "Render", category: "pricing", attribute: "Pro", value: "$25/month", quote: "$25/month", sourceId: "S1" }], updates: [] }, [src("S1", "Render", page)]);
    expect(bad.evidence[0]!.planVerified).toBe(false);
  });
  it("helpers behave on edge cases", () => {
    expect(textMentionsSubject("A guide to CRM software", "CRM")).toBe(true); // generic-only names can't be checked
    expect(planAttributionVerified("Pro: $25 / month", "$25 / month", "price", "$25", "X")).toBe(false);
  });
});

describe("comparison dimensions", () => {
  const claim = { subject: "Neon", category: "pricing" as const, attribute: "Launch", value: "$19 per month", messageId: "m", statedAt: "2026-11-10T10:00:00Z" };
  let n = 0;
  const ev = (value: string, extra: Partial<Evidence> = {}): Evidence => ({
    id: `e${++n}`,
    claim: "",
    subject: "Neon",
    category: "pricing",
    attribute: "Launch",
    value,
    quote: value,
    sourceId: `S${n}`,
    sourceUrl: "https://neon.com/pricing",
    sourceTitle: "Neon pricing",
    sourceKind: "official_pricing",
    retrievedAt: "2026-11-15T00:00:00Z",
    evidenceType: "current",
    strength: "strong",
    ...extra,
  });
  it("reports flat → usage-based on the official page as a pricing-model change", () => {
    const [c] = comparePricing([claim], [ev("$0.106 per CU-hour")]);
    expect(c).toMatchObject({ status: "changed", dimension: "pricing_model" });
    expect(c!.explanation).toMatch(/can't be compared directly/);
  });
  it("keeps the model-change verdict when official pages agree on the model but quote different rates", () => {
    const [c] = comparePricing([claim], [ev("$0.14 per CU-hour"), ev("$0.106 per CU-hour")]);
    expect(c).toMatchObject({ status: "changed", dimension: "pricing_model" });
    expect(c!.explanation).toMatch(/different rates/);
  });
  it("treats 'per calendar month' as a plan period, not a usage meter", () => {
    const [c] = comparePricing([{ ...claim, value: "$10 per month" }], [ev("$10 USD per calendar month")]);
    expect(c).toMatchObject({ status: "unchanged", dimension: "price_amount" });
  });
  it("labels every row with a dimension", () => {
    expect(comparePricing([claim], [])[0]!.dimension).toBe("evidence");
    expect(comparePricing([claim], [ev("€19 per month")])[0]).toMatchObject({ status: "not_comparable", dimension: "currency" });
    expect(comparePricing([claim], [ev("$19 per month")])[0]).toMatchObject({ status: "unchanged", dimension: "price_amount" });
    expect(comparePricing([claim], [ev("$19 per month", { attribute: "Scale" })])[0]).toMatchObject({ status: "uncertain", dimension: "plan_availability" });
  });
});
