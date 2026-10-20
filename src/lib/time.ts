/**
 * Studio-local calendar helpers. Sessions are stored as a local date
 * (YYYY-MM-DD) plus a local clock time (HH:MM), so the only timezone math in
 * the system is turning "now" into the studio's calendar date.
 */

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The studio-local calendar date of an instant. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value).join("-");
}

/** The studio-local clock time of an instant, as HH:MM (24h). */
export function localClock(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

/** "14:30" -> "2:30 PM" */
export function spokenTime(clock: string): string {
  const [h, m] = clock.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "2026-10-23" -> "Friday, Oct 23" */
export function spokenDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  const weekday = weekdayOf(date);
  return `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${MONTHS[month - 1]} ${day}`;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function isClock(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
