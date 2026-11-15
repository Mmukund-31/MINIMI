import { describe, expect, it } from "vitest";
import { comparePrices, comparePricing, compareProductUpdates, parsePrice, planMatches, type Evidence, type HistoricalClaim } from "@minimi/core";

describe("parsePrice", () => {
  it("extracts amount, currency, unit, period and billing", () => {
    expect(parsePrice("$90 per seat/month, billed annually")).toMatchObject({ amount: 90, currency: "USD", perSeat: true, period: "month", billing: "annual" });
    expect(parsePrice("€25/mo")).toMatchObject({ amount: 25, currency: "EUR", period: "month", billing: null });
    expect(parsePrice("$175 USD/user/month (billed annually)")).toMatchObject({ amount: 175, currency: "USD", perSeat: true, billing: "annual" });
    expect(parsePrice("about $0.016 per hour")).toMatchObject({ amount: 0.016, period: "hour" });
    expect(parsePrice("$1,200/year")).toMatchObject({ amount: 1200, period: "year", billing: "annual" });
    expect(parsePrice("£19 a month, billed monthly")).toMatchObject({ amount: 19, currency: "GBP", billing: "monthly" });
  });

  it("detects free, custom and floor prices", () => {
    expect(parsePrice("Free forever")).toMatchObject({ isFree: true, amount: null });
    expect(parsePrice("Contact sales")).toMatchObject({ isCustom: true });
    expect(parsePrice("usage-based, from $5/month minimum")).toMatchObject({ amount: 5, isFloor: true });
  });
});

describe("comparePrices", () => {
  const p = parsePrice;
  it("unchanged on identical comparable terms", () => {
    expect(comparePrices(p("$23 per user/month, billed annually"), p("$23 /user/month billed annually")).status).toBe("unchanged");
  });
  it("changed when comparable amounts differ", () => {
    const r = comparePrices(p("$90 per seat/month, billed annually"), p("$100 per seat/month, billed annually"));
    expect(r.status).toBe("changed");
    expect(r.explanation).toContain("+11%");
  });
  it("not comparable across currencies, periods or billing terms", () => {
    expect(comparePrices(p("$25/month"), p("€25/month")).status).toBe("not_comparable");
    expect(comparePrices(p("$25/month"), p("$250/year")).status).toBe("not_comparable");
    expect(comparePrices(p("$20/month billed annually"), p("$25/month billed monthly")).status).toBe("not_comparable");
  });
  it("uncertain when one side omits billing terms and the amounts differ", () => {
    expect(comparePrices(p("$20 per user/month, billed annually"), p("$25 per user/month")).status).toBe("uncertain");
  });
  it("uncertain when comparing a flat price with a floor price", () => {
    expect(comparePrices(p("$19 per month"), p("from $5/month minimum")).status).toBe("uncertain");
  });
});

describe("planMatches", () => {
  it("matches equivalent plan names and rejects different ones", () => {
    expect(planMatches("Sales Hub Professional", "Professional plan")).toBe(true);
    expect(planMatches("Pro", "Supabase Pro")).toBe(true);
    expect(planMatches("Professional", "Growth")).toBe(false);
    expect(planMatches("Enterprise", "Enterprise Plus")).toBe(true);
  });
});

const claim = (subject: string, attribute: string, value: string): HistoricalClaim => ({
  subject,
  category: "pricing",
  attribute,
  value,
  messageId: "msg_1",
  statedAt: "2026-11-09T10:00:00Z",
});
let n = 0;
const ev = (subject: string, attribute: string, value: string, kind: Evidence["sourceKind"] = "official_pricing", extra: Partial<Evidence> = {}): Evidence => ({
  id: `ev_${++n}`,
  claim: "",
  subject,
  category: "pricing",
  attribute,
  value,
  quote: value,
  sourceId: `S${n}`,
  sourceUrl: `https://example.com/${n}`,
  sourceTitle: "t",
  sourceKind: kind,
  retrievedAt: "2026-11-15T00:00:00Z",
  evidenceType: "current",
  strength: "strong",
  ...extra,
});

describe("comparePricing", () => {
  it("reports uncertain (not unchanged) when no current evidence exists", () => {
    const [c] = comparePricing([claim("Freshsales", "Pro", "$39 per user/month")], []);
    expect(c!.status).toBe("uncertain");
  });

  it("refuses to compare a different plan (reports uncertain and lists current plans)", () => {
    const [c] = comparePricing([claim("Pipedrive", "Professional", "$49 per seat/month, billed annually")], [ev("Pipedrive", "Growth", "$39 per seat/month billed annually")]);
    expect(c!.status).toBe("uncertain");
    expect(c!.currentValue).toBeUndefined();
    expect(c!.explanation).toContain("Growth");
  });

  it("matches a generic 'price' label only when the vendor has a single current price", () => {
    const [one] = comparePricing([claim("Render", "price", "$19 per month")], [ev("Render", "Basic-1gb", "$19/month")]);
    expect(one!.status).toBe("unchanged");
    const [many] = comparePricing([claim("Neon", "price", "$19 per month")], [ev("Neon", "Launch", "$0.106 per CU-hour"), ev("Neon", "Scale", "$0.222 per CU-hour")]);
    expect(many!.status).toBe("uncertain");
  });

  it("prefers official sources over third-party ones and notes the disagreement", () => {
    const [c] = comparePricing(
      [claim("HubSpot", "Professional", "$90 per seat/month, billed annually")],
      [ev("HubSpot", "Professional", "$90 per seat/month, billed annually", "third_party"), ev("HubSpot Sales Hub", "Sales Hub Professional", "$100 per seat/month, billed annually")],
    );
    expect(c!.status).toBe("changed");
    expect(c!.currentValue).toContain("$100");
    expect(c!.explanation).toMatch(/less authoritative/);
  });

  it("marks conflicting equally-authoritative sources as uncertain", () => {
    const [c] = comparePricing(
      [claim("Acme", "Pro", "$20 per user/month, billed annually")],
      [ev("Acme", "Pro", "$25 per user/month, billed annually"), ev("Acme", "Pro", "$30 per user/month, billed annually")],
    );
    expect(c!.status).toBe("uncertain");
    expect(c!.explanation).toMatch(/disagree/);
  });

  it("qualifies conclusions drawn only from third-party sources", () => {
    const [c] = comparePricing([claim("Acme", "Pro", "$20/month")], [ev("Acme", "Pro", "$20/month", "third_party")]);
    expect(c!.status).toBe("unchanged");
    expect(c!.explanation).toMatch(/third-party/);
  });
});

describe("compareProductUpdates", () => {
  const upd = (subject: string, publishedAt: string | undefined, significance: "major" | "minor" = "major") =>
    ev(subject, "update", `${subject} launch`, "official_changelog", { category: "product_update", publishedAt, significance });

  it("counts only major updates published after the baseline as changes", () => {
    const out = compareProductUpdates(["HubSpot", "Salesforce"], [upd("HubSpot", "2026-11-12T00:00:00Z"), upd("Salesforce", "2025-09-18T00:00:00Z")], "2026-11-09T10:00:00Z");
    expect(out.find((c) => c.subject === "HubSpot")!.status).toBe("changed");
    const sf = out.find((c) => c.subject === "Salesforce")!;
    expect(sf.status).toBe("uncertain");
    expect(sf.explanation).toMatch(/isn't proof/);
  });

  it("treats undated updates as uncertain and ignores minor ones", () => {
    const out = compareProductUpdates(["Zoho"], [upd("Zoho", undefined), upd("Zoho", "2026-11-12T00:00:00Z", "minor")], "2026-11-09T10:00:00Z");
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("uncertain");
    expect(out[0]!.explanation).toMatch(/no publication date/);
  });
});
