import { randomUUID } from "node:crypto";

import { ACME_STUDIO, limitsFromEnv, type AgentLimits, type StudioConfig } from "../config.ts";
import { SuppressionRegistry } from "../compliance/consent.ts";
import { isSmsStartMessage, smsOptOutRule } from "../compliance/optout-policy.ts";
import { normalizePhone } from "../lib/text.ts";
import { classifyConfirmationReply, PendingIntentStore } from "../state/pending-intent.ts";
import { TurnQueue } from "../state/turn-queue.ts";
import { BookingStore } from "../tools/booking-store.ts";
import { createFrontDeskRegistry, executePendingIntent } from "../tools/booking-tools.ts";
import type { Settings, StaffTask, ToolRegistry, ToolServices } from "../tools/registry.ts";
import { newTurnAudit, type TurnAudit } from "./audit.ts";
import { basePersona, composeSystemPrompt, type IdentityState } from "./compose-system-prompt.ts";
import type { ChatClient } from "./llm.ts";
import { BreakerError, runAgentTurn } from "./turn-loop.ts";

/**
 * Inbound SMS pipeline. Deterministic routers run BEFORE the LLM, in order:
 *
 *   1. opt-out (STOP / natural-language revocation) → suppress, one ack, done
 *   2. START → resubscribe
 *   3. suppressed number → no reply at all
 *   4. YES / NO to an open pending intent → execute or decline, server text
 *   5. only then: the agent turn (serialized per phone by the turn queue)
 *
 * Suppression is re-checked immediately before every send.
 */

export const OPT_OUT_ACK = "You're unsubscribed from Acme Wellness Studio texts and won't receive more. Reply START to resubscribe.";
export const START_ACK = "You're resubscribed to Acme Wellness Studio texts. Reply STOP anytime to opt out.";
export const DECLINE_ACK = "No problem, nothing was changed.";
export const ERROR_FALLBACK = "Thanks for your message. A team member will follow up.";

export type SentMessage = { to: string; body: string; success: boolean; at: string };
export type Turn = { role: "user" | "assistant"; text: string; at: string };

export type FrontDeskDeps = {
  config?: StudioConfig;
  limits?: AgentLimits;
  chat: ChatClient;
  store?: BookingStore;
  env?: NodeJS.ProcessEnv;
};

export type TurnOutcome = { turnId: string; route: TurnAudit["route"]; reply: string | null; audit: TurnAudit };

export class FrontDesk {
  readonly config: StudioConfig;
  readonly limits: AgentLimits;
  readonly store: BookingStore;
  readonly intents = new PendingIntentStore();
  readonly suppression = new SuppressionRegistry();
  readonly settings: Settings = new Map();
  readonly staffTasks: StaffTask[] = [];
  readonly outbox: SentMessage[] = [];
  readonly audits: TurnAudit[] = [];
  readonly registry: ToolRegistry = createFrontDeskRegistry();
  private readonly history = new Map<string, Turn[]>();
  private readonly queue = new TurnQueue();
  private readonly chat: ChatClient;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: FrontDeskDeps) {
    this.config = deps.config ?? ACME_STUDIO;
    this.limits = deps.limits ?? limitsFromEnv(deps.env);
    this.store = deps.store ?? new BookingStore(this.config);
    this.chat = deps.chat;
    this.env = deps.env ?? process.env;
  }

  get services(): ToolServices {
    return { store: this.store, intents: this.intents, settings: this.settings, staffTasks: this.staffTasks };
  }

  conversation(phone: string): Turn[] {
    return [...(this.history.get(normalizePhone(phone)) ?? [])];
  }

  /** Seed earlier turns of a thread (eval harness and replays). */
  seedHistory(phone: string, turns: Turn[]): void {
    for (const turn of turns) this.remember(normalizePhone(phone), turn);
  }

  /** Entry point for the webhook (after signature verification). Serialized per phone. */
  async handleInboundSms(input: { from: string; body: string; now?: Date }): Promise<TurnOutcome> {
    const phone = normalizePhone(input.from);
    let outcome: TurnOutcome | undefined;
    await this.queue.enqueue(phone, async () => {
      outcome = await this.processInboundSms(phone, input.body, input.now ?? new Date());
    });
    if (!outcome) throw new Error("turn did not complete");
    return outcome;
  }

  private send(phone: string, body: string, now: Date): SentMessage {
    // Suppression is checked before EVERY send, not just at the start of the turn.
    const allowed = !this.suppression.isSuppressed(phone, "sms") || body === OPT_OUT_ACK;
    const sent = { to: phone, body, success: allowed, at: now.toISOString() };
    this.outbox.push(sent);
    return sent;
  }

  private remember(phone: string, turn: Turn): void {
    const list = this.history.get(phone) ?? [];
    list.push(turn);
    this.history.set(phone, list.slice(-40));
  }

  private resolveIdentity(phone: string, text: string): { customerId: string | null; identity: IdentityState } {
    const matches = this.store.customersByPhone(phone);
    if (matches.length === 0) return { customerId: null, identity: { state: "NO_MATCH" } };
    if (matches.length === 1) {
      const c = matches[0];
      return { customerId: c.id, identity: { state: "SINGLE_RESOLVED", firstName: c.firstName, membership: c.membership } };
    }
    // Shared household phone: resolve only on an exact first-name mention in this thread.
    const said = [text, ...this.conversation(phone).filter((t) => t.role === "user").map((t) => t.text)].join(" ").toLowerCase();
    const named = matches.filter((c) => new RegExp(`\\b${c.firstName.toLowerCase()}\\b`).test(said));
    if (named.length === 1) {
      const c = named[0];
      return { customerId: c.id, identity: { state: "SINGLE_RESOLVED", firstName: c.firstName, membership: c.membership } };
    }
    return { customerId: null, identity: { state: "MULTI_MATCH", candidateCount: matches.length } };
  }

  private async processInboundSms(phone: string, text: string, now: Date): Promise<TurnOutcome> {
    const started = Date.now();
    const turnId = randomUUID();
    const audit = newTurnAudit(turnId, phone, text, now);
    const finish = (route: TurnAudit["route"], reply: string | null): TurnOutcome => {
      audit.route = route;
      audit.reply = reply;
      audit.durationMs = Date.now() - started;
      this.audits.push(audit);
      if (reply) {
        const sent = this.send(phone, reply, now);
        if (sent.success) this.remember(phone, { role: "assistant", text: reply, at: now.toISOString() });
        else audit.decisions.push({ kind: "send_blocked", reason: "suppressed_before_send" });
      }
      return { turnId, route, reply, audit };
    };

    // 1. Opt-out: deterministic, before identity, before the model.
    const optOut = smsOptOutRule(text);
    if (optOut) {
      audit.optOutRule = optOut;
      const { created } = this.suppression.suppress(phone, "sms", optOut, now);
      for (const c of this.store.customersByPhone(phone)) {
        for (const intent of this.intents.openFor(c.id, now)) this.intents.transition(intent.id, "DECLINED", now);
      }
      audit.decisions.push({ kind: "opt_out", rule: optOut, newlySuppressed: created });
      // One acknowledgment, only when the suppression is new.
      return finish("opt_out", created ? OPT_OUT_ACK : null);
    }

    // 2. START re-subscribes SMS.
    if (isSmsStartMessage(text)) {
      const changed = this.suppression.resubscribeSms(phone);
      return finish("start", changed ? START_ACK : null);
    }

    // 3. Suppressed numbers get nothing.
    if (this.suppression.isSuppressed(phone, "sms")) return finish("suppressed", null);

    this.remember(phone, { role: "user", text, at: now.toISOString() });
    const { customerId, identity } = this.resolveIdentity(phone, text);
    audit.customerId = customerId;
    audit.identityState = identity.state;

    // 4. YES/NO router for an open pending intent.
    if (customerId) {
      const open = this.intents.latestOpen(customerId, now);
      const reply = open ? classifyConfirmationReply(text) : null;
      if (open && reply === "yes") {
        const execution = executePendingIntent(open, this.services, now);
        this.intents.transition(open.id, execution.ok ? "RESOLVED" : "FAILED", now);
        audit.decisions.push({ kind: "pending_intent", intentId: open.id, intentType: open.intentType, outcome: execution.ok ? "executed" : execution.reason });
        if (execution.ok) audit.toolResults.push({ toolName: "execute_pending_intent", status: "executed", receipt: execution.receipt });
        if (!execution.ok && execution.reason !== "slot_unavailable") {
          this.staffTasks.push({ id: randomUUID(), reason: `intent_${execution.reason}`, summary: `Confirmed ${open.intentType} could not execute.`, phone, createdAt: now.toISOString() });
        }
        return finish("confirm_yes", execution.text);
      }
      if (open && reply === "no") {
        this.intents.transition(open.id, "DECLINED", now);
        audit.decisions.push({ kind: "pending_intent", intentId: open.id, outcome: "declined" });
        return finish("confirm_no", DECLINE_ACK);
      }
    }

    // 5. The agent.
    try {
      const systemPrompt = composeSystemPrompt(basePersona(this.config, identity, now), this.env);
      const history = this.conversation(phone).slice(0, -1).map((t) => ({ role: t.role, text: t.text }));
      const result = await runAgentTurn({
        turnId,
        phone,
        customerId,
        inboundText: text,
        history,
        systemPrompt,
        now,
        config: this.config,
        limits: this.limits,
        chat: this.chat,
        registry: this.registry,
        services: this.services,
        audit,
      });
      return finish("agent", result.text);
    } catch (error) {
      audit.error = error instanceof Error ? error.message : String(error);
      audit.decisions.push({ kind: error instanceof BreakerError ? "breaker" : "agent_error", error: audit.error });
      this.staffTasks.push({ id: randomUUID(), reason: "agent_error", summary: audit.error, phone, createdAt: now.toISOString() });
      return finish("error", ERROR_FALLBACK);
    }
  }
}
