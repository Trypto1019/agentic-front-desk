import { randomUUID } from "node:crypto";

import { classifierText } from "../lib/text.ts";

/**
 * Two-phase "Reply YES to confirm" state machine.
 *
 * The model can only PREPARE a mutation. Preparing writes a PendingIntent and
 * the server (not the model) sends the confirmation prompt. The mutation
 * executes only when a later inbound is a deterministic YES, routed before
 * the LLM ever runs. A new prepare supersedes any older open intent, so a
 * stale YES can never execute something the customer has since changed.
 *
 *   NEEDS_CONFIRMATION ──YES──▶ RESOLVED
 *          │  └──────NO──────▶ DECLINED
 *          ├────ttl elapsed──▶ EXPIRED
 *          ├──newer prepare──▶ SUPERSEDED
 *          └──execute threw──▶ FAILED
 */

export type PendingIntentType = "BOOK_SESSION" | "CANCEL_SESSION" | "RESCHEDULE_SESSION";
export type PendingIntentStatus = "NEEDS_CONFIRMATION" | "RESOLVED" | "DECLINED" | "EXPIRED" | "SUPERSEDED" | "FAILED";

export type PendingIntent = {
  id: string;
  customerId: string;
  intentType: PendingIntentType;
  payload: Record<string, unknown>;
  status: PendingIntentStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  sourceTurnId: string | null;
};

const TRANSITIONS: Record<PendingIntentStatus, readonly PendingIntentStatus[]> = {
  NEEDS_CONFIRMATION: ["RESOLVED", "DECLINED", "EXPIRED", "SUPERSEDED", "FAILED"],
  RESOLVED: [],
  DECLINED: [],
  EXPIRED: [],
  SUPERSEDED: [],
  FAILED: [],
};

export const DEFAULT_INTENT_TTL_MS = 30 * 60_000;

export class InvalidTransitionError extends Error {
  constructor(from: PendingIntentStatus, to: PendingIntentStatus) {
    super(`pending_intent_invalid_transition:${from}->${to}`);
  }
}

export class PendingIntentStore {
  private intents = new Map<string, PendingIntent>();

  create(args: {
    customerId: string;
    intentType: PendingIntentType;
    payload: Record<string, unknown>;
    now: Date;
    ttlMs?: number;
    sourceTurnId?: string | null;
  }): PendingIntent {
    for (const open of this.openFor(args.customerId, args.now)) this.transition(open.id, "SUPERSEDED", args.now);
    const intent: PendingIntent = {
      id: randomUUID(),
      customerId: args.customerId,
      intentType: args.intentType,
      payload: structuredClone(args.payload),
      status: "NEEDS_CONFIRMATION",
      createdAt: args.now.toISOString(),
      expiresAt: new Date(args.now.getTime() + (args.ttlMs ?? DEFAULT_INTENT_TTL_MS)).toISOString(),
      resolvedAt: null,
      sourceTurnId: args.sourceTurnId ?? null,
    };
    this.intents.set(intent.id, intent);
    return structuredClone(intent);
  }

  /** Open intents for a customer. Expiry is applied lazily on read. */
  openFor(customerId: string, now: Date): PendingIntent[] {
    const open: PendingIntent[] = [];
    for (const intent of this.intents.values()) {
      if (intent.customerId !== customerId || intent.status !== "NEEDS_CONFIRMATION") continue;
      if (Date.parse(intent.expiresAt) <= now.getTime()) {
        this.transition(intent.id, "EXPIRED", now);
        continue;
      }
      open.push(structuredClone(intent));
    }
    return open;
  }

  latestOpen(customerId: string, now: Date): PendingIntent | null {
    return this.openFor(customerId, now).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  transition(id: string, to: PendingIntentStatus, now: Date): PendingIntent {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`pending_intent_not_found:${id}`);
    if (!TRANSITIONS[intent.status].includes(to)) throw new InvalidTransitionError(intent.status, to);
    intent.status = to;
    intent.resolvedAt = now.toISOString();
    return structuredClone(intent);
  }

  get(id: string): PendingIntent | null {
    const intent = this.intents.get(id);
    return intent ? structuredClone(intent) : null;
  }

  all(): PendingIntent[] {
    return [...this.intents.values()].map((i) => structuredClone(i));
  }
}

/**
 * Deterministic reply classifier for the YES router. A bare assent confirms;
 * any negation or hedge vetoes ("yes but can we do 4 instead" is NOT a yes).
 * Anything else returns null and goes to the agent.
 */
export function classifyConfirmationReply(raw: string): "yes" | "no" | null {
  const text = classifierText(raw);
  if (!text) return null;
  if (/^(?:no|nope|nah|no thanks|no thank you|don't|do not|never mind|nevermind|cancel that)$/.test(text)) return "no";
  if (/\b(?:no|not|don't|dont|wait|instead|but|actually|change)\b/.test(text)) return null;
  return /^(?:y|yes|yes please|yes confirm|yep|yeah|yup|confirm|confirmed|ok yes|yes thanks|yes thank you|sounds good yes|do it|go ahead)$/.test(text)
    ? "yes"
    : null;
}
