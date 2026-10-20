import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACME_STUDIO } from "../src/config.ts";
import { EvidenceIndex, parseClaims, verifyUtterance, type EvidenceRead } from "../src/verifier/index.ts";
import { NOW, TODAY } from "./helpers.ts";

const ctx = { calendarDate: TODAY, rooms: ACME_STUDIO.rooms };
const at = NOW.getTime();

function index(customerId: string | null = "cust-1", now = () => at) {
  return new EvidenceIndex({ customerId, now, publicFacts: Object.values(ACME_STUDIO.facts) });
}

function schedulerRead(date: string, times: string[], id = `sched-${date}`): EvidenceRead {
  return { id, authority: "scheduler_read", scope: { date, room: "standard" }, rows: times.map((time) => ({ date, time, room: "standard" })), complete: true, observedAt: at, revision: 0, source: { tool: "check_availability", invocationId: id } };
}

describe("claim parser", () => {
  it("separates questions, completions, offers and uncovered values", () => {
    const g = parseClaims("You're booked! Wednesday, Mar 11 at 10:00 AM is open. Which works? It costs 40.", ctx);
    assert.deepEqual(g.claims.map((c) => c.kind), ["action_completed", "slot_open", "discourse"]);
    assert.equal(g.uncovered.length, 1);
  });

  it("keeps 'p.m.' inside one sentence", () => {
    const g = parseClaims("I have 3:00 p.m. open tomorrow. Want it?", ctx);
    assert.equal(g.claims.length, 2);
  });
});

describe("proof engine", () => {
  it("withholds a completion claim without a server receipt", () => {
    const v = verifyUtterance("Done! You're booked for a free session.", index(), ctx);
    assert.equal(v.proof.decision, "WITHHOLD");
  });

  it("allows a completion claim backed by a receipt minted by the runtime this turn", () => {
    const idx = index();
    const mint = idx.issueReceiptMinter();
    mint({ id: "r1", action: "booked", customerId: "cust-1", date: "2026-03-11", time: "10:00", at });
    assert.equal(verifyUtterance("You're booked for Wednesday, Mar 11 at 10:00 AM.", idx, ctx).proof.decision, "ALLOW");
    assert.throws(() => idx.issueReceiptMinter(), /ALREADY_ISSUED/);
  });

  it("allows offered times only from a fresh scheduler read", () => {
    const idx = index();
    idx.addRead(schedulerRead("2026-03-11", ["10:00", "14:00"]));
    assert.equal(verifyUtterance("On Wednesday, Mar 11 I have 10:00 AM and 2:00 PM open. Which works?", idx, ctx).proof.decision, "ALLOW");
    const bad = verifyUtterance("On Wednesday, Mar 11 I have 4:00 PM open.", idx, ctx);
    assert.equal(bad.proof.status, "contradicted");
  });

  it("proves 'nothing open' only from a complete read", () => {
    const idx = index();
    idx.addRead(schedulerRead("2026-03-11", []));
    assert.equal(verifyUtterance("Nothing is open on Wednesday, Mar 11.", idx, ctx).proof.decision, "ALLOW");
    assert.equal(verifyUtterance("Nothing is open on Thursday, Mar 12.", idx, ctx).proof.status, "missing");
  });

  it("a mutation makes earlier reads stale", () => {
    const idx = index();
    idx.addRead(schedulerRead("2026-03-11", ["10:00"]));
    idx.issueReceiptMinter()({ id: "r1", action: "booked", customerId: "cust-1", date: "2026-03-11", time: "10:00", at });
    assert.equal(verifyUtterance("On Wednesday, Mar 11 I have 10:00 AM open.", idx, ctx).proof.status, "missing");
  });

  it("expires account reads after the freshness window and refuses to weaken it", () => {
    let clock = at;
    const idx = index("cust-1", () => clock);
    idx.addRead({ id: "acct", authority: "account_read", customerId: "cust-1", scope: {}, rows: [{ date: "2026-03-12", time: "15:00" }], complete: true, observedAt: at, revision: 0, source: { tool: "my_sessions", invocationId: "x" } });
    assert.equal(verifyUtterance("You have a session Thursday at 3:00 PM.", idx, ctx).proof.decision, "ALLOW");
    clock = at + 61_000;
    assert.equal(verifyUtterance("You have a session Thursday at 3:00 PM.", idx, ctx).proof.decision, "WITHHOLD");
    assert.throws(() => new EvidenceIndex({ customerId: "c", accountMaxAgeMs: 3_600_000 }), /CANNOT_BE_WEAKENED/);
  });

  it("binds account evidence to the resolved customer", () => {
    const idx = index("cust-1");
    assert.throws(() => idx.addRead({ id: "x", authority: "account_read", customerId: "cust-2", scope: {}, rows: [], complete: true, observedAt: at, revision: 0, source: { tool: "t", invocationId: "i" } }), /BINDING/);
  });

  it("supports approved public facts and rejects invented ones", () => {
    assert.equal(verifyUtterance("We're open daily: first session 8:00 AM, last session 6:00 PM.", index(), ctx).proof.decision, "ALLOW");
    assert.equal(verifyUtterance("We're open daily: first session 6:00 AM.", index(), ctx).proof.decision, "WITHHOLD");
  });
});
