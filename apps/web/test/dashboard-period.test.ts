import { describe, expect, it } from "vitest";
import { localDate } from "@pos/shared";
import {
  customRanges,
  dashboardRanges,
  defaultCustomRange,
  deltaPct,
  inclusiveDays,
  validCustomRange,
  validReportRange,
} from "../src/lib/analytical-periods";

const PERIOD_LENGTHS = [
  ["today", 1],
  ["7d", 7],
  ["30d", 30],
  ["90d", 90],
  ["180d", 180],
  ["365d", 365],
] as const;

describe("rolling windows", () => {
  it("today compares yesterday", () => {
    expect(dashboardRanges("today").previous).toEqual({
      from: localDate(-1),
      to: localDate(-1),
    });
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
  it("every preset window has equal inclusive day counts on both sides", () => {
    for (const [period, count] of PERIOD_LENGTHS) {
      for (const r of Object.values(dashboardRanges(period))) {
        expect((Date.parse(r.to) - Date.parse(r.from)) / 86400000 + 1).toBe(count);
      }
    }
  });
  it("current and previous windows never overlap and leave no gap", () => {
    for (const [period] of PERIOD_LENGTHS) {
      const { current, previous } = dashboardRanges(period);
      expect(previous.to < current.from).toBe(true);
      const gap =
        (Date.parse(current.from) - Date.parse(previous.to)) / 86400000;
      expect(gap).toBe(1);
    }
  });
});

describe("custom ranges", () => {
  it("previous window keeps the same inclusive length ending the day before from", () => {
    expect(customRanges({ from: "2026-11-01", to: "2026-11-03" })).toEqual({
      current: { from: "2026-11-01", to: "2026-11-03" },
      previous: { from: "2026-10-29", to: "2026-10-31" },
    });
    expect(inclusiveDays({ from: "2026-11-01", to: "2026-11-03" })).toBe(3);
  });
  it("single-day custom compares the day before", () => {
    expect(customRanges({ from: "2026-11-03", to: "2026-11-03" })).toEqual({
      current: { from: "2026-11-03", to: "2026-11-03" },
      previous: { from: "2026-11-02", to: "2026-11-02" },
    });
  });
  it("previous window never overlaps the custom range", () => {
    const range = { from: "2026-08-15", to: "2026-11-03" };
    const { current, previous } = customRanges(range);
    expect(previous.to < current.from).toBe(true);
    expect(inclusiveDays(previous)).toBe(inclusiveDays(current));
  });
  it("default draft is the last 7 inclusive days ending today", () => {
    const draft = defaultCustomRange(new Date("2026-11-03T18:00:00Z"));
    expect(draft).toEqual({ from: "2026-10-28", to: "2026-11-03" });
    expect(inclusiveDays(draft)).toBe(7);
  });
});

describe("validCustomRange", () => {
  const now = new Date("2026-11-03T18:00:00Z"); // Bogotá 2026-11-03
  it("accepts a range ending today", () => {
    expect(validCustomRange({ from: "2026-11-01", to: "2026-11-03" }, now)).toBe(true);
  });
  it("rejects an empty field", () => {
    expect(validCustomRange({ from: "", to: "2026-11-03" }, now)).toBe(false);
    expect(validCustomRange({ from: "2026-11-01", to: "" }, now)).toBe(false);
  });
  it("rejects from after to", () => {
    expect(validCustomRange({ from: "2026-11-04", to: "2026-11-03" }, now)).toBe(false);
  });
  it("rejects a future to", () => {
    expect(validCustomRange({ from: "2026-11-01", to: "2026-11-04" }, now)).toBe(false);
  });
  it("rejects malformed days", () => {
    expect(validCustomRange({ from: "2026-02-30", to: "2026-11-03" }, now)).toBe(false);
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
  it("defaults today around the UTC day boundary, independent of host timezone", () => {
    expect(dashboardRanges("today", new Date("2027-01-01T04:59:59Z"))).toEqual({
      current: { from: "2026-12-31", to: "2026-12-31" },
      previous: { from: "2026-12-30", to: "2026-12-30" },
    });
    expect(dashboardRanges("90d", new Date("2027-01-01T05:00:00Z"))).toEqual({
      current: { from: "2026-10-04", to: "2027-01-01" },
      previous: { from: "2026-07-06", to: "2026-10-03" },
    });
  });
  it("7 and 30 days are inclusive, non-overlapping immediately preceding windows", () => {
    const now = new Date("2026-03-03T17:00:00Z");
    expect(dashboardRanges("7d", now)).toEqual({ current: { from: "2026-02-25", to: "2026-03-03" }, previous: { from: "2026-02-18", to: "2026-02-24" } });
    expect(dashboardRanges("30d", now)).toEqual({ current: { from: "2026-02-02", to: "2026-03-03" }, previous: { from: "2026-01-03", to: "2026-02-01" } });
  });
  it("90, 180 and 365 days are inclusive, non-overlapping immediately preceding windows", () => {
    const now = new Date("2026-03-03T17:00:00Z");
    expect(dashboardRanges("90d", now)).toEqual({ current: { from: "2025-12-04", to: "2026-03-03" }, previous: { from: "2025-09-05", to: "2025-12-03" } });
    expect(dashboardRanges("180d", now)).toEqual({ current: { from: "2025-09-05", to: "2026-03-03" }, previous: { from: "2025-03-09", to: "2025-09-04" } });
    expect(dashboardRanges("365d", now)).toEqual({ current: { from: "2025-03-04", to: "2026-03-03" }, previous: { from: "2024-03-04", to: "2025-03-03" } });
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
