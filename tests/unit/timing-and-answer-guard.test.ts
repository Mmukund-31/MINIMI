/**
 * Regressions from the final live run (2026-11-19):
 *  - Postgres: the answer implied Neon's flat → usage-based change happened after the 17 Nov
 *    conversation and called the earlier "$19/month" correct. Neon's own blog (byline Aug 14, 2025)
 *    shows Launch was already usage-based, so the earlier answer was out of date when given.
 *  - CRM: "no major releases were found for … Freshsales" although no update search returned anything.
 *  - Cursor control: "$20 per month" without saying Pro is a legacy plan new customers can't buy.
 */
import { describe, expect, it } from "vitest";
import {
  addUnassessedUpdates,
  assessPlanStatus,
  buildGuardRules,
  comparePricing,
  compareProductUpdates,
  dropUnsupportedPrices,
  enforceAnswerFacts,
  parseLegacyTable,
  parsePlanPriceTable,
  planLabel,
  priceAfterPlan,
  vendorDomains,
  finalizeAnswer,
  pageDate,
  timingEvidence,
  verifyLegacy,
  type Comparison,
  type Evidence,
  type HistoricalClaim,
  type SearchResult,
  type Source,
} from "@minimi/core";

const NOW = new Date("2026-11-19T12:00:00Z");

describe("pageDate: only dates a page states about itself", () => {
  it("reads URL slugs, explicit 'last updated' lines and (full text only) blog bylines", () => {
    expect(pageDate("https://neon.com/docs/changelog/2025-11-07", "", { now: NOW })).toEqual({ date: "2025-11-07T00:00:00.000Z", basis: "url" });
    expect(pageDate("https://neon.com/guides/x", "… support). Last updated on October 14, 2026 Was this page helpful?", { now: NOW })?.date).toBe("2026-10-14T00:00:00.000Z");
    const blog = "# New usage-based pricing\n\nPay for what you use Mike Jerome–Product Manager Aug 14, 2025\n\n" + "x".repeat(400) + "\nRelated: Nov 12, 2026";
    expect(pageDate("https://neon.com/blog/new-usage-based-pricing", blog, { now: NOW, fullText: true })).toEqual({ date: "2025-08-14T00:00:00.000Z", basis: "byline" });
    // Excerpts can begin inside a related-posts list: no byline dating without the full page.
    expect(pageDate("https://neon.com/blog/new-usage-based-pricing", blog, { now: NOW })).toBeNull();
  });
  it("ignores an empty JavaScript-rendered 'Last updated on' and future dates", () => {
    expect(pageDate("https://neon.com/pricing", "Last updated on\n\nWas this page helpful?", { now: NOW })).toBeNull();
    expect(pageDate("https://x.com/changelog/2027-01-01", "", { now: NOW })).toBeNull();
  });
});

const claim = (attribute: string, value: string, statedAt = "2026-11-17T10:00:00Z"): HistoricalClaim => ({ subject: "Neon", category: "pricing", attribute, value, messageId: "m1", statedAt });
const ev = (over: Partial<Evidence>): Evidence => ({
  id: over.id ?? `ev_${Math.random()}`,
  claim: "",
  subject: "Neon",
  category: "pricing",
  attribute: "Launch",
  value: "$0.106 per CU-hour",
  quote: "Launch plan: $0.106 per CU-hour",
  sourceId: "S1",
  sourceUrl: "https://neon.com/pricing",
  sourceTitle: "Neon pricing",
  sourceKind: "official_pricing",
  retrievedAt: "2026-11-19T10:00:00Z",
  evidenceType: "current",
  strength: "strong",
  planVerified: true,
  ...over,
});

describe("Neon timing (historical-timing logic)", () => {
  it("an undated difference is 'changed' with unknown timing, never 'changed since'", () => {
    const [row] = comparePricing([claim("Launch", "$19 per month")], [ev({})]);
    expect(row).toMatchObject({ status: "changed", dimension: "pricing_model", changeTiming: "unknown" });
    expect(row!.explanation).toMatch(/undated/);
  });
  it("a self-dated vendor page from before the conversation makes it 'already out of date', not a change since", () => {
    const blog = ev({ id: "ev_blog", sourceId: "S9", sourceUrl: "https://neon.com/blog/new-usage-based-pricing", value: "$0.14 per CU-hour", evidenceType: "historical", pageDate: { date: "2025-08-14T00:00:00.000Z", basis: "byline" } });
    const [row] = comparePricing([claim("Launch", "$19 per month")], [ev({}), blog]);
    expect(row).toMatchObject({ status: "uncertain", historicalAccuracy: "already_outdated", changeTiming: "before_conversation" });
    // The timing page never becomes the current price.
    expect(row!.currentValue).toBe("$0.106 per CU-hour");
    expect(row!.sourceIds).toEqual(["S1", "S9"]);
    expect(row!.explanation).toMatch(/2025-08-14, from its byline/);
  });
  it("a dated page after the conversation, or a third-party page, can't move the timing earlier", () => {
    const later = ev({ id: "l", sourceId: "S3", evidenceType: "historical", pageDate: { date: "2026-11-18T00:00:00.000Z", basis: "url" } });
    const third = ev({ id: "t", sourceId: "S4", sourceKind: "third_party", evidenceType: "historical", pageDate: { date: "2025-01-01T00:00:00.000Z", basis: "url" } });
    const [row] = comparePricing([claim("Launch", "$19 per month")], [ev({}), later, third]);
    expect(row).toMatchObject({ status: "changed", changeTiming: "unknown" });
  });
  it("timingEvidence accepts only self-dated vendor pages that show the plan's current shape", () => {
    const r = (url: string, content: string): SearchResult => ({ title: "t", url, snippet: "", content, retrievedAt: "2026-11-19T10:00:00Z", sourceDomain: new URL(url).hostname, provider: "f", query: "q" });
    const results = [
      r("https://neon.com/blog/new-usage-based-pricing", "Pay for what you use Mike Jerome–Product Manager Aug 14, 2025 ... Launch compute is $0.106 per CU-hour, Scale compute is $0.222 per CU-hour." + " ".repeat(200)),
      r("https://selfhost.dev/blog/neon-pricing", "Published on Jan 2, 2025. Launch | $0.106/CU-hour"),
      r("https://neon.com/pricing", "Launch $0.106 per CU-hour"), // undated
    ];
    const found = timingEvidence(results, {
      subject: "Neon",
      plan: "Launch",
      currentValue: "$0.106 per CU-hour",
      dimension: "pricing_model",
      isVendorOwned: (x) => x.sourceDomain === "neon.com",
      now: NOW,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toMatchObject({ value: "$0.106 per CU-hour", evidenceType: "historical", planVerified: true, pageDate: { basis: "byline", date: "2025-08-14T00:00:00.000Z" } });
    expect(found[0]!.excerpt).toContain("Aug 14, 2025");
  });
});

const row = (over: Partial<Comparison>): Comparison => ({ subject: "Neon", category: "pricing", attribute: "Launch", status: "changed", dimension: "pricing_model", explanation: "", evidenceIds: [], sourceIds: ["S7"], ...over });

describe("answer guard: prose may not contradict the computed rows", () => {
  it("Freshsales: 'no releases found' becomes 'couldn't verify' when the update search didn't run or returned nothing", () => {
    const updates = compareProductUpdates(["Freshsales", "Zoho CRM"], [], "2026-11-16T09:00:00Z", (s) => (s === "Freshsales" ? "no_results" : "checked"));
    expect(updates.find((u) => u.subject === "Freshsales")!.explanation).toBe("Not checked: the update search for this subject returned no results.");
    expect(updates.find((u) => u.subject === "Zoho CRM")!.explanation).toMatch(/^No major update dated after/);
    const answer = "HubSpot's pricing stayed the same [S1].\nNo verifiable pricing changes or major releases were found for Pipedrive, Zoho, or Freshsales.";
    const out = enforceAnswerFacts(answer, buildGuardRules({ comparisons: updates, planStatus: [], question: "Has any of them shipped something big?" }));
    expect(out.text).not.toMatch(/were found for .*Freshsales/);
    expect(out.text).toContain("I couldn't verify recent releases for Freshsales (the update search returned no results). This doesn't establish that none occurred.");
    expect(out.text).toContain("HubSpot's pricing stayed the same [S1].");
  });
  it("a contradicting markdown table row is removed whole (the table stays valid) and the statement follows the answer", () => {
    const rules = buildGuardRules({ comparisons: compareProductUpdates(["Freshsales"], [], undefined, () => "no_results"), planStatus: [], question: "" });
    const answer = ["| Vendor | Change |", "|---|---|", "| Salesforce | Copilotforce [S1] |", "| Freshsales | No major update dated after 2026-11-16 |", "", "Done."].join("\n");
    const out = enforceAnswerFacts(answer, rules);
    expect(out.text).toBe(
      ["| Vendor | Change |", "|---|---|", "| Salesforce | Copilotforce [S1] |", "", "Done.", "", "I couldn't verify recent releases for Freshsales (the update search returned no results). This doesn't establish that none occurred."].join("\n"),
    );
  });
  it("Freshsales: the statement is added even if the answer is silent, and not duplicated if already stated", () => {
    const rules = buildGuardRules({ comparisons: compareProductUpdates(["Freshsales"], [], undefined, () => "not_run"), planStatus: [], question: "" });
    expect(enforceAnswerFacts("HubSpot is unchanged [S1].", rules).text).toMatch(/couldn't verify recent releases for Freshsales \(no update-focused search ran/);
    const ok = "Freshsales releases weren't checked, so I can't say whether anything shipped.";
    expect(enforceAnswerFacts(ok, rules)).toEqual({ text: ok, applied: [] });
  });
  it("Neon (live 2026-11-19 answer): 'correctly listed Neon at $19' and 'replaced … from 17 Nov' are removed when the claim was already out of date", () => {
    const live = [
      "Neon’s pricing model has changed since the last conversation, while Supabase Pro and Railway Hobby remain the same.",
      "- **Neon Launch**: The flat $19 / month rate from 17 Nov 2026 was replaced by a usage‑based model of $0.106 per CU‑hour [S7].",
      "- **Supabase Pro**: The $25 / month per organization price is unchanged on comparable terms [S2].",
      "The earlier answer (17 Nov 2026) correctly listed Neon at $19 / month, Supabase at $25 / month [S2] [S4].",
    ].join("\n");
    const outdated = row({
      status: "uncertain",
      historicalAccuracy: "already_outdated",
      changeTiming: "before_conversation",
      previousValue: "$19 per month",
      currentValue: "$0.106 per CU-hour",
      sourceIds: ["S7", "S13"],
      explanation: "The vendor's own page (dated 2025-08-14, from its byline, before our conversation on 2026-11-17) already listed Launch as usage-based ($0.106 per CU-hour). The earlier answer was likely already out of date when given; this doesn't show a change since then.",
    });
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: [outdated], planStatus: [], question: "Has any pricing changed since then?" }));
    expect(out.text).not.toMatch(/correctly listed Neon/);
    expect(out.text).not.toMatch(/Neon’s pricing model has changed since/);
    expect(out.text).not.toMatch(/from 17 Nov 2026 was replaced/);
    expect(out.text).toContain("Neon Launch: The vendor's own page (dated 2025-08-14, from its byline");
    expect(out.text.match(/already out of date/g)).toHaveLength(1);
    expect(out.text).toContain("**Supabase Pro**: The $25 / month per organization price is unchanged");
  });
  it("live 2026-11-19 (2nd run): a leading 'Yes –' is dropped and a plan folded into the subject isn't repeated", () => {
    const folded = row({ subject: "Neon Launch", attribute: "Neon Launch", changeTiming: "unknown", previousValue: "$19 per month", currentValue: "$0.106 per CU-hour", sourceIds: ["S6"] });
    const live = "Yes – the Neon Launch plan has shifted from a flat $19/month to a usage‑based model of $0.106 per CU‑hour[S6], while Supabase Pro stays at $25/month[S2].";
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: [folded], planStatus: [], question: "Has any pricing changed since then?" }));
    expect(out.text.startsWith("The Neon Launch plan has shifted")).toBe(true);
    expect(out.text).toContain("Supabase Pro stays at $25/month[S2]");
    expect(out.text).toContain("\n\nNeon Launch: the current pricing");
    expect(out.text).not.toContain("Neon Launch Neon Launch");
    expect(out.applied).toEqual(["timing-unknown:Neon Launch:Neon Launch"]);
  });
  it("Neon with undated pages only: a 'changed since' sentence becomes 'can't tell when'", () => {
    const unknown = row({ changeTiming: "unknown", previousValue: "$19 per month", currentValue: "$0.106 per CU-hour" });
    const out = enforceAnswerFacts("Neon’s pricing model has changed since the last conversation [S7].", buildGuardRules({ comparisons: [unknown], planStatus: [], question: "" }));
    expect(out.text).toBe("Neon Launch: the current pricing ($0.106 per CU-hour) no longer matches the earlier \"$19 per month\", but the vendor's pages are undated, so I can't tell whether it changed before or after our conversation [S7].");
  });
});

describe("Cursor control: legacy plan qualifier", () => {
  const legacyPage: Source = {
    id: "S1",
    kind: "official_pricing",
    rankScore: 1,
    title: "Legacy Cursor plans",
    url: "https://cursor.com/docs/account/pricing/legacy-cursor-plans",
    snippet: "",
    content: "Legacy plans aren't available to new customers, but existing subscribers keep them. | Plan | Price | Closest current plan | | Pro | $20/mo | Premium |",
    retrievedAt: "2026-11-19T10:00:00Z",
    sourceDomain: "cursor.com",
    provider: "f",
    query: "q",
  };
  it("verifyLegacy keeps the flag only with verbatim legacy wording tied to the plan", () => {
    expect(verifyLegacy(legacyPage, "| Pro | $20/mo |", "Pro", "Legacy plans aren't available to new customers", "Premium", "Cursor")).toEqual({
      planStatus: "legacy",
      statusQuote: "Legacy plans aren't available to new customers",
      successor: "Premium",
    });
    expect(verifyLegacy(legacyPage, "| Pro | $20/mo |", "Pro", "Pro is no longer sold to anyone", null, "Cursor")).toBeNull(); // not in the source
    expect(verifyLegacy(legacyPage, "| Pro | $20/mo |", "Pro", "existing subscribers keep them", null, "Cursor")).toBeNull(); // no legacy wording
    expect(verifyLegacy(legacyPage, "| Pro | $20/mo |", "Pro", "Legacy plans aren't available to new customers", "Ultra Max", "Cursor")?.successor).toBeUndefined();
  });

  const evid: Evidence[] = [
    ev({ id: "a", subject: "Cursor", attribute: "Pro", value: "$20/mo", quote: "| Pro | $20/mo |", sourceId: "S1", planStatus: "legacy", statusQuote: "Legacy plans aren't available to new customers, but existing subscribers keep them.", successor: "Premium" }),
    ev({ id: "b", subject: "Cursor", attribute: "Premium", value: "$30/mo", quote: "Premium $30/mo", sourceId: "S2" }),
  ];
  const rules = () => buildGuardRules({ comparisons: [], planStatus: assessPlanStatus(evid), question: "What is the current price of the Cursor Pro plan?" });

  it("fails if the answer only mentions $20/month: legacy, no new customers and Premium $30 are added", () => {
    const only20 = "The Cursor Pro plan is priced at $20 per month [S1][S3].";
    const out = enforceAnswerFacts(only20, rules());
    expect(out.text).not.toBe(only20);
    expect(out.text).toMatch(/\$20/);
    expect(out.text).toMatch(/legacy plan/);
    expect(out.text).toMatch(/new customers/);
    expect(out.text).toMatch(/Premium at \$30\/mo \[S2\]/);
    expect(out.applied).toEqual(["legacy-plan:Cursor:Pro"]);
  });
  it("leaves a complete answer alone, and adds nothing when the plan isn't discussed", () => {
    const full = "Cursor Pro is a legacy plan at $20/month that new customers can't buy [S1]; the closest current tier is Premium at $30/month [S2].";
    expect(enforceAnswerFacts(full, rules()).applied).toEqual([]);
    const other = buildGuardRules({ comparisons: [], planStatus: assessPlanStatus(evid), question: "How much is Cursor Ultra?" });
    expect(enforceAnswerFacts("Ultra costs $200/mo [S2].", other).applied).toEqual([]);
  });
});

describe("legacy-plan tables on the vendor's page (live 2026-11-20: the extractor didn't always flag Pro)", () => {
  // Text as fetched from cursor.com on 2026-11-20 (flattened HTML: one cell per line), and the same table in markdown.
  const flattened = [
    "Legacy Cursor plans are the plans Cursor sold before The X Subscription. They aren't available to new customers, but existing subscribers keep them until they switch or cancel.",
    " | | Legacy plan",
    " | Price",
    " | Comparable plan on The X Subscription",
    " | Hobby",
    " | Free",
    " | Free",
    " | Pro",
    " | $20/mo",
    " | Premium ($30/mo)",
    " | Ultra",
    " | $200/mo",
    " | Ultra ($200/mo)",
    " Legacy plans include two monthly usage pools.",
  ].join("\n");
  const markdown = "Legacy plans aren't available to new customers.\n\n| Legacy plan | Price | Comparable plan |\n|---|---|---|\n| Pro | $20/mo | Premium ($30/mo) |\n| Pro+ | $60/mo | Super ($100/mo) |\n\nMore text.";
  it("parses both layouts", () => {
    expect(parseLegacyTable(flattened)).toEqual({
      statusQuote: "They aren't available to new customers, but existing subscribers keep them until they switch or cancel.",
      rows: [
        { plan: "Hobby", price: "Free", comparable: "Free" },
        { plan: "Pro", price: "$20/mo", comparable: "Premium", comparablePrice: "$30/mo" },
        { plan: "Ultra", price: "$200/mo", comparable: "Ultra", comparablePrice: "$200/mo" },
      ],
    });
    expect(parseLegacyTable(markdown)!.rows.map((r) => `${r.plan}→${r.comparable} ${r.comparablePrice}`)).toEqual(["Pro→Premium $30/mo", "Pro+→Super $100/mo"]);
    expect(parseLegacyTable("| Plan | Price |\n| Pro | $20/mo |")).toBeNull(); // not a legacy table
  });
  it("turns a vendor-owned legacy table into plan-status notes (no self-mapping successor)", () => {
    const src = { id: "S1", kind: "official_pricing" as const, rankScore: 1, title: "Legacy Cursor plans", url: "https://cursor.com/docs/account/pricing/legacy-cursor-plans", snippet: "", content: flattened, retrievedAt: "2026-11-20T00:00:00Z", sourceDomain: "cursor.com", provider: "f", query: "q", subject: "Cursor" };
    const notes = assessPlanStatus([], [src, { ...src, id: "S2", kind: "third_party" as const }]);
    expect(notes.find((n) => n.plan === "Pro")).toEqual({ subject: "Cursor", plan: "Pro", value: "$20/mo", sourceId: "S1", statusQuote: expect.stringContaining("aren't available to new customers"), successor: { plan: "Premium", value: "$30/mo", sourceId: "S1" } });
    expect(notes.find((n) => n.plan === "Ultra")!.successor).toBeUndefined();
    expect(notes.every((n) => n.sourceId === "S1")).toBe(true);
  });
});

describe("unsupported prices (live 2026-11-20: 'Cursor Pro is $25 per month' with no $25 on any page)", () => {
  const support = "Pro $20/mo. Premium ($30/mo). Copilot Business $19 per user/month.";
  it("removes only the sentence with the invented price", () => {
    const out = dropUnsupportedPrices("For new customers Cursor Pro is **$25 per month** [S2]. The $20 plan is legacy [S1].", support, "What is the current price of the Cursor Pro plan?");
    expect(out.text).toBe("The $20 plan is legacy [S1].");
    expect(out.removed).toEqual(["For new customers Cursor Pro is **$25 per month** [S2]."]);
  });
  it("allows seat-count arithmetic and annual totals on supported prices, and never empties the answer", () => {
    const q = "How much does Copilot cost for a team of 10 developers?";
    expect(dropUnsupportedPrices("Business is $19 per seat, so $190 per month for 10 developers ($2,280 a year) [S1].", support, q).removed).toEqual([]);
    expect(dropUnsupportedPrices("It costs $99.", support, "x").text).toBe("It costs $99.");
  });
  it("drops a markdown table row with an invented price but keeps the table", () => {
    const t = "| Plan | Price |\n|---|---|\n| Pro | $20/mo |\n| Pro | $25/mo |";
    expect(dropUnsupportedPrices(t, support, "").text).toBe("| Plan | Price |\n|---|---|\n| Pro | $20/mo |");
  });
});

describe("planLabel", () => {
  it("never repeats words the vendor and plan names share", () => {
    expect(planLabel("HubSpot Sales Hub", "Sales Hub Professional")).toBe("HubSpot Sales Hub Professional");
    expect(planLabel("Neon Launch", "Neon Launch")).toBe("Neon Launch");
    expect(planLabel("Cursor Pro", "Pro")).toBe("Cursor Pro");
    expect(planLabel("Neon", "price")).toBe("Neon");
    expect(planLabel("Supabase", "Pro")).toBe("Supabase Pro");
  });
});

describe("live run 2026-11-20 (new Tavily key): defects found by reading the answers", () => {
  it("vendor searches also cover <brand>.com (planner guessed cursor.so; Neon lives on neon.com)", () => {
    expect(vendorDomains("cursor.so")).toEqual(["cursor.so", "cursor.com"]);
    expect(vendorDomains("neon.tech")).toEqual(["neon.tech", "neon.com"]);
    expect(vendorDomains("hubspot.com")).toEqual(["hubspot.com"]);
    expect(vendorDomains("docs.github.com")).toEqual(["docs.github.com"]); // already under github.com
  });
  it("timing evidence still finds the plan when the model folded it into the vendor name", () => {
    expect(priceAfterPlan("Launch compute is $0.106 per CU-hour", "Neon Launch", "Neon Launch")).toEqual({ span: "Launch compute is $0.106 per CU-hour", price: "$0.106 per CU-hour" });
  });
  it("Zoho: a not-comparable (currency) row is not presented as a confirmed pricing shift", () => {
    const zoho = row({ subject: "Zoho CRM", attribute: "Professional", status: "not_comparable", dimension: "currency", previousValue: "$23 per user/month, billed annually", currentValue: "₹1,400/user/month, billed annually", explanation: "Different currencies (USD vs INR); no monetary verdict.", sourceIds: ["S4"] });
    const live = "The only pricing shift we can confirm is Zoho’s move from USD to INR – the amount we quoted in USD is no longer directly comparable, while the new INR rate is ₹1 400/user/month [S4]. HubSpot is unchanged [S1].";
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: [zoho], planStatus: [], question: "" }));
    expect(out.text).toBe(
      "Zoho CRM Professional: the vendor's page shows ₹1,400/user/month, billed annually, which is on different terms from the earlier \"$23 per user/month, billed annually\" (Different currencies (USD vs INR); no monetary verdict), so this isn't evidence of a price change [S4]. HubSpot is unchanged [S1].",
    );
    const worse = "Zoho raised its price to ₹1,400/user/month [S4]. HubSpot is unchanged [S1].";
    const fixed = enforceAnswerFacts(worse, buildGuardRules({ comparisons: [zoho], planStatus: [], question: "" }));
    expect(fixed.text).toBe(
      "Zoho CRM Professional: the vendor's page shows ₹1,400/user/month, billed annually, which is on different terms from the earlier \"$23 per user/month, billed annually\" (Different currencies (USD vs INR); no monetary verdict), so this isn't evidence of a price change [S4]. HubSpot is unchanged [S1].",
    );
  });
  it("Postgres: 'The earlier answer was correct' is removed when a row shows a difference", () => {
    const neon = row({ subject: "Neon Launch", attribute: "Neon Launch", changeTiming: "unknown", previousValue: "$19 per month", currentValue: "$0.106 per CU-hour", sourceIds: ["S6"] });
    const supa = row({ subject: "Supabase Pro", attribute: "Supabase Pro", status: "unchanged", dimension: "price_amount", historicalAccuracy: "consistent", sourceIds: ["S2"] });
    const live = "Supabase Pro and Railway Hobby are unchanged at $25 per month and $5 per month respectively [S2][S4]. The earlier answer was correct for the date it was given.";
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: [neon, supa], planStatus: [], question: "" }));
    expect(out.text).not.toMatch(/earlier answer was correct/);
    expect(out.text).toMatch(/^Supabase Pro and Railway Hobby are unchanged/);
    // Allowed when it names only vendors without a difference.
    expect(enforceAnswerFacts("The earlier answer is still correct for Supabase Pro [S2].", buildGuardRules({ comparisons: [neon, supa], planStatus: [], question: "" })).applied).not.toContain("earlier-answer-correct");
  });
  it("repeated identical citations collapse", () => {
    expect(finalizeAnswer("Enterprise is $39 per seat/month [S1][S1][S1][S10].", []).text).toBe("Enterprise is $39 per seat/month [S1][S10].");
  });
});

describe("live run 2026-11-20 06:34: second pass", () => {
  const unv = (subject: string, attribute: string) => row({ subject, attribute, status: "uncertain", dimension: "evidence", evidenceIds: [], sourceIds: [] });
  it("CRM: 'all five remained on the same pricing tiers' is replaced when three prices couldn't be verified", () => {
    const rows = [unv("Salesforce Sales Cloud", "Sales Cloud Enterprise"), unv("Pipedrive", "Professional"), unv("Zoho CRM", "Professional")];
    const live = "HubSpot, Freshsales, Salesforce, Pipedrive and Zoho all remained on the same pricing tiers you saw on Monday; only Salesforce announced a major product update.\n\n- **HubSpot Sales Hub Professional**: $90 / seat (annual) – unchanged [S1].";
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: rows, planStatus: [], question: "" }));
    expect(out.text.split("\n")[0]).toBe(
      "I couldn't verify current prices for Salesforce Sales Cloud Enterprise, Pipedrive Professional or Zoho CRM Professional: no retrievable page stated a price for these plans, so I can't say whether they changed.",
    );
    expect(out.text).toContain("**HubSpot Sales Hub Professional**: $90 / seat (annual) – unchanged [S1].");
    // Already stated as unverified: left alone.
    const ok = "Salesforce Sales Cloud Enterprise, Pipedrive Professional, Zoho CRM Professional: no current evidence shows a price change, so the status is uncertain.";
    expect(enforceAnswerFacts(ok, buildGuardRules({ comparisons: rows, planStatus: [], question: "" })).applied).toEqual([]);
  });
  it("drops a stray bold marker", () => {
    expect(finalizeAnswer("Neon’s Launch tier changed to a usage-based model [S4].**\nAll **other** plans are unchanged.", []).text).toBe("Neon’s Launch tier changed to a usage-based model [S4].\nAll **other** plans are unchanged.");
  });
});

describe("live run 2026-11-20 06:39: Tavily markdown chunks", () => {
  it("parses a legacy table whose separator row doesn't start with '|' (exact Tavily chunk)", () => {
    const chunk =
      "## Which plans are legacy Cursor plans?\n\n| Legacy plan | Price | Comparable plan on The X Subscription |\n --- \n| Hobby | Free | Free |\n| Pro | $20/mo | Premium ($30/mo) |\n| Pro+ | $60/mo | Super ($100/mo) | [...] Switching to The X Subscription is optional and permanent.";
    expect(parseLegacyTable(chunk)!.rows.map((r) => `${r.plan} ${r.price} → ${r.comparable} ${r.comparablePrice ?? ""}`.trim())).toEqual([
      "Hobby Free → Free",
      "Pro $20/mo → Premium $30/mo",
      "Pro+ $60/mo → Super $100/mo",
    ]);
  });
  it("drops a citation-only fragment after a cited sentence", () => {
    expect(finalizeAnswer("The Cursor Pro plan is priced at $20 per month [S5] [S6]. [S5][S6][S7][S8][S9]", []).text).toBe("The Cursor Pro plan is priced at $20 per month [S5] [S6].");
  });
});

describe("live run 2026-11-20 06:43: no duplicate 'couldn't verify' statement when the model already said so", () => {
  it("recognises 'unclear whether' and 'can't say whether' as already stating it", () => {
    const rows = ["Salesforce Sales Cloud Enterprise", "Pipedrive Professional"].map((s) => row({ subject: s, attribute: s, status: "uncertain", dimension: "evidence", evidenceIds: [], sourceIds: [] }));
    const a = "Salesforce and Pipedrive have no current public price listed on the vendor’s own pages, so it’s unclear whether their costs have changed [S7][S6].";
    expect(enforceAnswerFacts(a, buildGuardRules({ comparisons: rows, planStatus: [], question: "" })).applied).toEqual([]);
    const pg = ["Render Postgres Basic-1gb", "AWS RDS for PostgreSQL"].map((s) => row({ subject: s, attribute: s, status: "uncertain", dimension: "evidence", evidenceIds: [], sourceIds: [] }));
    const b = "For **Render Postgres Basic‑1gb** and **AWS RDS for PostgreSQL (db.t4g.micro)** no current price information could be retrieved, so I can’t say whether those have changed [S10][S1].";
    expect(enforceAnswerFacts(b, buildGuardRules({ comparisons: pg, planStatus: [], question: "" })).applied).toEqual([]);
  });
});

describe("update extraction backstop (live 2026-11-20: Copilotforce found in 2 of 4 runs)", () => {
  const src = (id: string, kind: Source["kind"], title: string, publishedAt?: string): Source => ({ id, kind, title, url: `https://x.com/${id}`, snippet: "", rankScore: 1, retrievedAt: "2026-11-20T00:00:00Z", sourceDomain: "x.com", provider: "f", query: "q", ...(publishedAt ? { publishedAt } : {}) });
  it("a dated vendor page naming the subject after the conversation becomes a possible (unassessed) update", () => {
    const rows = compareProductUpdates(["Salesforce Sales Cloud", "Pipedrive", "Freshsales"], [], "2026-11-16T09:00:00Z", (s) => (s === "Freshsales" ? "not_run" : "checked"));
    const sources = [
      src("S8", "official_changelog", "Salesforce and Microsoft Announce Copilotforce", "2026-11-17T18:05:00Z"),
      src("S9", "official_changelog", "Pipedrive spring release", "2026-03-01T00:00:00Z"), // before the conversation
      src("S10", "third_party", "Freshsales news roundup", "2026-11-18T00:00:00Z"), // not vendor/news
    ];
    const out = addUnassessedUpdates(rows, sources, "2026-11-16T09:00:00Z");
    expect(out[0]).toMatchObject({ subject: "Salesforce Sales Cloud", status: "uncertain", attribute: "Possible update", currentValue: "Salesforce and Microsoft Announce Copilotforce", sourceIds: ["S8"] });
    expect(out[1]!.attribute).toBe("Major update");
    expect(out[2]!.explanation).toMatch(/^Not checked/);
  });
});

describe("final live run 2026-11-20 06:46: last prose defects", () => {
  // cursor.com/help/account-and-billing/pricing as fetched on 2026-11-20 (flattened): current plans, then the legacy table
  // whose "Comparable plan" cells carry no price.
  const help = [
    "What plans are available? ",
    " | | Plan", " | Price", " | Included usage",
    " | Free", " | $0", " | Limited",
    " | Plus", " | $8/mo", " | Base",
    " | Premium", " | $30/mo", " | 4x Plus",
    " | Super", " | $100/mo", " | 15x Plus",
    " What are the legacy Cursor plans? ",
    " Legacy Cursor plans are the plans Cursor sold before The X Subscription. They aren't available to new customers, but existing subscribers keep them until they switch or cancel.",
    " | | Legacy plan", " | Price", " | Comparable plan on The X Subscription",
    " | Pro", " | $20/mo", " | Premium",
    " | Pro+", " | $60/mo", " | Super",
    " Legacy plans include two monthly usage pools.",
  ].join("\n");
  it("prices the successor from the vendor's current-plans table when the legacy table names it without a price", () => {
    expect(parsePlanPriceTable(help).slice(0, 3)).toEqual([{ plan: "Free", price: "$0" }, { plan: "Plus", price: "$8/mo" }, { plan: "Premium", price: "$30/mo" }]);
    const src = { id: "S1", kind: "official_pricing" as const, rankScore: 1, title: "Pricing", url: "https://cursor.com/help/account-and-billing/pricing", snippet: "", content: help, retrievedAt: "2026-11-20T00:00:00Z", sourceDomain: "cursor.com", provider: "f", query: "q", subject: "Cursor" };
    const pro = assessPlanStatus([], [src]).find((n) => n.plan === "Pro")!;
    expect(pro).toMatchObject({ value: "$20/mo", successor: { plan: "Premium", value: "$30/mo", sourceId: "S1" } });
    const out = enforceAnswerFacts("Cursor Pro ($20/mo) is a legacy plan that new customers can no longer buy [S1].", buildGuardRules({ comparisons: [], planStatus: [pro], question: "What is the current price of the Cursor Pro plan?" }));
    expect(out.text).toMatch(/closest current tier is Premium at \$30\/mo \[S1\]/);
  });
  it("CRM: launch claims for vendors whose rows found nothing dated after the conversation are replaced", () => {
    const rows = compareProductUpdates(["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM"], [], "2026-11-16T09:00:00Z", () => "checked");
    const live = [
      "**Product updates** ",
      "* HubSpot released a foundational product update on 12 Nov 2026 that added a new way to work for teams[S9]. ",
      "* Pipedrive added the ability to attach up to 50 custom fields to activity records in its Autumn 2026 release[S11]. ",
      "* Salesforce expanded its Agentforce Coworker platform with new AI features in early November 2026[S5]. ",
      "* No major updates were found for Zoho CRM since the conversation. ",
    ].join("\n");
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: rows, planStatus: [], question: "Has any of them shipped something big since?" }));
    expect(out.text).not.toMatch(/HubSpot released|Pipedrive added|Salesforce expanded/);
    expect(out.text).toContain("* Nothing dated after our conversation was found for HubSpot, Pipedrive, Salesforce or Zoho CRM; items in the sources are older or undated, so they aren't changes since then.");
    expect(out.text).toContain("* No major updates were found for Zoho CRM since the conversation.");
  });
  it("a launch backed by a 'changed' update row is left alone", () => {
    const rows = [row({ subject: "Salesforce", category: "product_update", attribute: "Major update", status: "changed", dimension: "feature", sourceIds: ["S8"] })];
    expect(enforceAnswerFacts("Salesforce announced Copilotforce on 17 Nov [S8].", buildGuardRules({ comparisons: rows, planStatus: [], question: "" })).applied).toEqual([]);
  });
  it("removes fullwidth-bracket placeholders but keeps fullwidth source ids for the citation filter", () => {
    expect(finalizeAnswer("A change can't be verified【comparisons]. See 【S2】.", []).text).toBe("A change can't be verified. See 【S2】.");
  });
});

describe("live run 2026-11-20 06:52: noun-phrase launch claims and 'remains as it was'", () => {
  it("removes 'major product update in Oct 2026' and 'pricing for all five remains as it was' when rows say otherwise", () => {
    const subjects = ["HubSpot Sales Hub", "Salesforce Sales Cloud", "Pipedrive", "Zoho CRM", "Freshsales"];
    const updates = compareProductUpdates(subjects, [], "2026-11-16T09:00:00Z", () => "checked");
    const unv = ["Salesforce Sales Cloud", "Pipedrive", "Zoho CRM"].map((s) => row({ subject: s, attribute: "Professional", status: "uncertain", dimension: "evidence", evidenceIds: [], sourceIds: [] }));
    const live = [
      "**Changes since then:** ",
      "- **HubSpot:** pricing unchanged; major product update in Oct 2026 (new UI, AI call summaries, etc.) [S9] ",
      "- **Freshsales:** pricing unchanged; no major update found. ",
      "",
      "So, only HubSpot had a notable update; pricing for all five remains as it was on Monday, except for the lack of confirmed changes for the other four vendors.",
    ].join("\n");
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: [...unv, ...updates], planStatus: [], question: "" }));
    expect(out.text).not.toMatch(/major product update in Oct 2026/);
    expect(out.text).not.toMatch(/remains as it was/);
    expect(out.text).toContain("- **Freshsales:** pricing unchanged; no major update found.");
  });
});

describe("app run 2026-11-20: no duplicate statement when the fact is in the same bullet", () => {
  it("accepts 'already out of date' stated in the bullet that names Neon, across a sentence boundary", () => {
    const neon = row({ subject: "Neon Launch", attribute: "Neon Launch", status: "uncertain", historicalAccuracy: "already_outdated", changeTiming: "before_conversation", sourceIds: ["S4", "S6"], explanation: "The vendor's own page (dated 2025-08-14) already listed it." });
    const a = "**Changes that can be verified**\n- Neon’s pricing model is now usage‑based ($0.106 / CU‑hour) [S4][S6]. The earlier answer was already out of date before the conversation, so it does not reflect a change since then.\n\n**Unchanged**\n- Supabase Pro remains $25 / month [S1].";
    expect(enforceAnswerFacts(a, buildGuardRules({ comparisons: [neon], planStatus: [], question: "" })).text).toBe(a);
  });
});

describe("app run 2026-11-20 (final): bare 'Yes.' and context-tag citations", () => {
  const neon = row({ subject: "Neon", attribute: "Launch", status: "uncertain", historicalAccuracy: "already_outdated", changeTiming: "before_conversation", sourceIds: ["S6"], explanation: "x" });
  it("drops a bare 'Yes.' when the only difference predates the conversation", () => {
    const a = "Yes. Neon’s Launch plan now uses a usage‑based model; the earlier answer was already out of date [S6].";
    expect(enforceAnswerFacts(a, buildGuardRules({ comparisons: [neon], planStatus: [], question: "" })).text).toBe("Neon’s Launch plan now uses a usage‑based model; the earlier answer was already out of date [S6].");
    const after = row({ subject: "HubSpot", attribute: "Pro", status: "changed", dimension: "price_amount", changeTiming: "after_conversation", sourceIds: ["S1"] });
    expect(enforceAnswerFacts(a, buildGuardRules({ comparisons: [neon, after], planStatus: [], question: "" })).text.startsWith("Yes.")).toBe(true);
  });
  it("removes context-tag 'citations' but keeps markdown links and source ids", () => {
    expect(finalizeAnswer("Salesforce, Pipedrive, Zoho: any change is *uncertain* [comparisons] [S2]. See [evidence](https://x.com/a).", ["https://x.com/a"]).text).toBe(
      "Salesforce, Pipedrive, Zoho: any change is *uncertain* [S2]. See [evidence](https://x.com/a).",
    );
  });
});

describe("final live run 2026-11-20 07:0x: update authority and blunt negation", () => {
  const upd = (subject: string, kind: Evidence["sourceKind"], publishedAt: string, value = "Zoho Desk adds Blended Agents"): Evidence =>
    ev({ id: `u_${subject}_${kind}`, subject, category: "product_update", attribute: "update", value, quote: value, sourceId: kind === "third_party" ? "S11" : "S8", sourceKind: kind, publishedAt, significance: "major" });
  it("a dated third-party post is a possible update, never 'changed'", () => {
    const [z] = compareProductUpdates(["Zoho CRM"], [upd("Zoho CRM", "third_party", "2026-11-16T12:00:00Z")], "2026-11-16T09:00:00Z");
    expect(z).toMatchObject({ status: "uncertain", attribute: "Possible update", sourceIds: ["S11"] });
    expect(z!.explanation).toMatch(/third-party page published 2026-11-16; not confirmed/);
    const [s] = compareProductUpdates(["Salesforce"], [upd("Salesforce", "official_changelog", "2026-11-17T12:00:00Z", "Copilotforce")], "2026-11-16T09:00:00Z");
    expect(s).toMatchObject({ status: "changed", sourceIds: ["S8"] });
  });
  it("'HubSpot announced … — the latter not affecting …' is still a launch claim", () => {
    const rows = compareProductUpdates(["HubSpot", "Pipedrive"], [], "2026-11-16T09:00:00Z", () => "checked");
    const live = "Feature updates since then are incremental: HubSpot announced buying-group functionality in November 2026 [S9], and Pipedrive added custom-field support [S10]—the latter not affecting the core plans.";
    const out = enforceAnswerFacts(live, buildGuardRules({ comparisons: rows, planStatus: [], question: "" }));
    expect(out.text).toBe("Nothing dated after our conversation was found for HubSpot or Pipedrive; items in the sources are older or undated, so they aren't changes since then.");
    // A sentence that says updates are absent is left alone.
    expect(enforceAnswerFacts("No major updates were found for HubSpot or Pipedrive since the conversation.", buildGuardRules({ comparisons: rows, planStatus: [], question: "" })).applied).toEqual([]);
  });
});
