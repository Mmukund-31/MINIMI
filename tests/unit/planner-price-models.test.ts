import { describe, expect, it } from "vitest";
import { comparePrices, finalizeSearchPlan, parsePrice, staleYear, updateSearchedSubjects, wantsUpdateCheck } from "@minimi/core";

describe("finalizeSearchPlan", () => {
  const subjects = [
    { name: "HubSpot", officialDomain: null },
    { name: "Zoho CRM", officialDomain: null },
  ];
  it("adds an update search per subject when updates were asked about, pricing first", () => {
    const out = finalizeSearchPlan(
      { subjects, historicalClaims: [], searches: [{ query: "HubSpot pricing", purpose: "pricing", subject: "HubSpot" }, { query: "hubspot  PRICING", purpose: "pricing", subject: "HubSpot" }, { query: "Zoho CRM pricing", purpose: "pricing", subject: "Zoho CRM" }] },
      { wantsUpdates: true, maxSearches: 10, monthYear: "November 2026" },
    );
    expect(out.map((s) => s.query)).toEqual(["HubSpot pricing", "Zoho CRM pricing", "HubSpot new features announcement November 2026", "Zoho CRM new features announcement November 2026"]);
  });
  it("never exceeds the budget and keeps price checks when the budget is tight", () => {
    const out = finalizeSearchPlan(
      { subjects, historicalClaims: [], searches: [{ query: "HubSpot pricing", purpose: "pricing", subject: "HubSpot" }, { query: "Zoho CRM pricing", purpose: "pricing", subject: "Zoho CRM" }] },
      { wantsUpdates: true, maxSearches: 3, monthYear: "November 2026" },
    );
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).every((s) => s.purpose === "pricing")).toBe(true);
    const searched = updateSearchedSubjects(out, new Set(out.map((s) => s.query)));
    expect(searched("HubSpot")).toBe(true);
    expect(searched("Zoho CRM")).toBe(false);
  });
});

describe("price models never yield false 'changed'", () => {
  const p = parsePrice;
  it("flat monthly plan vs metered rate is not comparable", () => {
    expect(p("$0.106 per CU-hour").usageUnit).toBe("cu-hour");
    expect(comparePrices(p("$19 per month"), p("$0.106 per CU-hour")).status).toBe("not_comparable");
    expect(comparePrices(p("$0.10 per GB"), p("$0.12 per GB")).status).toBe("changed");
  });
  it("per-seat price vs a team total is not comparable", () => {
    expect(comparePrices(p("$190 per month ($2,280/yr)"), p("$19 per user per month")).status).toBe("not_comparable");
  });
  it("one side missing the period blocks a 'changed' verdict", () => {
    expect(comparePrices(p("$25"), p("$30 per month")).status).toBe("uncertain");
  });
  it("takes the period that belongs to the amount, not a parenthetical estimate", () => {
    expect(p("about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage")).toMatchObject({ amount: 0.016, period: "hour" });
    expect(comparePrices(p("about $0.016 per hour on-demand (~$12/month)"), p("$0.016/hr")).status).toBe("unchanged");
    expect(p("$90 per seat/month, billed annually").period).toBe("month");
  });
  it("plan-scope words are not usage units", () => {
    expect(p("$25 / month per organization").usageUnit).toBeNull();
    expect(p("$19 per user / month").usageUnit).toBeNull();
  });
});

describe("staleYear", () => {
  it("flags pages whose title/URL names an older year", () => {
    expect(staleYear("How much does Pipedrive cost in 2024?", "2026-11-15T00:00:00Z")).toBe(2024);
    expect(staleYear("Freshsales Pricing 2026", "2026-11-15T00:00:00Z")).toBeNull();
    expect(staleYear("Pricing | Render", "2026-11-15T00:00:00Z")).toBeNull();
  });
});

describe("wantsUpdateCheck", () => {
  it("is triggered by launch/update wording and by 'still correct'", () => {
    expect(wantsUpdateCheck("Has any of them shipped something big since?")).toBe(true);
    expect(wantsUpdateCheck("Is your answer still correct today?")).toBe(true);
    expect(wantsUpdateCheck("Has any pricing changed since then?")).toBe(false);
  });
});
