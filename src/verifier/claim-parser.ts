import { addDays, WEEKDAYS, weekdayOf } from "../lib/time.ts";
import type { Claim, ClaimGraph, Span } from "./claims.ts";

/**
 * A deliberately small claim grammar. It recognizes a handful of frames
 * (questions, intentions, completions, slot offers, account statements).
 * Anything carrying a value (a digit or a price) that no frame explains is
 * left UNCOVERED, and an uncovered span withholds the whole reply: an
 * unparsed number is never assumed harmless.
 */

export type ParseContext = { calendarDate: string; rooms: readonly string[] };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const COMPLETION =
  /\b(?:you'?re (?:all )?(?:booked|set|confirmed)|all set|i(?:'ve| have) (?:booked|cancell?ed|moved|rescheduled|confirmed)|(?:is|has been|was) (?:now )?(?:booked|cancell?ed|moved|rescheduled|confirmed)|booked you|got you (?:booked|in|down)|done)\b/i;
const INTENTION = /^(?:i can|i'll|i will|let me|happy to|i'd be happy to)\b/i;
const ACCOUNT_POSITIVE = /\b(?:you have|you've got|your (?:session|appointment|booking))\b/i;
const ACCOUNT_NEGATIVE = /\b(?:i don'?t see|i do not see|you don'?t have|you have no|there'?s no (?:session|appointment|booking))\b/i;
const SLOT_NEGATIVE = /\b(?:nothing (?:is )?(?:open|available)|no (?:openings|availability|open times)|fully booked)\b/i;
const VALUE_MARKER = /\d|\$/;
const FACT_FRAME = /\b(?:open daily|our hours|we(?:'re| are) open|first session|last session|sessions are|minutes long|hours (?:before|ahead))\b/i;

function sentences(text: string): Array<{ text: string; span: Span }> {
  // Split on terminal punctuation followed by whitespace + an uppercase letter
  // (or the end), so "3:00 p.m." and decimals stay inside one sentence.
  const out: Array<{ text: string; span: Span }> = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, span: [start + lead, start + lead + trimmed.length] });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    if (!".!?".includes(text[i])) continue;
    const next = text.slice(i + 1);
    if (next.length === 0 || /^\s+[A-Z]/.test(next)) push(i + 1);
  }
  push(text.length);
  return out;
}

const DATE_TEXT = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{4}-\d{2}-\d{2}\b/gi;

/** True when the sentence carries a value other than a recognized calendar date. */
function carriesValue(sentence: string): boolean {
  return VALUE_MARKER.test(sentence.replace(DATE_TEXT, " "));
}

/** Clock times in a sentence. A bare "at 3" yields both meridiem readings. */
export function parseTimes(text: string): string[][] {
  const out: string[][] = [];
  const pad = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  let rest = text;
  for (const m of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/gi)) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue;
    const pm = m[3].toLowerCase().startsWith("p");
    out.push([pad((h % 12) + (pm ? 12 : 0), Number(m[2] ?? 0))]);
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(/\bat (\d{1,2})(?::([0-5]\d))?\b/gi)) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) out.push([pad(h % 12, Number(m[2] ?? 0)), pad((h % 12) + 12, Number(m[2] ?? 0))]);
  }
  return out;
}

/** Resolve a spoken date against the studio calendar date. */
export function parseDate(text: string, calendarDate: string): string | null {
  const t = text.toLowerCase();
  if (/\b(?:today|tonight)\b/.test(t)) return calendarDate;
  if (/\btomorrow\b/.test(t)) return addDays(calendarDate, 1);
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (md) {
    const month = MONTHS.indexOf(md[1]) + 1;
    let year = Number(calendarDate.slice(0, 4));
    const candidate = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(Number(md[2])).padStart(2, "0")}`;
    if (candidate(year) < calendarDate) year += 1;
    return candidate(year);
  }
  const weekday = WEEKDAYS.find((d) => new RegExp(`\\b${d}\\b`).test(t));
  if (weekday) {
    for (let i = 0; i < 7; i++) if (weekdayOf(addDays(calendarDate, i)) === weekday) return addDays(calendarDate, i);
  }
  return null;
}

export function parseClaims(text: string, ctx: ParseContext): ClaimGraph {
  const graph: ClaimGraph = { text, claims: [], uncovered: [] };
  let n = 0;
  const id = () => `c${n++}`;

  for (const s of sentences(text)) {
    const date = parseDate(s.text, ctx.calendarDate);
    const timeGroups = parseTimes(s.text);
    const times = timeGroups.flat();
    const room = ctx.rooms.find((r) => new RegExp(`\\b${r}\\b`, "i").test(s.text)) ?? null;
    const question = s.text.endsWith("?");

    if (COMPLETION.test(s.text) && !question && !INTENTION.test(s.text)) {
      const lower = s.text.toLowerCase();
      const action = /cancel/.test(lower) ? "cancelled" : /moved|rescheduled/.test(lower) ? "rescheduled" : /booked|got you/.test(lower) ? "booked" : "any";
      graph.claims.push({ id: id(), span: s.span, kind: "action_completed", action, date, times });
      continue;
    }
    if (ACCOUNT_NEGATIVE.test(s.text)) {
      graph.claims.push({ id: id(), span: s.span, kind: "appointment_exists", polarity: "negative", date, times });
      continue;
    }
    if (SLOT_NEGATIVE.test(s.text)) {
      graph.claims.push({ id: id(), span: s.span, kind: "slot_open", polarity: "negative", date, times: [], room });
      continue;
    }
    if (ACCOUNT_POSITIVE.test(s.text) && (date || times.length) && !question) {
      graph.claims.push({ id: id(), span: s.span, kind: "appointment_exists", polarity: "positive", date, times });
      continue;
    }
    if (!date && FACT_FRAME.test(s.text)) {
      graph.claims.push({ id: id(), span: s.span, kind: "public_fact", values: (s.text.match(/\$?\d+(?::\d{2})?(?:\s*[ap]\.?m\b\.?)?/gi) ?? []).map((v) => v.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ")) });
      continue;
    }
    if (times.length) {
      // Offering a time (even inside a question) presupposes that it is open.
      graph.claims.push({ id: id(), span: s.span, kind: "slot_open", polarity: "positive", date, times, room });
      continue;
    }
    if (carriesValue(s.text)) {
      graph.uncovered.push(s.span);
      continue;
    }
    graph.claims.push({ id: id(), span: s.span, kind: "discourse", mode: INTENTION.test(s.text) ? "intention" : question ? "question" : "mention" });
  }
  return graph;
}
