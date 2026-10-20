/**
 * Calling-hour guardrail for outbound voice (and any outbound marketing text).
 *
 * The federal TCPA window is 8 AM - 9 PM in the *recipient's* local time;
 * several states are stricter. The production policy was deliberately
 * narrower than any of them (9 AM - 7 PM) and checked EVERY time zone the
 * number could plausibly be in, because a mobile number's area code says
 * where it was issued, not where the person is today.
 */

export const DEFAULT_WINDOW = { startHour: 9, endHour: 19 } as const;

export const CONTINENTAL_US_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
] as const;

/**
 * A small illustrative area-code map. A real deployment loads the full NANP
 * table. Unknown area codes fail closed: the call must be inside the window
 * in every continental zone.
 */
const AREA_CODE_ZONES: Record<string, readonly string[]> = {
  "212": ["America/New_York"],
  "312": ["America/Chicago"],
  "303": ["America/Denver"],
  "602": ["America/Phoenix"],
  "415": ["America/Los_Angeles"],
  "808": ["Pacific/Honolulu"],
};

export function phoneTimeZones(e164: string, map: Record<string, readonly string[]> = AREA_CODE_ZONES): string[] {
  const zones = e164.startsWith("+1") ? map[e164.slice(2, 5)] : undefined;
  return zones?.length ? [...zones] : [...CONTINENTAL_US_ZONES];
}

export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
}

/** True only if `now` is inside the window in every zone given. */
export function insideCallingWindow(now: Date, zones: readonly string[], window: { startHour: number; endHour: number } = DEFAULT_WINDOW): boolean {
  if (!zones.length) return false;
  return zones.every((zone) => {
    const hour = localHour(now, zone);
    return hour >= window.startHour && hour < window.endHour;
  });
}

/** The zones a call must respect: the business's own zone plus every zone the number may be in. */
export function callingZones(e164: string, businessZone: string): string[] {
  return Array.from(new Set([businessZone, ...phoneTimeZones(e164)]));
}
