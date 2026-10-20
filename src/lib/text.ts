/**
 * Canonicalize smart punctuation before deterministic text matching.
 *
 * Customer text stays verbatim in storage and in model context. This helper is
 * only for rule-based classifiers, where visually equivalent phone-keyboard
 * punctuation (curly quotes, en dashes) must not change the outcome.
 */
export function normalizeDeterministicText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/…/g, "...");
}

/** Lowercase, strip punctuation (keeping apostrophes) and collapse whitespace. */
export function classifierText(raw: string): string {
  return normalizeDeterministicText(raw.normalize("NFKC").replace(/[​-‍﻿]/g, ""))
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** E.164-ish normalization for US numbers: "+1 (555) 010-0123" -> "+15550100123". */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim();
}
