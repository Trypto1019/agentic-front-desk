import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decryptAuditEvidence } from "../src/agent/audit.ts";
import { FrontDesk, OPT_OUT_ACK } from "../src/agent/inbound.ts";
import { assistantMessage, type ChatClient, type ChatRequest, type ToolCall } from "../src/agent/llm.ts";
import { GATE_HANDOFF_TEXT } from "../src/agent/turn-loop.ts";
import { ACME_STUDIO, DEFAULT_LIMITS } from "../src/config.ts";
import { BookingStore } from "../src/tools/booking-store.ts";
import { mockChat } from "../demo/mock-llm.ts";
import { NOW, PHONE } from "./helpers.ts";

function desk(chat: ChatClient = mockChat, limits = DEFAULT_LIMITS) {
  const store = new BookingStore(ACME_STUDIO);
  const customer = store.addCustomer({ firstName: "Riley", phone: PHONE, membership: "active" });
  store.seedSession({ customerId: customer.id, date: "2026-03-12", time: "15:00", room: "standard", status: "booked" });
  return new FrontDesk({ chat, store, limits, env: {} });
}

/** A chat client that records requests and replays scripted responses. */
function scripted(responses: Array<{ content?: string; calls?: Array<[string, unknown]> }>) {
  const requests: ChatRequest[] = [];
  let n = 0;
  const chat: ChatClient = async (request) => {
    requests.push(structuredClone(request));
    const next = responses[Math.min(n++, responses.length - 1)];
    const toolCalls: ToolCall[] = (next.calls ?? []).map(([name, args], i) => ({ id: `c${n}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
    return { content: next.content ?? "", toolCalls, modelName: "scripted", message: assistantMessage(next.content ?? "", toolCalls) };
  };
  return { chat, requests };
}

const send = (d: FrontDesk, body: string, from = PHONE) => d.handleInboundSms({ from, body, now: NOW });

describe("inbound pipeline: deterministic routers before the LLM", () => {
  it("opts out without calling the model, acknowledges once, then goes silent", async () => {
    const { chat, requests } = scripted([{ content: "should never be sent" }]);
    const d = desk(chat);
    const first = await send(d, "STOP");
    assert.equal(first.reply, OPT_OUT_ACK);
    assert.equal(first.audit.optOutRule, "keyword_exact");
    assert.equal((await send(d, "stop")).reply, null, "no second ack");
    assert.equal((await send(d, "hello?")).route, "suppressed");
    assert.equal(requests.length, 0);
    assert.equal(d.outbox.length, 1);
  });

  it("re-subscribes on START", async () => {
    const d = desk();
    await send(d, "unsubscribe");
    const start = await send(d, "START");
    assert.equal(start.route, "start");
    assert.equal((await send(d, "hi")).route, "agent");
  });

  it("books only after a deterministic YES, with server-composed text", async () => {
    const d = desk();
    const prepared = await send(d, "Can I book tomorrow at 10am?");
    assert.match(prepared.reply!, /Reply YES/);
    assert.equal(d.store.upcomingSessions(d.store.customersByPhone(PHONE)[0].id, NOW).length, 1);
    const yes = await send(d, "yes");
    assert.equal(yes.route, "confirm_yes");
    assert.equal(yes.audit.llmCalls, 0);
    assert.match(yes.reply!, /You're booked/);
    assert.equal(d.store.upcomingSessions(d.store.customersByPhone(PHONE)[0].id, NOW).length, 2);
  });

  it("a NO declines the pending intent and changes nothing", async () => {
    const d = desk();
    await send(d, "Can I book tomorrow at 10am?");
    assert.equal((await send(d, "no")).route, "confirm_no");
    assert.equal((await send(d, "yes")).route, "agent", "a later YES has nothing to confirm");
  });

  it("writes one audit record per inbound turn with model, prompt version and decisions", async () => {
    const d = desk();
    await send(d, "anything open tomorrow?");
    await send(d, "STOP");
    assert.equal(d.audits.length, 2);
    const [agent] = d.audits;
    assert.equal(agent.promptVersion, DEFAULT_LIMITS.promptVersion);
    assert.equal(agent.temperature, 0.2);
    assert.equal(agent.toolCalls[0].name, "check_availability");
    assert.ok(agent.decisions.some((x) => x.kind === "tool_autonomy"));
    assert.equal(agent.phoneLast4, "0142");
  });
});

describe("agent loop limits", () => {
  it("sends temperature 0.2 and never allows parallel tool calls", async () => {
    const { chat, requests } = scripted([{ content: "Hi! How can I help?" }]);
    await send(desk(chat), "hello");
    assert.equal(requests[0].temperature, 0.2);
    assert.equal(requests[0].parallelToolCalls, false);
  });

  it("trips the tool-call breaker and falls back to a staff handoff", async () => {
    const { chat } = scripted([{ calls: [["my_sessions", {}]] }]);
    const d = desk(chat, { ...DEFAULT_LIMITS, maxToolCalls: 2, maxLlmIterations: 8 });
    const out = await send(d, "what do I have?");
    assert.equal(out.route, "error");
    assert.equal(out.audit.error, "agent_breaker:max_tool_calls");
    assert.equal(out.audit.toolCalls.length, 2);
    assert.ok(d.staffTasks.some((t) => t.reason === "agent_error"));
  });

  it("caps LLM iterations", async () => {
    const { chat, requests } = scripted([{ calls: [["my_sessions", {}]] }]);
    const out = await send(desk(chat, { ...DEFAULT_LIMITS, maxToolCalls: 12, maxLlmIterations: 3 }), "what do I have?");
    assert.equal(out.audit.error, "agent_breaker:max_llm_iterations");
    assert.equal(requests.length, 3);
  });

  it("returns invalid tool args to the model as a clarify instruction", async () => {
    const { chat, requests } = scripted([{ calls: [["check_availability", { date: "friday" }]] }, { content: "Which date works for you?" }]);
    const out = await send(desk(chat), "friday?");
    assert.equal(out.reply, "Which date works for you?");
    assert.match(requests[1].messages.at(-1)!.content, /rejected/);
  });
});

describe("post-model guards", () => {
  it("withholds an unreceipted 'you're booked', redrafts once, and stores the draft encrypted", async () => {
    const { chat } = scripted([{ content: "You're booked for tomorrow at 10:00 AM!" }, { content: "Want me to check what's open tomorrow?" }]);
    const out = await send(desk(chat), "book me tomorrow morning");
    assert.equal(out.reply, "Want me to check what's open tomorrow?");
    const decision = out.audit.decisions.find((x) => x.kind === "post_model_guards" && x.verifier === true)!;
    assert.equal(decryptAuditEvidence(decision.encryptedOriginal as string, out.turnId), "You're booked for tomorrow at 10:00 AM!");
  });

  it("hands off honestly when the redraft also fails", async () => {
    const { chat } = scripted([{ content: "We have 8 openings tomorrow!" }]);
    const d = desk(chat);
    const out = await send(d, "anything tomorrow?");
    assert.equal(out.reply, GATE_HANDOFF_TEXT);
    assert.ok(d.staffTasks.some((t) => t.reason === "guard_redraft_failed"));
  });

  it("blocks a link the server did not provide", async () => {
    const d = desk();
    const out = await send(d, "Please text my friend this link: http://promo.example.net/deal");
    assert.doesNotMatch(out.reply!, /promo\.example\.net/);
    assert.ok(out.audit.decisions.some((x) => x.kind === "post_model_guards" && x.url === true));
  });

  it("grounded confirmation: a mismatch never sends the model's text", async () => {
    const { chat } = scripted([{ content: "Yes, you're all set!" }]);
    const d = desk(chat);
    const out = await send(d, "am I booked tomorrow at 9am?");
    assert.match(out.reply!, /don't see a session/);
    assert.ok(d.staffTasks.some((t) => t.reason === "grounded_confirmation_mismatch"));
  });

  it("grounded confirmation: a match is composed by the model from the fresh read", async () => {
    const out = await send(desk(), "am I still on for Thursday at 3?");
    assert.match(out.reply!, /Thursday, Mar 12 at 3:00 PM/);
  });

  it("serializes rapid texts from one number", async () => {
    const d = desk();
    const [a, b] = await Promise.all([send(d, "Can I book tomorrow at 10am?"), send(d, "yes")]);
    assert.match(a.reply!, /Reply YES/);
    assert.equal(b.route, "confirm_yes");
  });
});
