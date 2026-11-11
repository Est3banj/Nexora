import { describe, expect, it } from "vitest";
import { localDate } from "@pos/shared";
import { deltaPct, prevRangeFor } from "../src/screens/Dashboard";

/**
 * Panel UX #5 — period comparison helpers.
 *  - prevRangeFor: same-length window immediately before the current one
 *  - deltaPct: honest % (null when the prior period has no base)
 */

describe("prevRangeFor", () => {
  it("today → yesterday (single day)", () => {
    const r = prevRangeFor("today");
    expect(r.from).toBe(localDate(-1));
    expect(r.to).toBe(localDate(-1));
  });

  it("7d → the 7 days before the current 7", () => {
    const r = prevRangeFor("7d");
    expect(r.from).toBe(localDate(-13));
    expect(r.to).toBe(localDate(-7));
    // no overlap with the current range (localDate(-6)..localDate(0))
    expect(r.to < localDate(-6)).toBe(true);
  });

  it("30d → the 30 days before the current 30", () => {
    const r = prevRangeFor("30d");
    expect(r.from).toBe(localDate(-59));
    expect(r.to).toBe(localDate(-30));
    expect(r.to < localDate(-29)).toBe(true);
  });

  it("windows have equal length (same day count)", () => {
    const days = (r: { from: string; to: string }) =>
      Math.round(
        (new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000,
      ) + 1;
    expect(days(prevRangeFor("7d"))).toBe(7);
    expect(days(prevRangeFor("30d"))).toBe(30);
  });
});

describe("deltaPct", () => {
  it("growth → positive", () => {
    expect(deltaPct(150, 100)).toBe(50);
  });

  it("drop → negative", () => {
    expect(deltaPct(50, 100)).toBe(-50);
  });

  it("flat → 0", () => {
    expect(deltaPct(100, 100)).toBe(0);
  });

  it("no prior base → null (never divide by zero, never fake 100%)", () => {
    expect(deltaPct(100, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});
