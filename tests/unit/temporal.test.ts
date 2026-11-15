import { describe, expect, it } from "vitest";
import { resolveTemporal } from "@minimi/core";

const SUNDAY = "2026-11-15T12:00:00.000Z"; // Sunday 15 Nov 2026
const MONDAY = "2026-11-16T12:00:00.000Z";
const TZ = "Europe/London";

const dates = (text: string, now = SUNDAY, tz = TZ) =>
  resolveTemporal(text, { now, timezone: tz }).references.map((r) => ({
    expr: r.expression.toLowerCase(),
    kind: r.kind,
    ambiguous: r.ambiguous,
    days: r.candidates.map((c) => (c.startLocalDate === c.endLocalDate ? c.startLocalDate : `${c.startLocalDate}..${c.endLocalDate}`)),
  }));

describe("temporal resolver", () => {
  it("resolves 'last Tuesday' on a Sunday as ambiguous: most recent Tuesday first, then previous calendar week", () => {
    expect(dates("Last Tuesday I asked you about Postgres hosting")).toEqual([
      { expr: "last tuesday", kind: "day", ambiguous: true, days: ["2026-11-10", "2026-11-03"] },
    ]);
  });

  it("resolves 'last Tuesday' unambiguously when both readings coincide (asked on a Monday)", () => {
    expect(dates("last tuesday", MONDAY)).toEqual([{ expr: "last tuesday", kind: "day", ambiguous: false, days: ["2026-11-10"] }]);
  });

  it("resolves 'On Monday' to the most recent past Monday", () => {
    expect(dates("On Monday we shortlisted 5 CRM tools")[0]).toMatchObject({ days: ["2026-11-09"], ambiguous: false });
  });

  it("flags 'on Monday' asked on a Monday as ambiguous (today or a week ago)", () => {
    expect(dates("on Monday", MONDAY)[0]).toMatchObject({ days: ["2026-11-16", "2026-11-09"], ambiguous: true });
  });

  it("resolves explicit dates without a year to the most recent past occurrence", () => {
    expect(dates("What did I ask you on 3 November?")[0]!.days).toEqual(["2026-11-03"]);
    expect(dates("November 3rd")[0]!.days).toEqual(["2026-11-03"]);
    expect(dates("3rd of Nov")[0]!.days).toEqual(["2026-11-03"]);
    // Asked on 1 Nov 2026, "3 November" must mean last year.
    expect(dates("3 November", "2026-11-01T12:00:00Z")[0]!.days).toEqual(["2025-11-03"]);
  });

  it("respects explicit years and ISO dates", () => {
    expect(dates("on 3 November 2025")[0]!.days).toEqual(["2025-11-03"]);
    expect(dates("on 2026-10-01")[0]!.days).toEqual(["2026-10-01"]);
  });

  it("resolves relative days", () => {
    expect(dates("today")[0]!.days).toEqual(["2026-11-15"]);
    expect(dates("yesterday")[0]!.days).toEqual(["2026-11-14"]);
    expect(dates("the day before yesterday")[0]!.days).toEqual(["2026-11-13"]);
    expect(dates("three days ago")[0]!.days).toEqual(["2026-11-12"]);
    expect(dates("3 days ago")[0]!.days).toEqual(["2026-11-12"]);
  });

  it("resolves week and month ranges", () => {
    expect(dates("last week")[0]!.days).toEqual(["2026-11-02..2026-11-08"]);
    expect(dates("previous week")[0]!.days).toEqual(["2026-11-02..2026-11-08"]);
    expect(dates("earlier this month")[0]!.days).toEqual(["2026-11-01..2026-11-15"]);
    expect(dates("last month")[0]!.days).toEqual(["2026-10-01..2026-10-31"]);
    expect(dates("a week ago")[0]).toMatchObject({ kind: "range", ambiguous: true, days: ["2026-11-05..2026-11-11"] });
  });

  it("recognises 'since our last discussion'", () => {
    expect(dates("Has anything changed since our last discussion?")).toEqual([
      { expr: "since our last discussion", kind: "since_last_discussion", ambiguous: false, days: [] },
    ]);
  });

  it("evaluates dates in the conversation's timezone and returns UTC bounds", () => {
    // 23:30 UTC on Sunday is already 05:00 Monday in Kolkata, so 'yesterday' is Sunday 15 Nov (local).
    const r = resolveTemporal("yesterday", { now: "2026-11-15T23:30:00Z", timezone: "Asia/Kolkata" });
    const c = r.references[0]!.candidates[0]!;
    expect(c.startLocalDate).toBe("2026-11-15");
    expect(c.startUtc).toBe("2026-11-14T18:30:00.000Z");
    expect(c.endUtc).toBe("2026-11-15T18:30:00.000Z");
  });

  it("does not treat brand names or abbreviations as weekdays", () => {
    expect(dates("Is Sun Microsystems still around?")).toEqual([]);
    expect(dates("how do I mon itor wed dings")).toEqual([]);
  });

  it("reports model-extracted expressions it cannot interpret instead of guessing", () => {
    const r = resolveTemporal("what did we discuss then?", { now: SUNDAY, timezone: TZ, extraExpressions: ["the day after Halloween"] });
    expect(r.references).toEqual([]);
    expect(r.unresolved).toEqual(["the day after Halloween"]);
  });

  it("handles multiple references in one message", () => {
    const r = dates("Compare what we said on Monday with what you told me last week");
    expect(r.map((x) => x.expr)).toEqual(["on monday", "last week"]);
  });
});
