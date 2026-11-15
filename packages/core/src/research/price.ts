/**
 * Deterministic price parsing. Extracts the comparable dimensions of a price
 * statement so the change detector never compares unlike terms.
 */
export type Currency = "USD" | "EUR" | "GBP" | "INR" | "JPY" | "AUD" | "CAD";
export type Period = "month" | "year" | "hour" | "one_time";
export type Billing = "monthly" | "annual";

export interface ParsedPrice {
  raw: string;
  amount: number | null;
  currency: Currency | null;
  period: Period | null;
  billing: Billing | null;
  perSeat: boolean;
  isFree: boolean;
  isCustom: boolean;
  /** "from $X", "starting at", "minimum": a floor, not a flat price. */
  isFloor: boolean;
  /** Metered unit for usage-based prices ("cu-hour", "gb", "million requests"); null for plan prices. */
  usageUnit: string | null;
}

/** Units that describe who/what a plan price covers (not metered usage). */
const PLAN_UNITS = new Set([
  "user", "users", "seat", "seats", "member", "members", "editor", "agent", "agents", "license", "licence",
  "month", "mo", "mon", "year", "yr", "annum", "hour", "hr", "organization", "organisation", "org", "project",
  "workspace", "team", "account", "instance", "database", "developer", "person", "active", "billed",
]);

/** Adjectives that can precede a plan unit ("per granted seat", "per active user"). */
const UNIT_ADJECTIVES = new Set(["calendar", "granted", "active", "additional", "extra", "paid", "licensed", "named", "full", "core", "monthly", "annual", "each"]);

function detectUsageUnit(s: string): string | null {
  for (const m of s.matchAll(/(?:\bper\b|\/)\s*((?:\d+(?:[.,]\d+)?\s*[km]?\s+)?(?:[a-z][a-z0-9-]*\s+){0,2}[a-z][a-z0-9-]*)/g)) {
    const words = m[1]!.trim().replace(/^[\d.,]+\s*[km]?\s+/, "").split(/\s+/);
    // Skip leading adjectives; the first remaining word is the unit.
    const head = words.find((w) => !UNIT_ADJECTIVES.has(w)) ?? words[0]!;
    if (PLAN_UNITS.has(head)) continue;
    return words.slice(words.indexOf(head), words.indexOf(head) + 1).join(" ");
  }
  return null;
}

const SYMBOLS: Record<string, Currency> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };
const CODES: Record<string, Currency> = { usd: "USD", eur: "EUR", gbp: "GBP", inr: "INR", jpy: "JPY", aud: "AUD", cad: "CAD", "us$": "USD", a$: "AUD", c$: "CAD" };

const AMOUNT = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";

export function parsePrice(input: string): ParsedPrice {
  const raw = input.trim();
  const s = raw.toLowerCase();
  let amount: number | null = null;
  let currency: Currency | null = null;

  const sym = new RegExp(`(us\\$|a\\$|c\\$|[$€£₹¥])\\s?${AMOUNT}(\\s?[km]\\b)?`, "i").exec(raw);
  const code = new RegExp(`\\b(usd|eur|gbp|inr|jpy|aud|cad)\\s?${AMOUNT}|${AMOUNT}\\s?(usd|eur|gbp|inr|jpy|aud|cad)\\b`, "i").exec(raw);
  if (sym) {
    const symbol = sym[1]!.toLowerCase();
    currency = SYMBOLS[symbol] ?? CODES[symbol] ?? null;
    amount = toNumber(sym[2]!, sym[3]);
  } else if (code) {
    if (code[1]) {
      currency = CODES[code[1].toLowerCase()] ?? null;
      amount = toNumber(code[2]!);
    } else {
      currency = CODES[code[4]!.toLowerCase()] ?? null;
      amount = toNumber(code[3]!);
    }
  }

  // The period belongs to the matched amount: look right after it first ("$0.016 per hour (~$12/month)"
  // is hourly), then fall back to the whole statement.
  const amountEnd = sym ? sym.index + sym[0].length : code ? code.index + code[0].length : 0;
  const period = detectPeriod(s.slice(amountEnd, amountEnd + 32)) ?? detectPeriod(s);

  let billing: Billing | null = null;
  if (/(billed\s+(annually|yearly)|annual(ly)?\s+(billing|plan|commitment|contract)|paid\s+(annually|yearly)|\bannually\b|\bper\s+year,?\s+billed)/.test(s)) billing = "annual";
  else if (/(billed\s+monthly|month[-\s]to[-\s]month|monthly\s+billing|paid\s+monthly)/.test(s)) billing = "monthly";
  // "$X/year" with no other billing info implies annual billing.
  if (!billing && period === "year") billing = "annual";

  const perSeat = /(per\s+(?:(?:granted|active|additional|paid|licensed|named|full)\s+)?(user|seat|member|editor|agent|license|licence|developer)|\/\s?(user|seat|member|editor|agent)\b|each\s+(user|seat))/.test(s);
  const isCustom = /(contact\s+(sales|us)|custom\s+(pricing|quote)|\bquote\b|talk\s+to\s+sales)/.test(s) && amount === null;
  const isFree = (amount === 0) || (amount === null && /\bfree\b/.test(s));
  const isFloor = /(\bfrom\b|starting\s+(at|from)|starts\s+at|\bminimum\b|\bmin\.?\b|or\s+more|\+\s*usage|plus\s+usage)/.test(s);

  const usageUnit = detectUsageUnit(s);

  return { raw, amount, currency, period, billing, perSeat, isFree, isCustom, isFloor, usageUnit };
}

function detectPeriod(s: string): Period | null {
  // Earliest-occurring period phrase wins.
  const candidates: Array<[Period, RegExp]> = [
    ["month", /(\/\s?(mo|mon|month)\b|per\s+(?:\w+\s+)?month|a\s+month|\bmonthly\b|\bmo\.)/],
    ["year", /(\/\s?(yr|year)\b|per\s+(?:\w+\s+)?year|a\s+year|\byearly\b|per\s+annum)/],
    ["hour", /(\/\s?(hr|hour)\b|per\s+hour|an\s+hour|\bhourly\b)/],
    ["one_time", /(one[-\s]time|lifetime)/],
  ];
  let best: { p: Period; at: number } | null = null;
  for (const [p, re] of candidates) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.at)) best = { p, at: m.index };
  }
  return best?.p ?? null;
}

function toNumber(n: string, suffix?: string): number {
  let v = Number.parseFloat(n.replace(/,/g, ""));
  const suf = suffix?.trim().toLowerCase();
  if (suf === "k") v *= 1_000;
  if (suf === "m") v *= 1_000_000;
  return v;
}

/** Returns the first numeric amount in a string (for quote ⟷ value consistency checks). */
export function extractNumbers(s: string): number[] {
  return [...s.replace(/,(?=\d{3}\b)/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number.parseFloat(m[0]));
}

export function formatParsed(p: ParsedPrice): string {
  if (p.isCustom) return "custom pricing";
  if (p.isFree && p.amount === null) return "free";
  const bits = [p.amount !== null ? `${p.currency ?? "?"} ${p.amount}` : "?", p.perSeat ? "per seat" : "", p.period ? `per ${p.period}` : "", p.billing ? `billed ${p.billing}` : ""];
  return bits.filter(Boolean).join(" ");
}
