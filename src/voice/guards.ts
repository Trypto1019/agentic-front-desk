import { normalizeDeterministicText } from "../lib/text.ts";

/**
 * Deterministic guards for the realtime voice channel. Speech recognition
 * output is noisy, so assent detection is deliberately narrow: an exact,
 * standalone affirmative confirms; any negation or hedge vetoes.
 */

export function isExplicitVoiceAssent(value: string, action?: "cancel"): boolean {
  // ASR sometimes renders a clear spoken "yes" as a standalone foreign-script
  // affirmative. Accept it only when it is the entire utterance; never infer
  // assent from a mixed-language sentence.
  if (/^(?:да|sí|si|oui)[.!\s]*$/i.test(value.trim())) return true;
  const normalized = normalizeDeterministicText(value)
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(no|not|don't|do not|wait|instead|but)\b/.test(normalized)) return false;
  // A yes to the exact pending cancellation stays a yes when followed by this
  // narrow question. It does not authorize a replacement booking.
  if (action === "cancel" && /^yes (?:please )?can i reschedule (?:it|later)$/.test(normalized)) return true;
  return /^(yes|yes please|yes that's correct|yeah|yep|correct|confirm|confirmed|book it|please book it|that works|that works for me|works for me|do it|go ahead)$/.test(
    normalized,
  );
}

/**
 * Card data never reaches the transcript store or the model. Digit runs that
 * look like a PAN (13-20 digits with optional separators) and labeled
 * CVV/expiry values are replaced before anything is persisted.
 */
export function redactCardData(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = value.replace(/(?:\d[ -]?){12,19}\d/g, () => {
    redacted = true;
    return "[PAYMENT CARD REDACTED]";
  });
  text = text.replace(/\b(cvv|cvc|security code|expiration|expiry)\s*(?:is|of|:)?\s*[0-9/ -]{3,8}\b/gi, (_m, label: string) => {
    redacted = true;
    return `${label} [REDACTED]`;
  });
  return { text, redacted };
}

/**
 * Output the voice agent must never produce: a price quote (pricing belongs
 * to staff) or a promise about when staff will call back (nobody can keep it).
 */
export function detectForbiddenAssistantOutput(value: string): "price_quote" | "staff_timing_promise" | null {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (
    /\$\s*\d/.test(normalized) ||
    /\b\d+(?:\.\d{1,2})?\s*(?:dollars?|cents?)\b/.test(normalized) ||
    /\b(?:costs?|priced?|price is|package is|membership is)\s+(?:only\s+)?\$?\d/.test(normalized)
  ) {
    return "price_quote";
  }
  if (/\b(?:staff|team|someone|we(?:'ll| will))\b.{0,40}\b(?:call|contact|reach|get back|respond)\b.{0,30}\b(?:within|in|by|today|tonight|tomorrow|soon|asap)\b/.test(normalized)) {
    return "staff_timing_promise";
  }
  return null;
}
