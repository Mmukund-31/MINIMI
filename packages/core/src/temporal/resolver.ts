import { DateTime } from "luxon";

/**
 * Deterministic temporal resolver.
 *
 * Turns expressions like "last Tuesday", "on Monday", "3 November",
 * "three days ago" or "earlier this month" into concrete UTC ranges,
 * evaluated in the conversation's IANA timezone.
 *
 * Design rules:
 *  - Pure function of (text, now, timezone): fully unit-testable.
 *  - Never silently picks one reading of an ambiguous expression; it returns
 *    ordered candidates and `ambiguous: true` so retrieval can try them and
 *    the answer can say which interpretation was used.
 *  - Dates without a year resolve to the most recent past occurrence.
 */

export interface TemporalCandidate {
  /** Inclusive start, UTC ISO. */
  startUtc: string;
  /** Exclusive end, UTC ISO. */
  endUtc: string;
  /** Local calendar dates (YYYY-MM-DD) for display/tests. */
  startLocalDate: string;
  endLocalDate: string;
  label: string;
  interpretation: string;
}

export type TemporalKind = "day" | "range" | "since_last_discussion";

export interface TemporalReference {
  expression: string;
  kind: TemporalKind;
  candidates: TemporalCandidate[];
  ambiguous: boolean;
}

export interface TemporalResolution {
  references: TemporalReference[];
  unresolved: string[];
  nowLocal: string;
  timezone: string;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3,
};

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)";
const NUM_RE = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)";

function weekdayIndex(token: string): number {
  const t = token.toLowerCase();
  return WEEKDAYS.findIndex((w) => w.startsWith(t.slice(0, 3))) + 1; // luxon: 1 = Monday
}

function monthIndex(token: string): number {
  return MONTHS.indexOf(token.toLowerCase().slice(0, 3) as (typeof MONTHS)[number]) + 1;
}

function parseNumber(token: string): number {
  const t = token.toLowerCase();
  return NUMBER_WORDS[t] ?? Number.parseInt(t, 10);
}

function dayCandidate(day: DateTime, interpretation: string): TemporalCandidate {
  const start = day.startOf("day");
  const end = start.plus({ days: 1 });
  return {
    startUtc: start.toUTC().toISO()!,
    endUtc: end.toUTC().toISO()!,
    startLocalDate: start.toISODate()!,
    endLocalDate: start.toISODate()!,
    label: start.toFormat("cccc, d LLLL yyyy"),
    interpretation,
  };
}

function rangeCandidate(start: DateTime, endExclusive: DateTime, interpretation: string): TemporalCandidate {
  const s = start;
  const e = endExclusive;
  const lastDay = e.minus({ milliseconds: 1 });
  return {
    startUtc: s.toUTC().toISO()!,
    endUtc: e.toUTC().toISO()!,
    startLocalDate: s.toISODate()!,
    endLocalDate: lastDay.toISODate()!,
    label: `${s.toFormat("d LLL yyyy")} – ${lastDay.toFormat("d LLL yyyy")}`,
    interpretation,
  };
}

/** Most recent date with the given weekday strictly before `today`. */
function previousWeekday(today: DateTime, weekday: number): DateTime {
  let diff = today.weekday - weekday;
  if (diff <= 0) diff += 7;
  return today.minus({ days: diff });
}

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, today: DateTime, now: DateTime) => Omit<TemporalReference, "expression"> | null;
}

const rules: Rule[] = [
  // "since our last discussion", "since we last spoke", "last time we talked"
  {
    re: /\b(since (?:our|the) last (?:discussion|conversation|chat|talk)|since (?:we|i) last (?:spoke|talked|chatted|discussed)|(?:the )?last time we (?:spoke|talked|chatted)|our (?:last|previous) (?:discussion|conversation|chat))\b/gi,
    resolve: () => ({ kind: "since_last_discussion", candidates: [], ambiguous: false }),
  },
  // ISO date 2025-11-03
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m, today) => {
      const d = DateTime.fromObject({ year: +m[1]!, month: +m[2]!, day: +m[3]! }, { zone: today.zone });
      return d.isValid ? { kind: "day", candidates: [dayCandidate(d, "explicit ISO date")], ambiguous: false } : null;
    },
  },
  // "3 November", "3rd of Nov", "3 November 2025"
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?\\b`, "gi"),
    resolve: (m, today) => explicitDate(+m[1]!, monthIndex(m[2]!), m[3] ? +m[3] : undefined, today),
  },
  // "November 3", "Nov 3rd, 2025"
  {
    re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"),
    resolve: (m, today) => explicitDate(+m[2]!, monthIndex(m[1]!), m[3] ? +m[3] : undefined, today),
  },
  // "day before yesterday"
  {
    re: /\b(the )?day before yesterday\b/gi,
    resolve: (_m, today) => ({ kind: "day", candidates: [dayCandidate(today.minus({ days: 2 }), "two days before today")], ambiguous: false }),
  },
  {
    re: /\byesterday\b/gi,
    resolve: (_m, today) => ({ kind: "day", candidates: [dayCandidate(today.minus({ days: 1 }), "the day before today")], ambiguous: false }),
  },
  {
    re: /\b(earlier today|this morning|this afternoon|today)\b/gi,
    resolve: (_m, today) => ({ kind: "day", candidates: [dayCandidate(today, "today")], ambiguous: false }),
  },
  // "last 3 days", "past 7 days", "past two weeks"
  {
    re: new RegExp(`\\b(?:the\\s+)?(?:last|past|previous)\\s+${NUM_RE}\\s+(day|week)s?\\b`, "gi"),
    resolve: (m, today, now) => {
      const n = parseNumber(m[1]!);
      if (!Number.isFinite(n) || n <= 0) return null;
      const days = m[2]!.toLowerCase() === "week" ? n * 7 : n;
      const start = today.minus({ days });
      return { kind: "range", candidates: [rangeCandidate(start, now.plus({ minutes: 1 }), `rolling ${days} days up to now`)], ambiguous: false };
    },
  },
  // "3 days ago", "a week ago", "two weeks ago", "a month ago"
  {
    re: new RegExp(`\\b${NUM_RE}\\s+(day|week|month)s?\\s+ago\\b`, "gi"),
    resolve: (m, today) => {
      const n = parseNumber(m[1]!);
      if (!Number.isFinite(n) || n <= 0) return null;
      const unit = m[2]!.toLowerCase();
      if (unit === "day") return { kind: "day", candidates: [dayCandidate(today.minus({ days: n }), `${n} day(s) before today`)], ambiguous: false };
      const center = unit === "week" ? today.minus({ weeks: n }) : today.minus({ months: n });
      const radius = unit === "week" ? 3 : 7;
      return {
        kind: "range",
        candidates: [rangeCandidate(center.minus({ days: radius }), center.plus({ days: radius + 1 }), `around ${center.toISODate()} (±${radius} days)`)],
        ambiguous: true,
      };
    },
  },
  // "last week", "previous week", "this week", "earlier this week"
  {
    re: /\b(last|previous|this|earlier this)\s+week\b/gi,
    resolve: (m, today, now) => {
      const which = m[1]!.toLowerCase();
      const thisWeek = today.startOf("week");
      if (which === "this" || which === "earlier this") {
        return { kind: "range", candidates: [rangeCandidate(thisWeek, now.plus({ minutes: 1 }), "this calendar week (Mon–today)")], ambiguous: false };
      }
      const start = thisWeek.minus({ weeks: 1 });
      return { kind: "range", candidates: [rangeCandidate(start, thisWeek, "the previous calendar week (Mon–Sun)")], ambiguous: false };
    },
  },
  // "last month", "previous month", "this month", "earlier this month"
  {
    re: /\b(last|previous|this|earlier this)\s+month\b/gi,
    resolve: (m, today, now) => {
      const which = m[1]!.toLowerCase();
      const thisMonth = today.startOf("month");
      if (which === "this" || which === "earlier this") {
        return { kind: "range", candidates: [rangeCandidate(thisMonth, now.plus({ minutes: 1 }), "this calendar month so far")], ambiguous: false };
      }
      return { kind: "range", candidates: [rangeCandidate(thisMonth.minus({ months: 1 }), thisMonth, "the previous calendar month")], ambiguous: false };
    },
  },
  // "last Tuesday", "on Monday", "this past Friday", bare "Monday"
  {
    re: new RegExp(`\\b(?:(last|this past|past|previous|on|this)\\s+)?${WEEKDAY_RE}\\b`, "gi"),
    resolve: (m, today) => {
      const qualifier = (m[1] ?? "").toLowerCase();
      const wd = weekdayIndex(m[2]!);
      if (wd < 1) return null;
      // Avoid false positives such as "mon" / "sun" / "wed" used as ordinary words without a qualifier.
      if (!qualifier && m[2]!.length <= 4 && !/day$/i.test(m[2]!)) return null;
      const mostRecent = previousWeekday(today, wd);
      if (qualifier === "last" || qualifier === "previous") {
        const lastCalendarWeek = today.startOf("week").minus({ weeks: 1 }).plus({ days: wd - 1 });
        if (lastCalendarWeek.hasSame(mostRecent, "day")) {
          return { kind: "day", candidates: [dayCandidate(mostRecent, "the most recent such weekday")], ambiguous: false };
        }
        return {
          kind: "day",
          candidates: [
            dayCandidate(mostRecent, "the most recent such weekday"),
            dayCandidate(lastCalendarWeek, "that weekday in the previous calendar week"),
          ],
          ambiguous: true,
        };
      }
      if (today.weekday === wd) {
        // "on Monday" asked on a Monday: today, or a week ago.
        return {
          kind: "day",
          candidates: [dayCandidate(today, "today"), dayCandidate(today.minus({ days: 7 }), "the same weekday last week")],
          ambiguous: true,
        };
      }
      return { kind: "day", candidates: [dayCandidate(mostRecent, "the most recent such weekday")], ambiguous: false };
    },
  },
];

function explicitDate(day: number, month: number, year: number | undefined, today: DateTime): Omit<TemporalReference, "expression"> | null {
  if (month < 1 || day < 1 || day > 31) return null;
  if (year) {
    const d = DateTime.fromObject({ year, month, day }, { zone: today.zone });
    return d.isValid ? { kind: "day", candidates: [dayCandidate(d, "explicit date")], ambiguous: false } : null;
  }
  let d = DateTime.fromObject({ year: today.year, month, day }, { zone: today.zone });
  if (!d.isValid) return null;
  if (d > today) d = d.minus({ years: 1 });
  return { kind: "day", candidates: [dayCandidate(d, "most recent past occurrence of that date")], ambiguous: false };
}

export interface ResolveOptions {
  now: Date | string;
  timezone: string;
  /** Additional expressions (e.g. extracted by the LLM) to resolve. */
  extraExpressions?: string[];
}

function scan(text: string, today: DateTime, now: DateTime): { refs: TemporalReference[]; matchedAny: boolean } {
  const refs: TemporalReference[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const res = rule.resolve(m, today, now);
      if (!res) continue;
      taken.push([start, end]);
      refs.push({ expression: m[0].trim(), ...res });
    }
  }
  refs.sort((a, b) => text.toLowerCase().indexOf(a.expression.toLowerCase()) - text.toLowerCase().indexOf(b.expression.toLowerCase()));
  return { refs, matchedAny: refs.length > 0 };
}

export function resolveTemporal(text: string, opts: ResolveOptions): TemporalResolution {
  const now = (typeof opts.now === "string" ? DateTime.fromISO(opts.now) : DateTime.fromJSDate(opts.now)).setZone(opts.timezone);
  if (!now.isValid) throw new Error(`Invalid timezone or date: ${opts.timezone}`);
  const today = now.startOf("day");
  const { refs } = scan(text, today, now);
  const unresolved: string[] = [];
  const seen = new Set(refs.map((r) => key(r)));
  for (const expr of opts.extraExpressions ?? []) {
    const extra = scan(expr, today, now);
    if (!extra.matchedAny) {
      unresolved.push(expr);
      continue;
    }
    for (const r of extra.refs) {
      if (!seen.has(key(r))) {
        seen.add(key(r));
        refs.push(r);
      }
    }
  }
  return { references: refs, unresolved, nowLocal: now.toISO()!, timezone: opts.timezone };
}

const key = (r: TemporalReference) => `${r.kind}|${r.candidates.map((c) => c.startUtc + c.endUtc).join(",")}`;

/** Formats a UTC timestamp as a local date string for prompts and UI. */
export function formatLocal(utcIso: string, timezone: string, fmt = "cccc d LLLL yyyy, HH:mm"): string {
  return DateTime.fromISO(utcIso, { zone: "utc" }).setZone(timezone).toFormat(fmt);
}

export function localDate(utcIso: string, timezone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" }).setZone(timezone).toISODate()!;
}
