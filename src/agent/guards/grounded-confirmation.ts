import type { BookingStore, Session } from "../../tools/booking-store.ts";
import { SESSION_CHANGING_TOOLS } from "../../tools/booking-tools.ts";
import { addDays, localDate, spokenDate, spokenTime, WEEKDAYS, weekdayOf } from "../../lib/time.ts";
import { classifierText } from "../../lib/text.ts";

/**
 * Grounded-confirmation guard.
 *
 * When a customer asserts or asks about an existing booking ("I'm booked
 * tomorrow at 1", "am I all set?", "on my way to my 2pm"), the server forces
 * a fresh read of their sessions before ANY reply goes out:
 *
 * - match    → the read is handed to the model as context; the model composes.
 * - mismatch → the model's text is never sent. A deterministic "I don't see
 *              that locked in" goes out and staff are notified.
 *
 * Rule: a guard may BLOCK a reply, never REPLACE one with a confirmation.
 * (An earlier version substituted "You're all set!" on a match, which once
 * talked over a pending "Reply YES to cancel" prompt.)
 *
 * Trigger detection is precision-biased: any doubt falls through to the
 * model. Cancel/reschedule traffic and "I can't make it" stay with the
 * prepare tools.
 */

const CONFIRMATION_ASSERTION =
  /\bi(?:'m|\s?a?m)\s+(?:already\s+)?(?:scheduled|booked|confirmed|signed up|all set|good to go|on the (?:books|schedule|calendar))\b|\b(?:i|we)\s+(?:already\s+)?(?:have|ve got|got)\s+(?:a|an|my|our)\s+(?:session|appointment|booking|spot|reservation)\b/;

const CONFIRMATION_QUESTION =
  /\bam i\s+(?:still\s+)?(?:all set|set|booked|scheduled|confirmed|good to go|on the (?:books|schedule|calendar))\b|\bis my\s+(?:session|appointment|booking|spot|reservation)\s+(?:still\s+)?(?:on|set|booked|confirmed|good|locked in|happening)\b|\bdo (?:i|we)\s+(?:still\s+)?have\s+(?:a|an|my|our|that)\s+(?:session|appointment|booking|spot|reservation)\b|\b(?:am i|are we)\s+(?:still\s+)?on for\b/;

const SESSION_ACTION_KEYWORD = /\b(?:cancel|cancelling|canceling|reschedul\w*|move|moving|push|switch)\b/;

/** Not-coming phrasing is cancel traffic, however it is worded. */
const NOT_ATTENDING =
  /\b(?:(?:unable|not able|can ?not|cant|can t|won ?t|wont|will not|wouldn ?t|not going) (?:to )?(?:be able to )?(?:attend|make|come|go|be there)|(?:have|need|going) to (?:miss|skip)|(?:will|gonna|going to) miss|won ?t be (?:there|coming|in|able)|not (?:coming|going to make)|have an emergency)\b/;

const SESSION_NOUN = /\b(?:session|appointment|booking|reservation|spot|class)\b/;

/** Arrival/lateness cues assert an appointment as strongly as "am I all set?". */
const IMPLICIT_APPOINTMENT_CUE =
  /\b(?:on (?:my|our) way|omw|running (?:late|behind)\b(?!\s+on\b)|heading (?:in|over|there)|be there (?:in|at|by|soon)|almost there)\b/;
const POSSESSIVE_SLOT_REF = /\bmy \d{1,2}(?::\d{2})?\s*(?:am|pm)\b/;

/** An open availability question alongside a cue means they are still shopping for a time. */
const AVAILABILITY_QUESTION =
  /\bdo you have\b|\bany (?:openings?|availability|times?|slots?)\b|\bwhat(?:'?s| is)? (?:open|available)\b|\bcan (?:i|we) (?:book|come|get)\b/;

export function isConfirmationShapedInbound(text: string, now: Date, timeZone: string): boolean {
  const normalized = classifierText(text);
  if (!normalized) return false;
  if (SESSION_ACTION_KEYWORD.test(normalized) || NOT_ATTENDING.test(normalized)) return false;
  if (CONFIRMATION_QUESTION.test(normalized)) return true;
  if (CONFIRMATION_ASSERTION.test(normalized)) {
    // Needs an anchor so "I'm booked solid at work" never trips the guard.
    if (SESSION_NOUN.test(normalized)) return true;
    const slot = parseAssertedSlot(text, now, timeZone);
    return slot.date != null || slot.hour != null;
  }
  return !AVAILABILITY_QUESTION.test(normalized) && (IMPLICIT_APPOINTMENT_CUE.test(normalized) || POSSESSIVE_SLOT_REF.test(normalized));
}

export function shouldRunGroundedConfirmation(args: {
  inboundText: string;
  customerId: string | null;
  priorToolNames: readonly string[];
  now: Date;
  timeZone: string;
}): boolean {
  if (!args.customerId) return false; // never read sessions for an unresolved identity
  if (args.priorToolNames.some((name) => name === "grounded_confirmation_check" || SESSION_CHANGING_TOOLS.has(name))) return false;
  return isConfirmationShapedInbound(args.inboundText, args.now, args.timeZone);
}

export type AssertedSlot = {
  date: string | null;
  hour: number | null;
  minute: number;
  meridiem: "am" | "pm" | null;
  summary: string | null;
};

export function parseAssertedSlot(text: string, now: Date, timeZone: string): AssertedSlot {
  const normalized = classifierText(text);
  const today = localDate(now, timeZone);
  let date: string | null = null;
  let daySpoken: string | null = null;
  if (/\b(?:today|tonight)\b/.test(normalized)) {
    date = today;
    daySpoken = "today";
  } else if (/\btomorrow\b/.test(normalized)) {
    date = addDays(today, 1);
    daySpoken = "tomorrow";
  } else {
    const weekday = WEEKDAYS.find((name) => new RegExp(`\\b${name}\\b`).test(normalized));
    if (weekday) {
      for (let offset = 0; offset < 7; offset++) {
        const candidate = addDays(today, offset);
        if (weekdayOf(candidate) === weekday) {
          date = candidate;
          daySpoken = weekday;
          break;
        }
      }
    }
  }

  let hour: number | null = null;
  let minute = 0;
  let meridiem: "am" | "pm" | null = null;
  if (/\bnoon\b/.test(normalized)) {
    hour = 12;
    meridiem = "pm";
  } else {
    const timed = normalized.match(/\bat\s+(\d{1,2})(?:[:\s](\d{2}))?\s*(am|pm)?\b/) ?? normalized.match(/\b(\d{1,2})(?:[:\s](\d{2}))?\s*(am|pm)\b/);
    if (timed) {
      const parsed = Number.parseInt(timed[1], 10);
      if (parsed >= 0 && parsed <= 23) {
        hour = parsed;
        minute = timed[2] ? Number.parseInt(timed[2], 10) : 0;
        meridiem = (timed[3] as "am" | "pm" | undefined) ?? null;
      }
    }
  }

  const parts: string[] = [];
  if (daySpoken) parts.push(daySpoken);
  if (hour != null) parts.push(`at ${hour}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${meridiem ?? ""}`);
  return { date, hour, minute, meridiem, summary: parts.length ? parts.join(" ") : null };
}

/** Does a stored session match what the customer asserted? An unstated meridiem matches either. */
function matchesAsserted(session: Session, asserted: AssertedSlot): boolean {
  if (asserted.date && session.date !== asserted.date) return false;
  if (asserted.hour == null) return true;
  const [h, m] = session.time.split(":").map(Number);
  if (m !== asserted.minute) return false;
  if (asserted.meridiem) return h === (asserted.hour % 12) + (asserted.meridiem === "pm" ? 12 : 0);
  return h % 12 === asserted.hour % 12;
}

export type GroundedConfirmationEvaluation =
  | { outcome: "confirmed"; modelContext: string; session: Session; asserted: AssertedSlot; sessionCount: number }
  | { outcome: "mismatch"; text: string; nearest: Session | null; asserted: AssertedSlot; sessionCount: number };

const READ_WINDOW_DAYS = 7;

export function evaluateGroundedConfirmation(args: { store: BookingStore; customerId: string; inboundText: string; now: Date }): GroundedConfirmationEvaluation {
  const tz = args.store.config.timeZone;
  const asserted = parseAssertedSlot(args.inboundText, args.now, tz);
  const horizon = addDays(localDate(args.now, tz), READ_WINDOW_DAYS);
  const sessions = args.store.upcomingSessions(args.customerId, args.now).filter((s) => s.date <= horizon);
  const match = sessions.find((s) => matchesAsserted(s, asserted));
  if (match) {
    return {
      outcome: "confirmed",
      session: match,
      asserted,
      sessionCount: sessions.length,
      modelContext: `Server read (fresh): the customer has a booked ${match.room} session on ${spokenDate(match.date)} at ${spokenTime(match.time)}. Compose the reply from this read only.`,
    };
  }
  const nearest = sessions[0] ?? null;
  const what = asserted.summary ? ` ${asserted.summary}` : "";
  const text = nearest
    ? `I don't see a session${what} locked in. The next one I have for you is ${spokenDate(nearest.date)} at ${spokenTime(nearest.time)}. I've asked the team to double-check.`
    : `I don't see a session${what} locked in for you. I've asked the team to double-check and they'll follow up.`;
  return { outcome: "mismatch", text, nearest, asserted, sessionCount: sessions.length };
}
