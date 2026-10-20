import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyConfirmationReply, InvalidTransitionError, PendingIntentStore } from "../src/state/pending-intent.ts";
import { TurnQueue } from "../src/state/turn-queue.ts";
import { NOW } from "./helpers.ts";

describe("pending intent state machine", () => {
  it("supersedes the older open intent when a new one is prepared", () => {
    const store = new PendingIntentStore();
    const first = store.create({ customerId: "c1", intentType: "BOOK_SESSION", payload: { time: "10:00" }, now: NOW });
    const second = store.create({ customerId: "c1", intentType: "CANCEL_SESSION", payload: {}, now: NOW });
    assert.equal(store.get(first.id)!.status, "SUPERSEDED");
    assert.equal(store.latestOpen("c1", NOW)!.id, second.id);
  });

  it("expires lazily after the TTL", () => {
    const store = new PendingIntentStore();
    const intent = store.create({ customerId: "c1", intentType: "BOOK_SESSION", payload: {}, now: NOW, ttlMs: 60_000 });
    assert.equal(store.latestOpen("c1", new Date(NOW.getTime() + 61_000)), null);
    assert.equal(store.get(intent.id)!.status, "EXPIRED");
  });

  it("refuses transitions out of a terminal state", () => {
    const store = new PendingIntentStore();
    const intent = store.create({ customerId: "c1", intentType: "BOOK_SESSION", payload: {}, now: NOW });
    store.transition(intent.id, "RESOLVED", NOW);
    assert.throws(() => store.transition(intent.id, "RESOLVED", NOW), InvalidTransitionError);
  });

  it("classifies only bare assent as YES; hedges go to the agent", () => {
    for (const yes of ["YES", "yes!", "Yep", "confirm", "yes please", "Y"]) assert.equal(classifyConfirmationReply(yes), "yes", yes);
    for (const no of ["no", "Nope", "no thanks"]) assert.equal(classifyConfirmationReply(no), "no", no);
    for (const other of ["yes but can we do 4 instead", "yes actually make it Friday", "what time was it?", "not yet"]) {
      assert.equal(classifyConfirmationReply(other), null, other);
    }
  });
});

describe("turn queue", () => {
  it("serializes tasks per key in arrival order and runs other keys concurrently", async () => {
    const queue = new TurnQueue({ onError: () => {} });
    const log: string[] = [];
    const task = (name: string, ms: number) => () => new Promise<void>((resolve) => setTimeout(() => (log.push(name), resolve()), ms));
    const a1 = queue.enqueue("a", task("a1", 30));
    const a2 = queue.enqueue("a", task("a2", 1));
    const b1 = queue.enqueue("b", task("b1", 5));
    await Promise.all([a1, a2, b1]);
    assert.deepEqual(log, ["b1", "a1", "a2"]);
    assert.equal(queue.activeCount, 0);
  });

  it("contains a failing task and keeps the chain alive", async () => {
    const errors: unknown[] = [];
    const queue = new TurnQueue({ onError: (_k, e) => errors.push(e) });
    let ran = false;
    await queue.enqueue("a", async () => {
      throw new Error("boom");
    });
    await queue.enqueue("a", async () => {
      ran = true;
    });
    assert.equal(errors.length, 1);
    assert.ok(ran);
  });

  it("releases the chain after a hung task exceeds maxWaitMs", async () => {
    const timeouts: string[] = [];
    const queue = new TurnQueue({ onTimeout: (k) => timeouts.push(k) });
    queue.enqueue("a", () => new Promise(() => {}), { maxWaitMs: 20 });
    let ran = false;
    await queue.enqueue("a", async () => {
      ran = true;
    });
    assert.ok(ran);
    assert.deepEqual(timeouts, ["a"]);
  });
});
