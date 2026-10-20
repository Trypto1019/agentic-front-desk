import { addDays, localDate, spokenDate } from "../../lib/time.ts";

/**
 * Value gate: every number the assistant sends (a time, date, price, count
 * or any other figure) must be backed by something the server produced this
 * turn. A count of openings is never stated at all; the assistant lists times.
 *
 * Motivating failure: the model told customers "8 openings that morning" when
 * no tool had returned a count and the morning was full.
 *
 * Evidence is this turn's tool results, server-read account context, the
 * customer's own words (echoing "10am isn't open" is not an invention), the
 * approved studio facts, and the next two weeks of calendar. The assistant's
 * own earlier messages never count: a value said before must be re-read.
 */

export type ValueViolation = { kind: "time" | "date" | "price" | "opening_count" | "number"; value: string };
export type ValueGateEvaluation = { guard: "value-gate-v1"; fired: boolean; violations: ValueViolation[] };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WORD_NUMBERS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
const CLOCK = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
const CLOCK_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m)/gi;
const BARE_AT_HOUR = /\bat (\d{1,2})(?::([0-5]\d))?\b(?!\s*(?:a\.?m|p\.?m|%|min|minute|hour|day|week|percent|dollar))/gi;
const MONTH_DAY = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const ORDINAL_DAY = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/gi;
const PRICE = /\$\s?(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?) dollars\b/gi;
/** "8 openings", "nine slots". Not "3 times a week", and not a count that introduces its own list. */
const OPENING_COUNT = new RegExp(
  `\\b(\\d+|${WORD_NUMBERS})\\s+(?:more\\s+|other\\s+)?(?:open\\s+|available\\s+|standard\\s+|suite\\s+)?(?:room\\s+)?(?:openings?|slots?|spots?|times?|availabilit(?:y|ies)|options?)\\b(?!\\s*(?::|a week|per week|a month|per month|a day))`,
  "gi",
);
const NUMBER = /\b\d+(?:\.\d+)?\b/g;

function minutes(hour: number, minute: number, meridiem: string | null): number | null {
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (meridiem.toLowerCase().startsWith("p") ? 12 : 0)) * 60 + minute;
  }
  return hour <= 23 ? hour * 60 + minute : null;
}

const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const stripNumber = (n: string) => (Number.isFinite(Number(n)) ? String(Number(n)) : n);

type Evidence = { times: Set<number>; dates: Set<string>; days: Set<number>; prices: Set<string>; numbers: Set<string> };

function collectEvidence(text: string): Evidence {
  const e: Evidence = { times: new Set(), dates: new Set(), days: new Set(), prices: new Set(), numbers: new Set() };
  for (const m of text.matchAll(CLOCK)) {
    const v = minutes(Number(m[1]), Number(m[2] ?? 0), m[3]);
    if (v != null) e.times.add(v);
  }
  for (const m of text.matchAll(CLOCK_24)) {
    const v = minutes(Number(m[1]), Number(m[2]), null);
    if (v != null) e.times.add(v);
  }
  // A customer's bare "at 10" is evidence for either meridiem.
  for (const m of text.matchAll(BARE_AT_HOUR)) {
    const hour = Number(m[1]);
    if (hour >= 1 && hour <= 12) {
      e.times.add((hour % 12) * 60 + Number(m[2] ?? 0));
      e.times.add(((hour % 12) + 12) * 60 + Number(m[2] ?? 0));
    }
  }
  const addDate = (month: number, day: number) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      e.dates.add(`${month}-${day}`);
      e.days.add(day);
    }
  };
  for (const m of text.matchAll(ISO_DATE)) addDate(Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(MONTH_DAY)) addDate(monthIndex(m[1]), Number(m[2]));
  for (const m of text.matchAll(SLASH_DATE)) addDate(Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(ORDINAL_DAY)) e.days.add(Number(m[1]));
  for (const m of text.matchAll(PRICE)) e.prices.add(stripNumber(m[1] ?? m[2]));
  for (const m of text.matchAll(NUMBER)) e.numbers.add(stripNumber(m[0]));
  for (const m of text.matchAll(/\d+/g)) e.numbers.add(stripNumber(m[0]));
  return e;
}

function staticEvidenceText(now: Date, timeZone: string, facts: Record<string, string>): string {
  const today = localDate(now, timeZone);
  const days = Array.from({ length: 15 }, (_, i) => {
    const d = addDays(today, i);
    return `${d} ${spokenDate(d)}`;
  });
  return [...Object.values(facts), ...days].join("\n");
}

export function evaluateReplyValues(args: {
  reply: string;
  evidence: readonly unknown[];
  inboundText: string;
  now: Date;
  timeZone: string;
  facts: Record<string, string>;
}): ValueGateEvaluation {
  const evidenceText = [
    ...args.evidence.map((item) => (typeof item === "string" ? item : JSON.stringify(item ?? null))),
    args.inboundText,
    staticEvidenceText(args.now, args.timeZone, args.facts),
  ].join("\n");
  const e = collectEvidence(evidenceText);
  const violations: ValueViolation[] = [];

  // Consume matched spans so each figure is judged once, by its most specific reading.
  let rest = args.reply;
  const consume = (re: RegExp, judge: (m: RegExpMatchArray) => ValueViolation | null) => {
    rest = rest.replace(re, (...parts) => {
      const match = parts.slice(0, -2) as unknown as RegExpMatchArray;
      const violation = judge(match);
      if (violation) violations.push({ ...violation, value: violation.value.trim().replace(/\.$/, "") });
      return " ".repeat(String(parts[0]).length);
    });
  };

  consume(OPENING_COUNT, (m) => ({ kind: "opening_count", value: m[0] }));
  consume(PRICE, (m) => (e.prices.has(stripNumber(m[1] ?? m[2])) ? null : { kind: "price", value: m[0] }));
  consume(new RegExp(MONTH_DAY.source, "gi"), (m) => (e.dates.has(`${monthIndex(m[1])}-${Number(m[2])}`) ? null : { kind: "date", value: m[0] }));
  consume(new RegExp(ISO_DATE.source, "g"), (m) => (e.dates.has(`${Number(m[2])}-${Number(m[3])}`) ? null : { kind: "date", value: m[0] }));
  consume(new RegExp(SLASH_DATE.source, "g"), (m) => (e.dates.has(`${Number(m[1])}-${Number(m[2])}`) ? null : { kind: "date", value: m[0] }));
  consume(new RegExp(ORDINAL_DAY.source, "gi"), (m) => (e.days.has(Number(m[1])) ? null : { kind: "date", value: m[0] }));
  consume(new RegExp(CLOCK.source, "gi"), (m) => {
    const v = minutes(Number(m[1]), Number(m[2] ?? 0), m[3]);
    return v != null && e.times.has(v) ? null : { kind: "time", value: m[0] };
  });
  // "8:00 or 9:00" without a meridiem: either reading must be in evidence.
  consume(new RegExp(CLOCK_24.source, "g"), (m) => {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return e.times.has(hour * 60 + minute) || (hour <= 12 && e.times.has(((hour % 12) + 12) * 60 + minute)) ? null : { kind: "time", value: m[0] };
  });
  consume(new RegExp(BARE_AT_HOUR.source, "gi"), (m) => {
    const hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    const ok = e.times.has((hour % 12) * 60 + minute) || e.times.has(((hour % 12) + 12) * 60 + minute) || e.numbers.has(String(hour));
    return ok ? null : { kind: "time", value: m[0] };
  });
  consume(NUMBER, (m) => (e.numbers.has(stripNumber(m[0])) ? null : { kind: "number", value: m[0] }));

  return { guard: "value-gate-v1", fired: violations.length > 0, violations };
}

export function valueGateRedraftInstruction(evaluation: ValueGateEvaluation): string {
  const counts = evaluation.violations.filter((v) => v.kind === "opening_count");
  const values = evaluation.violations.filter((v) => v.kind !== "opening_count").map((v) => `"${v.value}"`);
  return [
    "Your draft was not sent.",
    values.length ? `It stated ${values.join(", ")}, which no tool result in this turn supports. Check with the tools before stating a value, or leave it out.` : "",
    counts.length ? "Never state how many openings, slots or times there are. List the actual times from a check_availability result instead." : "",
    "Write the reply again.",
  ]
    .filter(Boolean)
    .join(" ");
}
