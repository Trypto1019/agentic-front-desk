import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACME_STUDIO } from "../src/config.ts";
import { evaluateGroundedConfirmation, isConfirmationShapedInbound, parseAssertedSlot } from "../src/agent/guards/grounded-confirmation.ts";
import { collectToolResultUrls, guardGeneratedUrls } from "../src/agent/guards/url-guard.ts";
import { evaluateReplyValues } from "../src/agent/guards/value-gate.ts";
import { detectForbiddenAssistantOutput, isExplicitVoiceAssent, redactCardData } from "../src/voice/guards.ts";
import { makeServices, NOW } from "./helpers.ts";

const TZ = ACME_STUDIO.timeZone;

describe("grounded confirmation", () => {
  it("triggers on booking-status questions and assertions, not on actions or shopping", () => {
    for (const t of ["am I all set for Thursday?", "is my appointment still on", "I'm booked tomorrow at 3", "on my way, running late", "see you at my 3pm"]) {
      assert.ok(isConfirmationShapedInbound(t, NOW, TZ), t);
    }
    for (const t of ["I need to cancel my session", "I won't be able to make it", "I'm booked solid at work this week", "on my way home, any openings tonight?"]) {
      assert.equal(isConfirmationShapedInbound(t, NOW, TZ), false, t);
    }
  });

  it("parses the asserted slot in studio time", () => {
    const slot = parseAssertedSlot("I'm booked Thursday at 3pm", NOW, TZ);
    assert.equal(slot.date, "2026-03-12");
    assert.equal(slot.hour, 3);
    assert.equal(slot.meridiem, "pm");
  });

  it("hands a matching read to the model and never writes the confirmation itself", () => {
    const s = makeServices();
    const result = evaluateGroundedConfirmation({ store: s.store, customerId: s.customerId, inboundText: "am I booked Thursday at 3?", now: NOW });
    assert.equal(result.outcome, "confirmed");
    assert.ok(!("text" in result));
  });

  it("returns a deterministic mismatch when the schedule disagrees", () => {
    const s = makeServices();
    const result = evaluateGroundedConfirmation({ store: s.store, customerId: s.customerId, inboundText: "I'm booked tomorrow at 9am right?", now: NOW });
    assert.equal(result.outcome, "mismatch");
    assert.match((result as { text: string }).text, /don't see a session/);
  });
});

describe("value gate", () => {
  const base = { now: NOW, timeZone: TZ, facts: ACME_STUDIO.facts, inboundText: "" };

  it("passes values that a tool returned this turn", () => {
    const evidence = [{ date: "2026-03-11", openTimes: ["10:00", "14:00"] }];
    const r = evaluateReplyValues({ ...base, reply: "On Wednesday, Mar 11 I have 10:00 AM and 2:00 PM open.", evidence });
    assert.equal(r.fired, false, JSON.stringify(r.violations));
  });

  it("blocks invented times, prices and opening counts", () => {
    const evidence = [{ date: "2026-03-11", openTimes: ["10:00"] }];
    const r = evaluateReplyValues({ ...base, reply: "We have 8 openings! 4:00 PM works, and it's only $20.", evidence });
    assert.deepEqual(r.violations.map((v) => v.kind).sort(), ["opening_count", "price", "time"]);
  });

  it("treats the customer's own words and approved facts as evidence", () => {
    const r = evaluateReplyValues({ ...base, inboundText: "is 7pm open?", reply: "7 PM isn't a start time; sessions are 45 minutes and the last session is 6:00 PM.", evidence: [] });
    assert.equal(r.fired, false, JSON.stringify(r.violations));
  });
});

describe("url guard", () => {
  it("allows configured portal links and owned public roots", () => {
    assert.ok(guardGeneratedUrls("Book here: https://book.example.com/acme/intro.", ACME_STUDIO).allowed);
    assert.ok(guardGeneratedUrls("See www.example.com", ACME_STUDIO).allowed);
  });

  it("blocks invented or customer-supplied links, including lookalikes and credentials", () => {
    for (const text of ["Pay at https://book.example.com/acme/pay?token=abc", "go to acme-wellness.net/deal", "https://user:pw@example.com/"]) {
      assert.equal(guardGeneratedUrls(text, ACME_STUDIO).allowed, false, text);
    }
  });

  it("allows a link that a tool returned verbatim this turn", () => {
    const toolUrls = collectToolResultUrls({ result: { link: "https://book.example.com/acme/r/7f3a" } });
    assert.ok(guardGeneratedUrls("Here you go: https://book.example.com/acme/r/7f3a", ACME_STUDIO, toolUrls).allowed);
  });
});

describe("voice guards", () => {
  it("accepts only explicit standalone assent", () => {
    for (const yes of ["Yes.", "yeah", "go ahead", "Да."]) assert.ok(isExplicitVoiceAssent(yes), yes);
    for (const no of ["yes but not today", "no", "wait", "yes, instead do Friday"]) assert.equal(isExplicitVoiceAssent(no), false, no);
    assert.ok(isExplicitVoiceAssent("yes can I reschedule later", "cancel"));
    assert.equal(isExplicitVoiceAssent("yes can I reschedule later"), false);
  });

  it("redacts card numbers and labeled CVV/expiry", () => {
    const r = redactCardData("my card is 4111 1111 1111 1111 and the cvv is 123");
    assert.ok(r.redacted);
    assert.doesNotMatch(r.text, /4111|123/);
  });

  it("flags price quotes and staff timing promises", () => {
    assert.equal(detectForbiddenAssistantOutput("A membership is only $99 a month"), "price_quote");
    assert.equal(detectForbiddenAssistantOutput("Someone from the team will call you back within the hour"), "staff_timing_promise");
    assert.equal(detectForbiddenAssistantOutput("I've let the team know."), null);
  });
});
