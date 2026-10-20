import { createHash } from "node:crypto";

import { normalizePhone } from "../lib/text.ts";

/**
 * Consent evidence and the phone-wide suppression registry.
 *
 * Two rules from production:
 * 1. Suppression is keyed by the normalized PHONE, not the customer record.
 *    A shared household number or a duplicate CRM record must not leak a
 *    message to someone who opted out under another profile.
 * 2. Outbound voice consent must be *verifiable*: the exact disclosure text
 *    the person agreed to is hashed, versioned, timestamped and must mention
 *    calls. "They filled in a form once" is not evidence.
 */

export type Channel = "sms" | "voice";

export type ConsentRecord = {
  granted: boolean;
  channel: Channel;
  /** The disclosure the person saw, verbatim. */
  disclosureText: string;
  disclosureVersion: string;
  disclosureHash: string;
  /** Where it was captured, e.g. "web_form". */
  captureSource: string;
  capturedAt: string;
};

export const CURRENT_DISCLOSURE = {
  version: "2026-01",
  text:
    "By submitting this form you agree that Acme Wellness Studio may contact you by text message and phone calls, " +
    "including automated calls, about your bookings and offers. Consent is not a condition of purchase. " +
    "Reply STOP to opt out at any time.",
};

export function disclosureHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const QUALIFYING_CAPTURE_SOURCES = new Set(["web_form", "booking_widget", "front_desk_tablet"]);

export type ConsentVerdict = { verified: true } | { verified: false; reason: string };

export function verifyConsentEvidence(record: ConsentRecord | null, channel: Channel, now: Date): ConsentVerdict {
  if (!record) return { verified: false, reason: "no_consent_record" };
  if (!record.granted) return { verified: false, reason: "consent_not_granted" };
  if (record.channel !== channel) return { verified: false, reason: "consent_channel_mismatch" };
  if (!QUALIFYING_CAPTURE_SOURCES.has(record.captureSource)) return { verified: false, reason: "unqualified_capture_source" };
  if (disclosureHash(record.disclosureText) !== record.disclosureHash) return { verified: false, reason: "disclosure_hash_mismatch" };
  if (channel === "voice" && !/\bcalls\b/i.test(record.disclosureText)) return { verified: false, reason: "disclosure_omits_calls" };
  const at = Date.parse(record.capturedAt);
  if (!Number.isFinite(at) || at > now.getTime()) return { verified: false, reason: "capture_time_invalid" };
  return { verified: true };
}

export type SuppressionEntry = { phone: string; channel: Channel | "all"; reason: string; at: string };

/** In-memory stand-in for an idempotent suppression table (upsert by phone). */
export class SuppressionRegistry {
  private entries = new Map<string, SuppressionEntry>();

  /** Idempotent: a second STOP updates nothing and reports `created: false`. */
  suppress(phone: string, channel: SuppressionEntry["channel"], reason: string, now = new Date()): { created: boolean } {
    const key = normalizePhone(phone);
    const existing = this.entries.get(key);
    if (existing && (existing.channel === "all" || existing.channel === channel)) return { created: false };
    this.entries.set(key, { phone: key, channel: existing ? "all" : channel, reason, at: now.toISOString() });
    return { created: true };
  }

  /** START re-subscribes SMS only; a voice do-not-call survives an SMS START. */
  resubscribeSms(phone: string): boolean {
    const key = normalizePhone(phone);
    const existing = this.entries.get(key);
    if (!existing) return false;
    if (existing.channel === "sms") {
      this.entries.delete(key);
      return true;
    }
    if (existing.channel === "all") {
      this.entries.set(key, { ...existing, channel: "voice" });
      return true;
    }
    return false;
  }

  isSuppressed(phone: string, channel: Channel): boolean {
    const entry = this.entries.get(normalizePhone(phone));
    return !!entry && (entry.channel === "all" || entry.channel === channel);
  }

  list(): SuppressionEntry[] {
    return [...this.entries.values()];
  }
}

/**
 * Voice opt-out on an outbound call: the IVR strings are fixed copy, never
 * model-composed. Pressing 1 or saying only "stop" removes the number.
 */
export const VOICE_OPT_OUT_PROMPT = "Press 1 or say 'stop' to be removed.";
export const VOICE_OPT_OUT_ACK = "You've been removed.";

export function voiceOptOutRequested(digits: string, speech: string): boolean {
  const text = speech
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return digits === "1" || /^(?:please )?stop(?: please)?$/.test(text);
}
