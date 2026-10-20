import { verifyConsentEvidence, type ConsentRecord } from "./consent.ts";
import { callingZones, insideCallingWindow } from "./calling-window.ts";

/**
 * Outbound call gate: every condition is evaluated (not just up to the first
 * failure) so the audit row shows the full picture, and the gate runs TWICE —
 * once when the call is reserved and again immediately before dialing. A
 * STOP that arrives between reservation and dial must still win.
 */

const DAY = 86_400_000;

export type GateSnapshot = {
  now: string;
  businessZone: string;
  enabled: boolean;
  phone: string;
  consent: ConsentRecord | null;
  doNotContact: boolean;
  smsOptOut: boolean;
  voiceOptOut: boolean;
  dailyCap: number;
  /** Human conversations already held today plus unresolved attempts. */
  dailyInUse: number;
  /** ISO timestamps of earlier outbound calls to this person. */
  priorCallTimes: string[];
  lastContactAt: string | null;
  openStaffTask: boolean;
  alreadyBooked: boolean;
};

export type GateEvaluation = { gate: string; passed: boolean };

export function evaluateOutboundGates(s: GateSnapshot): GateEvaluation[] {
  const now = new Date(s.now);
  const t = now.getTime();
  const checks: Array<[string, boolean]> = [
    ["outbound_disabled", s.enabled],
    ["voice_consent_unverified", verifyConsentEvidence(s.consent, "voice", now).verified],
    ["do_not_contact", !s.doNotContact],
    ["sms_opt_out", !s.smsOptOut],
    ["voice_opt_out", !s.voiceOptOut],
    ["invalid_e164", /^\+[1-9]\d{7,14}$/.test(s.phone)],
    ["outside_calling_window", insideCallingWindow(now, callingZones(s.phone, s.businessZone))],
    ["invalid_daily_cap", Number.isInteger(s.dailyCap) && s.dailyCap >= 1],
    ["daily_cap", s.dailyInUse < s.dailyCap],
    ["customer_7_day_cap", !s.priorCallTimes.some((at) => Date.parse(at) >= t - 7 * DAY)],
    ["customer_30_day_cap", s.priorCallTimes.filter((at) => Date.parse(at) >= t - 30 * DAY).length < 3],
    ["contact_within_24_hours", !s.lastContactAt || Date.parse(s.lastContactAt) < t - DAY],
    ["open_staff_task", !s.openStaffTask],
    ["already_booked", !s.alreadyBooked],
  ];
  return checks.map(([gate, passed]) => ({ gate, passed }));
}

export function firstOutboundFailure(s: GateSnapshot): string | null {
  return evaluateOutboundGates(s).find((c) => !c.passed)?.gate ?? null;
}

/**
 * Conversation cap accounting: only a verified two-way human conversation
 * consumes the daily cap. Voicemail, no-answer and wrong-number calls release
 * capacity once they end; anything unresolved still holds it.
 */
export type CallState = {
  ended: boolean;
  outcome?: "voicemail" | "no_answer" | "wrong_number" | "completed";
  answered: boolean;
  callerSpoke: boolean;
  agentSpoke: boolean;
};

export type Capacity = "conversation" | "pending" | "excluded";

export function conversationCapacity(state: CallState | null): Capacity {
  if (!state) return "pending"; // a committed reservation before the call exists
  const nonConversation = state.outcome === "voicemail" || state.outcome === "no_answer" || state.outcome === "wrong_number";
  if (nonConversation) return state.ended ? "excluded" : "pending";
  if (state.answered && state.callerSpoke && state.agentSpoke) return "conversation";
  if (state.ended && !state.answered) return "excluded";
  return "pending";
}

export type AuditSink = (row: { action: string; approved: boolean; reason: string; evaluations: GateEvaluation[] }) => void;

/**
 * Reserve-then-recheck. `load` must read a FRESH snapshot each time (in
 * production: inside a transaction holding a row lock on the customer).
 */
export async function reserveAndDial(
  load: () => Promise<GateSnapshot>,
  dial: () => Promise<void>,
  audit: AuditSink,
): Promise<{ dialed: boolean; reason: string }> {
  const reserve = await load();
  const reserveFailure = firstOutboundFailure(reserve);
  audit({ action: "outbound_reserve", approved: !reserveFailure, reason: reserveFailure ?? "approved", evaluations: evaluateOutboundGates(reserve) });
  if (reserveFailure) return { dialed: false, reason: reserveFailure };

  const predial = await load();
  const predialFailure = firstOutboundFailure(predial);
  audit({ action: "outbound_predial_recheck", approved: !predialFailure, reason: predialFailure ?? "approved", evaluations: evaluateOutboundGates(predial) });
  if (predialFailure) return { dialed: false, reason: predialFailure };

  await dial();
  return { dialed: true, reason: "approved" };
}
