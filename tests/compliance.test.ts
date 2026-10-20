import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { callingZones, insideCallingWindow, phoneTimeZones } from "../src/compliance/calling-window.ts";
import { CURRENT_DISCLOSURE, disclosureHash, SuppressionRegistry, verifyConsentEvidence, voiceOptOutRequested, type ConsentRecord } from "../src/compliance/consent.ts";
import { conversationCapacity, evaluateOutboundGates, firstOutboundFailure, reserveAndDial, type GateSnapshot } from "../src/compliance/outbound-gate.ts";

const consent: ConsentRecord = {
  granted: true,
  channel: "voice",
  disclosureText: CURRENT_DISCLOSURE.text,
  disclosureVersion: CURRENT_DISCLOSURE.version,
  disclosureHash: disclosureHash(CURRENT_DISCLOSURE.text),
  captureSource: "web_form",
  capturedAt: "2026-03-01T18:00:00Z",
};

// 2026-03-10 18:00Z = 2 PM New York, 11 AM Los Angeles.
const midday = "2026-03-10T18:00:00Z";

function snapshot(overrides: Partial<GateSnapshot> = {}): GateSnapshot {
  return {
    now: midday,
    businessZone: "America/Los_Angeles",
    enabled: true,
    phone: "+15550100155",
    consent,
    doNotContact: false,
    smsOptOut: false,
    voiceOptOut: false,
    dailyCap: 3,
    dailyInUse: 0,
    priorCallTimes: [],
    lastContactAt: null,
    openStaffTask: false,
    alreadyBooked: false,
    ...overrides,
  };
}

describe("calling window", () => {
  it("requires every candidate zone to be inside 9 AM - 7 PM", () => {
    assert.ok(insideCallingWindow(new Date(midday), ["America/New_York", "America/Los_Angeles"]));
    // 15:00Z = 11 AM New York but 8 AM Los Angeles: too early on the west coast.
    assert.equal(insideCallingWindow(new Date("2026-03-10T15:00:00Z"), ["America/New_York", "America/Los_Angeles"]), false);
    assert.equal(insideCallingWindow(new Date(midday), []), false);
  });

  it("fails closed for unknown area codes by checking every continental zone", () => {
    assert.equal(phoneTimeZones("+15550100155").length, 5);
    assert.deepEqual(phoneTimeZones("+15550100155", { "555": ["America/Denver"] }), ["America/Denver"]);
    assert.equal(callingZones("+15550100155", "America/Los_Angeles").length, 5);
  });
});

describe("consent evidence", () => {
  const now = new Date(midday);
  it("verifies a complete, hashed, call-mentioning disclosure", () => {
    assert.deepEqual(verifyConsentEvidence(consent, "voice", now), { verified: true });
  });
  it("rejects edited disclosure text, wrong channel, future capture and missing records", () => {
    assert.equal(verifyConsentEvidence({ ...consent, disclosureText: consent.disclosureText + " (edited)" }, "voice", now).verified, false);
    assert.equal(verifyConsentEvidence({ ...consent, channel: "sms" }, "voice", now).verified, false);
    assert.equal(verifyConsentEvidence({ ...consent, capturedAt: "2027-01-01T00:00:00Z" }, "voice", now).verified, false);
    assert.equal(verifyConsentEvidence(null, "voice", now).verified, false);
    const smsOnly = "You agree to receive texts from Acme Wellness Studio.";
    assert.equal(verifyConsentEvidence({ ...consent, disclosureText: smsOnly, disclosureHash: disclosureHash(smsOnly) }, "voice", now).verified, false);
  });
});

describe("suppression registry", () => {
  it("is idempotent and phone-normalized", () => {
    const reg = new SuppressionRegistry();
    assert.deepEqual(reg.suppress("(555) 010-0120", "sms", "keyword_exact"), { created: true });
    assert.deepEqual(reg.suppress("+15550100120", "sms", "keyword_exact"), { created: false });
    assert.ok(reg.isSuppressed("555-010-0120", "sms"));
  });
  it("keeps a voice do-not-call through an SMS START", () => {
    const reg = new SuppressionRegistry();
    reg.suppress("+15550100121", "sms", "stop");
    reg.suppress("+15550100121", "voice", "ivr");
    reg.resubscribeSms("+15550100121");
    assert.equal(reg.isSuppressed("+15550100121", "sms"), false);
    assert.ok(reg.isSuppressed("+15550100121", "voice"));
  });
  it("detects IVR opt-out", () => {
    assert.ok(voiceOptOutRequested("1", ""));
    assert.ok(voiceOptOutRequested("", "Stop."));
    assert.equal(voiceOptOutRequested("", "don't stop the music"), false);
  });
});

describe("outbound gate", () => {
  it("approves a clean snapshot and evaluates every gate", () => {
    assert.equal(firstOutboundFailure(snapshot()), null);
    const failures = evaluateOutboundGates(snapshot({ smsOptOut: true, dailyInUse: 3 })).filter((g) => !g.passed).map((g) => g.gate);
    assert.deepEqual(failures, ["sms_opt_out", "daily_cap"]);
  });

  it("enforces frequency caps and cooldowns", () => {
    assert.equal(firstOutboundFailure(snapshot({ priorCallTimes: ["2026-03-08T18:00:00Z"] })), "customer_7_day_cap");
    assert.equal(firstOutboundFailure(snapshot({ lastContactAt: "2026-03-10T10:00:00Z" })), "contact_within_24_hours");
    assert.equal(firstOutboundFailure(snapshot({ now: "2026-03-10T03:00:00Z" })), "outside_calling_window");
  });

  it("rechecks immediately before dialing: a STOP between reserve and dial wins", async () => {
    const snapshots = [snapshot(), snapshot({ smsOptOut: true })];
    const audit: string[] = [];
    let dialed = false;
    const result = await reserveAndDial(async () => snapshots.shift()!, async () => void (dialed = true), (row) => audit.push(`${row.action}:${row.reason}`));
    assert.deepEqual(result, { dialed: false, reason: "sms_opt_out" });
    assert.equal(dialed, false);
    assert.deepEqual(audit, ["outbound_reserve:approved", "outbound_predial_recheck:sms_opt_out"]);
  });

  it("counts only two-way human conversations against the cap", () => {
    assert.equal(conversationCapacity(null), "pending");
    assert.equal(conversationCapacity({ ended: true, outcome: "voicemail", answered: true, callerSpoke: false, agentSpoke: true }), "excluded");
    assert.equal(conversationCapacity({ ended: false, outcome: "voicemail", answered: true, callerSpoke: false, agentSpoke: true }), "pending");
    assert.equal(conversationCapacity({ ended: true, outcome: "completed", answered: true, callerSpoke: true, agentSpoke: true }), "conversation");
    assert.equal(conversationCapacity({ ended: true, answered: false, callerSpoke: false, agentSpoke: false }), "excluded");
  });
});
