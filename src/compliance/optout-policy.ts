import { classifierText, normalizeDeterministicText } from "../lib/text.ts";

/**
 * Deterministic SMS opt-out policy. This runs BEFORE the LLM on every inbound
 * text, and honoring an opt-out never depends on model judgment.
 *
 * Design decisions (each one was driven by a real regression):
 *
 * - The whole-message keyword set is STOP, STOPALL, UNSUBSCRIBE and QUIT.
 *   CANCEL and END are deliberately NOT keywords for a booking business: the
 *   large majority of inbound texts containing "cancel" are appointment
 *   changes ("cancel my session"), and "end my membership" is a billing
 *   request. Those belong to the agent.
 * - QUIT opts out only as a standalone message. "Quit" inside a sentence
 *   ("quit my membership") stays with the agent, so it is absent from the
 *   compound and leading-keyword rules.
 * - Unambiguous natural-language revocation still opts out ("take me off
 *   your list", "stop texting me"): consent may be revoked in any reasonable
 *   manner, so a phrase is as binding as the keyword.
 */
export const SMS_STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "QUIT"]);
export const SMS_START_KEYWORDS = new Set(["START", "UNSTOP"]);

const NL_OPT_OUT_COMMS_TARGET =
  "(?:texts?|texting|messages?|messaging|msgs?|contact(?:ing)?|emails?|emailing|sending|send|reaching out|reach out|notifications?)";

/** Phrase set for conversational revocation. None collide with booking or billing language. */
const NL_OPT_OUT_STRONG: RegExp[] = [
  /\bdiscontinue\b(?!\s+(?:(?:my|the|our|this)\s+)?(?:membership|subscription|plan|package)\b)/,
  /\bnot interested in (?:texts?|texting|messages?|messaging)\b/,
  /\bleave me alone\b/,
  /\b(?:take|remove) me off\b/,
  /\bremove me\b/,
  /\b(?:remove|delete|lose) my (?:number|phone|info|contact|details)\b/,
  /\bopt(?:ing)? ?-? ?(?:me )?out\b/,
  // REVOKE is a phrase, not a keyword: it needs an object, so it can never
  // fire on a bare word. Nobody "revokes" an appointment.
  /\brevok(?:e|es|ed|ing)\b(?:\s+\w+){0,3}?\s+(?:consent|permission|authorization|approval|opt in)\b/,
  new RegExp(`\\brevok(?:e|es|ed|ing)\\b(?:\\s+\\w+){0,3}?\\s+${NL_OPT_OUT_COMMS_TARGET}\\b`),
  new RegExp(`\\bno more ${NL_OPT_OUT_COMMS_TARGET}\\b`),
  // "please stop" is a command, but "please stop by" is a visit invitation.
  /\b(?:please|just|kindly|now) stop\b(?!\s+(?:by|in|over|around|on|playing)\b)/,
  /\bstop (?:it|now|please)\b/,
  /\bmake (?:it|this|them) stop\b/,
];

/**
 * Carrier-standard revocation words stay effective inside a compound message:
 * "STOP\n\nloved the studio but I moved away" must opt out.
 */
const COMPOUND_OPT_OUT_KEYWORD = /\b(?:stopall|stop|unsubscribe)\b/;

/** A message that OPENS with the keyword revokes no matter what follows ("STOP in case you wondered"). */
const OPT_OUT_KEYWORD_LEADING = /^(?:stopall|stop|unsubscribe)\b/;

/**
 * "stop by" / "stop in" is a VISIT, not a revocation. Visit senses are
 * STRIPPED rather than short-circuiting the whole message, so a text carrying
 * both ("stop texting me, I'll stop by later") still opts out.
 */
const STOP_VISIT_SENSE = /\bstop\s+(?:by|in(?!\s+case\b)|over|around|on|playing)\b/g;

function hasCompoundOptOutKeyword(text: string): boolean {
  const withoutVisits = text.replace(STOP_VISIT_SENSE, " ");
  if (OPT_OUT_KEYWORD_LEADING.test(withoutVisits)) return true;
  return COMPOUND_OPT_OUT_KEYWORD.test(withoutVisits);
}

/** "stop"/"quit"/"don't" + a messaging target within 3 words. The target is REQUIRED. */
const NL_OPT_OUT_VERB_TARGET = new RegExp(
  `\\b(?:stop|quit|cease|halt|don'?t|dont|do not)\\b(?:\\s+\\w+){0,3}?\\s+${NL_OPT_OUT_COMMS_TARGET}\\b`,
);

/**
 * Near-miss keywords: a whole message one typo away from STOP ("STIP",
 * "Stpo", "STOPP") or two from UNSUBSCRIBE is a revocation. Real words one
 * typo away ("step", "shop", "top", "spot") are not.
 */
const NEAR_MISS_REAL_WORDS = new Set([
  "step", "shop", "slop", "stow", "sop", "top", "atop", "stoa", "spot", "stoop", "stomp", "stoat",
  "stab", "stay", "stem", "stir", "star", "stun", "stub", "stud", "tops", "post", "pots", "opts",
]);

/** Damerau-Levenshtein (optimal string alignment): a swapped pair is one edit. */
export function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= max;
}

export function isStopNearMiss(text: string): boolean {
  const trimmed = text.trim();
  // One word, or STOP spelled out with spaces ("S T O P").
  if (/\s/.test(trimmed) && !/^s\s*t\s*o\s*p$/.test(trimmed)) return false;
  const word = trimmed.replace(/[^a-z]/g, "");
  if (!word || NEAR_MISS_REAL_WORDS.has(word)) return false;
  return (
    (word.length >= 3 && word.length <= 6 && editDistanceAtMost(word, "stop", 1)) ||
    /^stop+$/.test(word) ||
    (word.length >= 9 && editDistanceAtMost(word, "unsubscribe", 2))
  );
}

export type OptOutRule = "keyword_exact" | "keyword_embedded" | "keyword_near_miss" | `natural_${number}` | "verb_contact";

/** Which deterministic rule fired, or null. The rule name is stored on the audit record. */
export function smsOptOutRule(raw: string): OptOutRule | null {
  const text = classifierText(raw);
  if (!text) return null;
  if (SMS_STOP_KEYWORDS.has(text.toUpperCase())) return "keyword_exact";
  if (hasCompoundOptOutKeyword(text)) return "keyword_embedded";
  if (isStopNearMiss(text)) return "keyword_near_miss";
  const strong = NL_OPT_OUT_STRONG.findIndex((pattern) => pattern.test(text));
  if (strong >= 0) return `natural_${strong}`;
  return NL_OPT_OUT_VERB_TARGET.test(text) ? "verb_contact" : null;
}

export function isSmsOptOutMessage(raw: string): boolean {
  const normalized = normalizeDeterministicText(raw);
  const keyword = normalized.trim().toUpperCase().replace(/\s+/g, " ");
  return SMS_STOP_KEYWORDS.has(keyword) || smsOptOutRule(normalized) !== null;
}

export function isSmsStartMessage(raw: string): boolean {
  return SMS_START_KEYWORDS.has(classifierText(raw).toUpperCase());
}
