import { localDate } from "@pos/shared";

export type DashboardPeriod =
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "180d"
  | "365d"
  | "custom";
export type PresetPeriod = Exclude<DashboardPeriod, "custom">;
export type DateRange = { from: string; to: string };

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const PERIOD_LENGTHS: Record<PresetPeriod, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

/** Rolling window in Bogotá calendar days (inclusive): current =
 * [to-len+1, to], previous = the same-length window immediately before it
 * (no gap, no overlap). */
export function dashboardRanges(period: PresetPeriod, now = new Date()) {
  const to = localDate(0, now);
  const length = PERIOD_LENGTHS[period];
  return {
    current: { from: shiftDay(to, 1 - length), to },
    previous: { from: shiftDay(to, 1 - length * 2), to: shiftDay(to, -length) },
  };
}

/** Inclusive day count of a YYYY-MM-DD range (both ends count). */
export function inclusiveDays(range: DateRange): number {
  return (
    Math.round(
      (Date.parse(`${range.to}T12:00:00Z`) - Date.parse(`${range.from}T12:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

/** Custom range: current = the range itself; previous = the same inclusive
 * length ending the day before `from`. Requires from ≤ to. */
export function customRanges(range: DateRange): {
  current: DateRange;
  previous: DateRange;
} {
  const days = inclusiveDays(range);
  return {
    current: { from: range.from, to: range.to },
    previous: { from: shiftDay(range.from, -days), to: shiftDay(range.from, -1) },
  };
}

/** Sensible custom draft: the last 7 Bogotá days (auto-applies on activate). */
export function defaultCustomRange(now = new Date()): DateRange {
  return { from: localDate(-6, now), to: localDate(0, now) };
}

export function deltaPct(current: number, previous: number): number | null {
  return previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
}

export function validReportRange(range: DateRange): boolean {
  return [range.from, range.to].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(`${day}T12:00:00Z`))
    && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day)
    && range.from <= range.to;
}

/** Dashboard custom range: validReportRange + `to` never in the future.
 * Reports keeps plain validReportRange (button-applied drafts may sit on
 * future dates); the dashboard auto-applies on every change, so a future
 * `to` would silently query nothing. */
export function validCustomRange(range: DateRange, now = new Date()): boolean {
  return validReportRange(range) && range.to <= localDate(0, now);
}

export const CUSTOM_RANGE_ERROR =
  "Ingresá fechas válidas; desde ≤ hasta y hasta no puede ser posterior a hoy.";
