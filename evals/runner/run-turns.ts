import { readFileSync, writeFileSync } from "node:fs";

import { FrontDesk } from "../../src/agent/inbound.ts";
import type { ChatClient } from "../../src/agent/llm.ts";
import { ACME_STUDIO, DEFAULT_LIMITS } from "../../src/config.ts";
import type { PendingIntentType } from "../../src/state/pending-intent.ts";
import { BookingStore } from "../../src/tools/booking-store.ts";
import { mockChat } from "../../demo/mock-llm.ts";
import { openRouterChat } from "../../demo/openrouter.ts";

/**
 * Eval runner contract: read golden records (JSONL), run each one through the
 * SAME inbound pipeline production uses (routers -> agent loop -> guards),
 * against a freshly seeded in-memory store with the clock pinned to the
 * record's `now`. Write one result per record (JSONL).
 *
 * Nothing leaves the process unless AGENT_EVAL_MODEL=openrouter and a key is
 * set; the default is the offline mock model.
 *
 *   tsx evals/runner/run-turns.ts <records.jsonl> <out.jsonl>
 */

type Session = { id?: string; date: string; startTime: string; room: string; status: "booked" | "cancelled" | "completed" };
type GoldenRecord = {
  id: string;
  now: string;
  history: Array<{ role: "user" | "assistant"; text: string; at: string }>;
  inbound: string;
  customer: {
    phone: string;
    suppressed?: boolean;
    people: Array<{ firstName: string; membership?: "active" | "none"; sessions?: Session[] }>;
    pendingIntents?: Array<{ person?: number; intentType: PendingIntentType; payload: Record<string, unknown> }>;
  };
  schedule?: { blocked?: Array<{ date: string; time: string; room: string }> };
};

function chatClient(): { chat: ChatClient; label: string } {
  if (process.env.AGENT_EVAL_MODEL === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return { chat: openRouterChat(process.env.OPENROUTER_API_KEY), label: "openrouter" };
  }
  return { chat: mockChat, label: "mock" };
}

async function runRecord(record: GoldenRecord, chat: ChatClient) {
  const now = new Date(record.now);
  const store = new BookingStore(ACME_STUDIO);
  const people = record.customer.people.map((p) => {
    const c = store.addCustomer({ firstName: p.firstName, phone: record.customer.phone, membership: p.membership ?? "none" });
    for (const s of p.sessions ?? []) store.seedSession({ id: s.id, customerId: c.id, date: s.date, time: s.startTime, room: s.room, status: s.status });
    return c;
  });
  for (const b of record.schedule?.blocked ?? []) store.block(b.date, b.time, b.room);

  const desk = new FrontDesk({ chat, store, limits: DEFAULT_LIMITS, env: {} });
  if (record.customer.suppressed) desk.suppression.suppress(record.customer.phone, "sms", "seeded", now);
  desk.seedHistory(record.customer.phone, record.history);
  for (const pi of record.customer.pendingIntents ?? []) {
    desk.intents.create({ customerId: people[pi.person ?? 0].id, intentType: pi.intentType, payload: pi.payload, now: new Date(now.getTime() - 60_000) });
  }
  const intentsBefore = new Set(desk.intents.all().map((i) => i.id));
  const suppressedBefore = desk.suppression.isSuppressed(record.customer.phone, "sms");

  const outcome = await desk.handleInboundSms({ from: record.customer.phone, body: record.inbound, now });
  const audit = outcome.audit;
  const toolResults = audit.toolResults;
  return {
    id: record.id,
    ok: true,
    error: null,
    route: outcome.route,
    finalText: outcome.reply,
    replies: desk.outbox.map((m) => ({ body: m.body, success: m.success })),
    toolCalls: audit.toolCalls.map((call, i) => {
      const r = toolResults.filter((t) => t.toolName !== "grounded_confirmation_check" && t.toolName !== "execute_pending_intent")[i] ?? {};
      const inner = (r.result as { status?: string } | undefined)?.status ?? null;
      return { tool: call.name, args: call.arguments, outcome: r.status ?? null, status: inner, result: r.result ?? null };
    }),
    effects: {
      suppressed: !suppressedBefore && desk.suppression.isSuppressed(record.customer.phone, "sms"),
      staffTasks: desk.staffTasks.map((t) => ({ title: t.reason, summary: t.summary })),
      pendingIntentsCreated: desk.intents.all().filter((i) => !intentsBefore.has(i.id)).map((i) => i.intentType),
      receipts: toolResults.filter((t) => t.toolName === "execute_pending_intent").map((t) => (t.receipt as { action: string }).action),
    },
    llm: { calls: audit.llmCalls, costUsd: 0 },
    guards: audit.decisions.filter((d) => d.kind === "post_model_guards" || d.kind === "guard").map(({ encryptedOriginal: _drop, ...rest }) => rest),
    turn: [{ route: audit.route, error: audit.error, model: audit.model, promptVersion: audit.promptVersion }],
  };
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: run-turns.ts <records.jsonl> <out.jsonl>");
  process.exit(2);
}
const { chat, label } = chatClient();
const records = readFileSync(input, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as GoldenRecord);
const lines: string[] = [];
for (const record of records) {
  try {
    lines.push(JSON.stringify({ ...(await runRecord(record, chat)), model: label }));
  } catch (error) {
    lines.push(JSON.stringify({ id: record.id, ok: false, error: error instanceof Error ? error.message : String(error), model: label }));
  }
}
writeFileSync(output, lines.join("\n") + "\n");
