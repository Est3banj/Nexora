import { describe, expect, it } from "vitest";
import { localDate } from "@pos/shared";
import { dashboardRanges, deltaPct, validReportRange } from "../src/lib/analytical-periods";

// Retain the existing rolling-window/delta regression matrix against the
// extracted helper, alongside deterministic month/timezone coverage below.
describe("previous rolling windows", () => {
  it("today compares yesterday", () => {
    expect(dashboardRanges("today").previous).toEqual({ from: localDate(-1), to: localDate(-1) });
  });
  it("7d compares the immediately preceding seven days without overlap", () => {
    const r = dashboardRanges("7d").previous;
    expect(r).toEqual({ from: localDate(-13), to: localDate(-7) });
    expect(r.to < localDate(-6)).toBe(true);
  });
  it("30d compares the immediately preceding thirty days without overlap", () => {
    const r = dashboardRanges("30d").previous;
    expect(r).toEqual({ from: localDate(-59), to: localDate(-30) });
    expect(r.to < localDate(-29)).toBe(true);
  });
  it("rolling windows have equal inclusive day counts", () => {
    for (const [period, count] of [["7d", 7], ["30d", 30]] as const) {
      for (const r of Object.values(dashboardRanges(period))) {
        expect((Date.parse(r.to) - Date.parse(r.from)) / 86400000 + 1).toBe(count);
      }
    }
  });
});

describe("deltaPct regression", () => {
  it("growth is positive", () => { expect(deltaPct(150, 100)).toBe(50); });
  it("drop is negative", () => { expect(deltaPct(50, 100)).toBe(-50); });
  it("flat is zero", () => { expect(deltaPct(100, 100)).toBe(0); });
  it("no base is null, including zero against zero", () => {
    expect(deltaPct(100, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});

describe("Bogotá analytical calendar windows", () => {
  it("defaults today around the UTC month boundary, independent of host timezone", () => {
    expect(dashboardRanges("today", new Date("2027-01-01T04:59:59Z"))).toEqual({ current: { from: "2026-12-31", to: "2026-12-31" }, previous: { from: "2026-12-30", to: "2026-12-30" } });
    expect(dashboardRanges("month", new Date("2027-01-01T05:00:00Z"))).toEqual({ current: { from: "2027-01-01", to: "2027-01-01" }, previous: { from: "2026-12-01", to: "2026-12-01" } });
  });
  it("7 and 30 days are inclusive, non-overlapping immediately preceding windows", () => {
    const now = new Date("2026-03-03T17:00:00Z");
    expect(dashboardRanges("7d", now)).toEqual({ current: { from: "2026-02-25", to: "2026-03-03" }, previous: { from: "2026-02-18", to: "2026-02-24" } });
    expect(dashboardRanges("30d", now)).toEqual({ current: { from: "2026-02-02", to: "2026-03-03" }, previous: { from: "2026-01-03", to: "2026-02-01" } });
  });
  it.each([["2026-03-31", "2026-02-28"], ["2024-03-31", "2024-02-29"], ["2026-11-12", "2026-10-12"]])("month-to-date %s compares homologous previous month capped at %s", (day, previousTo) => {
    expect(dashboardRanges("month", new Date(`${day}T17:00:00Z`))).toEqual({ current: { from: `${day.slice(0, 7)}-01`, to: day }, previous: { from: `${previousTo.slice(0, 7)}-01`, to: previousTo } });
  });
  it("never invents a percentage without a positive prior base", () => {
    expect(deltaPct(65000, 0)).toBeNull();
    expect(deltaPct(65000, -1)).toBeNull();
    expect(deltaPct(65000, 50000)).toBe(30);
    expect(deltaPct(0, 50000)).toBe(-100);
  });
  it.each([ ["", "2026-11-03"], ["2026-11-04", "2026-11-03"], ["2026-02-30", "2026-03-03"] ])("rejects invalid report range %s/%s", (from, to) => {
    expect(validReportRange({ from, to })).toBe(false);
  });
  it("allows same day and leap-day ranges", () => {
    expect(validReportRange({ from: "2024-02-29", to: "2024-02-29" })).toBe(true);
  });
});
