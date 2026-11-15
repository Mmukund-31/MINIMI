import { describe, expect, it } from "vitest";
import { locatePriceSpan, normalizeClaims, planMatches } from "@minimi/core";

describe("normalizeClaims (deterministic repair of model slips)", () => {
  const subjects = [
    { name: "HubSpot Sales Hub", officialDomain: null },
    { name: "Neon", officialDomain: null },
  ];
  it("moves a price out of the plan field and splits the plan out of the subject", () => {
    const [c] = normalizeClaims(
      [{ subject: "HubSpot Sales Hub Professional", category: "pricing", attribute: "$90 per seat/month, billed annually", value: "Professional", messageId: "m" }],
      subjects,
    );
    expect(c).toMatchObject({ subject: "HubSpot Sales Hub", attribute: "Professional", value: "$90 per seat/month, billed annually" });
  });
  it("strips a repeated vendor name from the plan", () => {
    const [c] = normalizeClaims([{ subject: "Neon", category: "pricing", attribute: "Neon Launch", value: "$19 per month", messageId: "m" }], subjects);
    expect(c).toMatchObject({ subject: "Neon", attribute: "Launch" });
  });
  it("falls back to a generic label when no plan can be recovered", () => {
    const [c] = normalizeClaims(
      [{ subject: "HubSpot Sales Hub", category: "pricing", attribute: "$90 per seat/month", value: "$90 per seat/month", messageId: "m" }],
      subjects,
    );
    expect(c!.attribute).toBe("price");
  });
});

describe("planMatches with vendor context", () => {
  it("ignores vendor words and filler", () => {
    expect(planMatches("Launch (usage-based)", "Neon Launch", "Neon")).toBe(true);
    expect(planMatches("db.t4g.micro", "(db.t4g.micro)", "AWS RDS for PostgreSQL")).toBe(true);
    expect(planMatches("Pro+", "Pro", "Copilot")).toBe(false);
    expect(planMatches("Growth", "Professional", "Pipedrive")).toBe(false);
  });
  it("still works when the model folded the plan into the subject", () => {
    expect(planMatches("Professional", "HubSpot Sales Hub Professional", "HubSpot Sales Hub Professional")).toBe(true);
    expect(planMatches("Starter", "HubSpot Sales Hub Professional", "HubSpot Sales Hub Professional")).toBe(false);
  });
});

describe("locatePriceSpan", () => {
  const table = "| Plan | Price |\n| Free | $0 |\n| Pro | $25 / month per organization |\n| Team | $599 / month |";
  it("recovers the genuine span when the model paraphrased", () => {
    expect(locatePriceSpan(table, "Pro plan", "$25/month", "Supabase")).toBe("pro $25 month per organization team");
  });
  it("refuses when the first price after the plan name differs (no cross-row attribution)", () => {
    expect(locatePriceSpan(table, "Pro", "$599 / month")).toBeNull();
    expect(locatePriceSpan("Professional $23 /user/month. Enterprise $40 /user/month", "Enterprise", "$52 /user/month")).toBeNull();
  });
  it("matches whole words only", () => {
    expect(locatePriceSpan("Professional $49 per seat", "Pro", "$49")).toBeNull();
  });
});
