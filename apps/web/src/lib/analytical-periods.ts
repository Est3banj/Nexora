import { localDate } from "@pos/shared";

export type DashboardPeriod = "today" | "7d" | "month" | "30d";
export type DateRange = { from: string; to: string };

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** Calendar days in Bogotá, inclusive. Month comparison is the previous
 * month through the same day number, capped at its last day (e.g. Mar31
 * compares Feb1–28). Rolling windows compare the immediately preceding N days. */
export function dashboardRanges(period: DashboardPeriod, now = new Date()) {
  const to = localDate(0, now);
  if (period === "month") {
    const from = `${to.slice(0, 7)}-01`;
    const last = shiftDay(from, -1);
    const previousDay = Math.min(Number(to.slice(8)), Number(last.slice(8)));
    return {
      current: { from, to },
      previous: { from: `${last.slice(0, 7)}-01`, to: `${last.slice(0, 7)}-${String(previousDay).padStart(2, "0")}` },
    };
  }
  const length = period === "today" ? 1 : period === "7d" ? 7 : 30;
  return {
    current: { from: shiftDay(to, 1 - length), to },
    previous: { from: shiftDay(to, 1 - length * 2), to: shiftDay(to, -length) },
  };
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
