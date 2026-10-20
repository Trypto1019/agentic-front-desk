import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSmsOptOutMessage, isSmsStartMessage, isStopNearMiss, smsOptOutRule } from "../src/compliance/optout-policy.ts";

describe("opt-out policy", () => {
  it("honors the whole-message keywords in any case", () => {
    for (const text of ["STOP", "stop", "Stop.", "STOPALL", "unsubscribe", "QUIT", "quit!"]) {
      assert.equal(smsOptOutRule(text), "keyword_exact", text);
    }
  });

  it("does not treat booking or billing language as revocation", () => {
    for (const text of [
      "I need to cancel my session",
      "cancel",
      "end my membership",
      "I want to quit my membership",
      "I might stop by after work",
      "I'll stop in tomorrow",
      "can I come in at 3?",
      "step one done",
      "top of the morning",
      "please stop by the front desk",
    ]) {
      assert.equal(smsOptOutRule(text), null, text);
    }
  });

  it("keeps a leading or embedded STOP effective in a compound message", () => {
    assert.equal(smsOptOutRule("STOP\n\nLoved the studio but I moved away"), "keyword_embedded");
    assert.equal(smsOptOutRule("STOP in case you wondered"), "keyword_embedded");
    assert.equal(smsOptOutRule("ok unsubscribe me thanks"), "keyword_embedded");
  });

  it("strips the visit sense but still opts out on a real revocation", () => {
    assert.ok(smsOptOutRule("stop texting me, I'll stop by later"));
  });

  it("catches conversational revocation", () => {
    for (const text of [
      "take me off your list",
      "Please remove me",
      "leave me alone",
      "no more texts",
      "I revoke my consent to be contacted",
      "opt me out",
      "don't text me again",
      "not interested in texts",
      "make it stop",
    ]) {
      assert.ok(isSmsOptOutMessage(text), text);
    }
  });

  it("treats near-miss typos of STOP as revocation, but not real words", () => {
    for (const typo of ["stip", "stpo", "stopp", "s t o p", "unsubscibe"]) assert.ok(isStopNearMiss(typo), typo);
    for (const word of ["step", "shop", "top", "spot", "post"]) assert.equal(isStopNearMiss(word), false, word);
  });

  it("normalizes smart punctuation and zero-width characters", () => {
    assert.ok(isSmsOptOutMessage("don’t text me"));
    assert.ok(isSmsOptOutMessage("ST​OP"));
  });

  it("recognizes START", () => {
    assert.ok(isSmsStartMessage("start"));
    assert.ok(isSmsStartMessage("UNSTOP"));
    assert.equal(isSmsStartMessage("let's start with a session"), false);
  });
});
