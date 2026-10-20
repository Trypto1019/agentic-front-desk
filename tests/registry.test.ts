import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { createFrontDeskRegistry, executePendingIntent } from "../src/tools/booking-tools.ts";
import { defineTool, GLOBAL_KILL_SWITCH, ToolRegistry, toolKillSwitch } from "../src/tools/registry.ts";
import { makeCtx, makeServices, NOW } from "./helpers.ts";

describe("tool registry", () => {
  const registry = createFrontDeskRegistry();

  it("exports JSON schemas from the zod source of truth", () => {
    const spec = registry.specs().find((s) => s.function.name === "request_booking")!;
    const params = spec.function.parameters as { properties: Record<string, unknown>; required: string[] };
    assert.ok(params.properties.date && params.properties.time);
    assert.ok(params.required.includes("date"));
  });

  it("rejects invalid args with a clarify instruction and audits the decision", async () => {
    const s = makeServices();
    const ctx = makeCtx(s, s.customerId);
    const run = await registry.run("check_availability", { date: "next friday" }, ctx);
    assert.equal(run.status, "rejected");
    assert.equal(ctx.decisions[0].reason, "invalid_args");
  });

  it("honors the global and per-tool kill switches", async () => {
    const s = makeServices();
    s.settings.set(toolKillSwitch("check_availability"), false);
    assert.equal((await registry.run("check_availability", { date: "2026-03-11" }, makeCtx(s, s.customerId))).status, "escalated");
    s.settings.delete(toolKillSwitch("check_availability"));
    s.settings.set(GLOBAL_KILL_SWITCH, false);
    assert.equal((await registry.run("my_sessions", {}, makeCtx(s, s.customerId))).status, "escalated");
  });

  it("never executes escalate-only tools", async () => {
    const s = makeServices();
    const run = await registry.run("membership_change", { request: "pause my membership" }, makeCtx(s, s.customerId));
    assert.equal(run.status, "escalated");
  });

  it("prepares a booking instead of writing it, and the server owns the YES prompt", async () => {
    const s = makeServices();
    const run = await registry.run("request_booking", { date: "2026-03-11", time: "10:00" }, makeCtx(s, s.customerId));
    assert.equal(run.status, "confirmation_needed");
    assert.match((run as { message: string }).message, /Reply YES/);
    assert.equal(s.store.upcomingSessions(s.customerId, NOW).length, 1, "nothing booked yet");
    const intent = s.intents.latestOpen(s.customerId, NOW)!;
    const executed = executePendingIntent(intent, s, NOW);
    assert.ok(executed.ok);
    assert.equal(s.store.upcomingSessions(s.customerId, NOW).length, 2);
  });

  it("re-reads live state at execution: a slot taken meanwhile is not double-booked", async () => {
    const s = makeServices();
    await registry.run("request_booking", { date: "2026-03-11", time: "10:00" }, makeCtx(s, s.customerId));
    const intent = s.intents.latestOpen(s.customerId, NOW)!;
    s.store.block("2026-03-11", "10:00", "standard");
    const executed = executePendingIntent(intent, s, NOW);
    assert.equal(executed.ok, false);
    assert.match(executed.text, /nothing was changed/);
  });

  it("dry-run mode prepares nothing", async () => {
    const s = makeServices();
    const run = await registry.run("request_booking", { date: "2026-03-11", time: "10:00" }, makeCtx(s, s.customerId, { dryRun: true }));
    assert.equal(run.status, "executed");
    assert.equal(s.intents.all().length, 0);
  });

  it("guards the staff follow-up to once per conversation per day", async () => {
    const s = makeServices();
    const args = { reason: "pricing", summary: "Customer asked about pricing; please follow up." };
    assert.equal((await registry.run("request_staff_followup", args, makeCtx(s, s.customerId))).status, "executed");
    assert.equal((await registry.run("request_staff_followup", args, makeCtx(s, s.customerId))).status, "deferred");
    assert.equal(s.staffTasks.length, 1);
  });

  it("escalates a write tool that has no guard", async () => {
    const unguarded = defineTool({ name: "danger", description: "x", schema: z.object({}), autonomyLevel: "auto_write_guarded", execute: () => "wrote" });
    const s = makeServices();
    const run = await new ToolRegistry([unguarded]).run("danger", {}, makeCtx(s, s.customerId));
    assert.equal(run.status, "escalated");
    assert.equal((run as { reason: string }).reason, "missing_guard");
  });

  it("asks which session rather than guessing between several", async () => {
    const s = makeServices();
    s.store.seedSession({ customerId: s.customerId, date: "2026-03-13", time: "09:00", room: "suite", status: "booked" });
    const run = await registry.run("request_cancel", {}, makeCtx(s, s.customerId));
    assert.equal(run.status, "executed");
    assert.equal((run as { result: { status: string } }).result.status, "needs_disambiguation");
    assert.equal(s.intents.all().length, 0);
  });

  it("refuses changes inside the change window", async () => {
    const s = makeServices();
    s.store.seedSession({ customerId: "other", date: "2026-03-10", time: "17:00", room: "suite", status: "booked" });
    const soon = s.store.seedSession({ customerId: s.customerId, date: "2026-03-10", time: "18:00", room: "standard", status: "booked" });
    const run = await registry.run("request_cancel", { session_id: soon.id }, makeCtx(s, s.customerId));
    assert.equal((run as { result: { status: string } }).result.status, "outside_change_window");
  });
});
