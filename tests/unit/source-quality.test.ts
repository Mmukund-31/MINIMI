import { describe, expect, it } from "vitest";
import {
  assessOffering,
  classifySource,
  comparePricing,
  explainMissingEvidence,
  mentionedIn,
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

describe("user-generated pages on vendor domains (live 2026-11-19)", () => {
  const r = (url: string, title: string): SearchResult => ({ title, url, snippet: "", retrievedAt: "x", sourceDomain: new URL(url).hostname, provider: "t", query: "q" });
  const subj = [{ name: "Cursor", officialDomain: "cursor.com" }];
  it("classes vendor forums and community Q&A as third-party", () => {
    expect(classifySource(r("https://forum.cursor.com/t/think-cursor-pro-is-20-month/136405", "Think Cursor Pro is $20/month? Nope"), subj)).toBe("third_party");
    expect(classifySource(r("https://help.zoho.com/portal/en/community/topic/question-about-zoho-crm", "Question about Zoho CRM"), [{ name: "Zoho CRM", officialDomain: "zoho.com" }])).toBe("third_party");
  });
  it("keeps the vendor's own help center and pricing pages official", () => {
    expect(classifySource(r("https://cursor.com/help/account-and-billing/pricing", "Pricing and plans | Cursor Docs"), subj)).toBe("official_pricing");
    expect(classifySource(r("https://support.pipedrive.com/en/article/new-pipedrive-plans", "What's new in Pipedrive plans?"), [{ name: "Pipedrive", officialDomain: "pipedrive.com" }])).toBe("official_pricing");
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

describe("completeness: historical accuracy and offering", () => {
  let k = 0;
  const e = (attribute: string, value: string, extra: Partial<Evidence> = {}): Evidence => ({
    id: `x${++k}`, claim: "", subject: "GitHub Copilot", category: "pricing", attribute, value, quote: value, sourceId: `S${k}`,
    sourceUrl: "https://github.com/features/copilot/plans", sourceTitle: "Plans", sourceKind: "official_pricing",
    retrievedAt: "2026-11-15T00:00:00Z", evidenceType: "current", strength: "strong", planVerified: true, ...extra,
  });
  const c = (attribute: string, value: string) => ({ subject: "GitHub Copilot", category: "pricing" as const, attribute, value, messageId: "m", statedAt: "2026-11-03T09:00:00Z" });

  it("lists verified current plans the earlier answer didn't discuss, separately from changes", () => {
    const claims = [c("Copilot Pro", "$10 per month"), c("Copilot Business", "$19 per user/month")];
    const evidence = [e("Copilot Pro", "$10 per month"), e("Copilot Business", "$19 per user/month"), e("Copilot Pro+", "$39 per month"), e("Copilot Max", "$100 per month"), e("Copilot Max", "$100 per month", { planVerified: false })];
    expect(comparePricing(claims, evidence).map((x) => [x.status, x.historicalAccuracy])).toEqual([["unchanged", "consistent"], ["unchanged", "consistent"]]);
    const [note] = assessOffering(claims, evidence);
    expect(note!.plansNotDiscussed.map((p) => p.plan)).toEqual(["Copilot Pro+", "Copilot Max"]);
  });
  it("never lists third-party or plan-unverified prices as part of the offering", () => {
    const claims = [c("Copilot Pro", "$10 per month")];
    expect(assessOffering(claims, [e("Copilot Max", "$100 per month", { sourceKind: "third_party" }), e("Copilot Max", "$100 per month", { planVerified: false })])).toEqual([]);
  });
  it("flags an earlier answer that was already out of date, distinct from a change since", () => {
    const [x] = comparePricing([c("Copilot Pro", "$10 per month")], [e("Copilot Pro", "$12 per month", { publishedAt: "2026-10-01T00:00:00Z" })]);
    expect(x).toMatchObject({ status: "uncertain", historicalAccuracy: "already_outdated" });
    expect(x!.explanation).toMatch(/already listed/);
  });
});

describe("round 4 regressions (live 2026-11-19)", () => {
  let k = 0;
  const e = (subject: string, attribute: string, value: string, extra: Partial<Evidence> = {}): Evidence => ({
    id: `r${++k}`, claim: "", subject, category: "pricing", attribute, value, quote: value, sourceId: `S${k}`,
    sourceUrl: "https://vendor.example/pricing", sourceTitle: "Pricing", sourceKind: "official_pricing",
    retrievedAt: "2026-11-19T00:00:00Z", evidenceType: "current", strength: "strong", planVerified: false, ...extra,
  });
  const cl = (subject: string, attribute: string, value: string) => ({ subject, category: "pricing" as const, attribute, value, messageId: "m", statedAt: "2026-11-17T10:00:00Z" });

  it("matches a plan folded into the subject when the extractor labelled the price generically (Supabase Pro / price)", () => {
    const [c] = comparePricing([cl("Supabase Pro", "Supabase Pro", "$25 per month per organization")], [e("Supabase Pro", "price", "$25 per month")]);
    expect(c).toMatchObject({ status: "unchanged", dimension: "price_amount" });
    expect(c!.explanation).toMatch(/doesn't name the plan/);
  });
  it("never lets a subject-carried plan prove a change (it isn't plan-verified)", () => {
    const [c] = comparePricing([cl("Railway Hobby", "Railway Hobby", "$5 per month")], [e("Railway Hobby", "price", "$8 per month")]);
    expect(c!.status).toBe("uncertain");
  });
  it("matches meter-labelled usage rates to the plan named in the subject, without verifying the plan (Neon Launch / compute)", () => {
    const [c] = comparePricing([cl("Neon Launch", "Neon Launch", "$19 per month")], [e("Neon Launch", "compute", "$0.14 per CU-hour"), e("Neon Launch", "storage", "$0.35 per GB-month")]);
    expect(c).toMatchObject({ status: "uncertain", dimension: "pricing_model" });
  });
  it("offering excludes plans the earlier answer mentioned even if not extracted as claims (Copilot Pro)", () => {
    const earlier = "- **Copilot Pro** (individuals): $10 per month.\n- **Copilot Business**: $19 per user/month.";
    const claims = [cl("GitHub Copilot", "Copilot Business", "$19 per user/month")];
    const ev = [e("GitHub Copilot", "Copilot Pro", "$10 USD per month", { planVerified: true }), e("GitHub Copilot", "Copilot Pro+", "$39 USD per month", { planVerified: true })];
    expect(assessOffering(claims, ev, earlier)[0]!.plansNotDiscussed.map((p) => p.plan)).toEqual(["Copilot Pro+"]);
  });
  it("offering never lists meters or usage rates as plans (Neon compute/storage)", () => {
    const ev = [e("Neon", "compute", "$0.14 per CU-hour", { planVerified: true }), e("Neon", "Scale", "$0.222 per CU-hour", { planVerified: true })];
    expect(assessOffering([cl("Neon", "Launch", "$19 per month")], ev)).toEqual([]);
  });
  it("mentionedIn treats Pro and Pro+ as different plans", () => {
    expect(mentionedIn("copilot pro (individuals): $10", "Copilot Pro", "GitHub Copilot")).toBe(true);
    expect(mentionedIn("copilot pro (individuals): $10", "Copilot Pro+", "GitHub Copilot")).toBe(false);
  });
});

describe("explainMissingEvidence", () => {
  const row = { subject: "Pipedrive", category: "pricing" as const, attribute: "Professional", previousValue: "$49", status: "uncertain" as const, dimension: "evidence" as const, explanation: "No current pricing evidence was found in the sources searched.", evidenceIds: [], sourceIds: [] };
  it("says vendor pages were found but stated no price (JS-rendered or blocked pricing page)", () => {
    const [c] = explainMissingEvidence([row], [{ ...src("S1", "What's new in Pipedrive plans?", "Plans overview", "official_pricing"), url: "https://support.pipedrive.com/x" }]);
    expect(c!.explanation).toMatch(/vendor's own site were found .* none stated a price/);
    expect(c!.status).toBe("uncertain");
  });
  it("says no vendor page was found when none was", () => {
    const [c] = explainMissingEvidence([row], [src("S1", "Best CRMs", "HubSpot and Zoho compared")]);
    expect(c!.explanation).toMatch(/No page on the vendor's own site was found/);
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
  it("regression (live 2026-11-15): prefers the plan-verified official rate over an unverified superseded one", () => {
    // Exact shape of the failing live run: S3 blog post with the old $0.14 rate (no plan attached),
    // S6 FAQ "The Launch plan ... You pay $0.106 per CU-hour" (plan verified). Both official, undated.
    const stale = ev("$0.14 per CU-hour", { planVerified: false, sourceId: "S3" });
    const faq = ev("$0.106 per CU-hour", { planVerified: true, sourceId: "S6" });
    const [c] = comparePricing([claim], [stale, faq]);
    expect(c).toMatchObject({ status: "changed", dimension: "pricing_model", currentValue: "$0.106 per CU-hour" });
    expect(c!.sourceIds[0]).toBe("S6");
  });
  it("prefers a plan-verified vendor page over the vendor's unverified pricing page (Freshsales card layout)", () => {
    const fs = { ...claim, subject: "Freshsales", attribute: "Pro", value: "$39 per user/month, billed annually" };
    const pricingPage = ev("$39/user/month", { subject: "Freshsales", attribute: "Pro", sourceKind: "official_pricing", planVerified: false, sourceId: "S1" });
    const suitePage = ev("$39 user month billed annually", { subject: "Freshsales", attribute: "Pro", sourceKind: "official", planVerified: true, sourceId: "S2" });
    const [c] = comparePricing([fs], [pricingPage, suitePage]);
    expect(c).toMatchObject({ status: "unchanged", sourceIds: ["S2"] });
    expect(c!.explanation).not.toMatch(/doesn't name the plan/);
  });
  it("treats an implausible >5× change as an artifact, not a price change (Zoho '$2323')", () => {
    const z = { ...claim, subject: "Zoho CRM", attribute: "Professional", value: "$23 per user/month" };
    const [c] = comparePricing([z], [ev("$2323 per user/month", { subject: "Zoho CRM", attribute: "Professional", planVerified: true })]);
    expect(c!.status).toBe("uncertain");
    expect(c!.explanation).toMatch(/artifact/);
  });
  it("still refuses a model-change verdict when no official rate is tied to the plan", () => {
    const [c] = comparePricing([claim], [ev("$0.14 per CU-hour", { planVerified: false }), ev("$0.106 per CU-hour", { planVerified: false })]);
    expect(c).toMatchObject({ status: "uncertain", dimension: "pricing_model" });
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
