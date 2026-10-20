import { randomUUID } from "node:crypto";
import { z } from "zod";

import { addDays, isIsoDate, localDate, spokenDate, spokenTime } from "../lib/time.ts";
import type { PendingIntent } from "../state/pending-intent.ts";
import { BookingError, CHANGE_WINDOW_HOURS, type Receipt, type Session } from "./booking-store.ts";
import { defineTool, ToolRegistry, type AgentTool, type ToolContext, type ToolServices } from "./registry.ts";

/**
 * The front desk's tools. Reads execute directly. Every booking mutation is
 * PREPARE-ONLY: the tool validates against live state, writes a pending
 * intent, and returns the exact "Reply YES" sentence the server will send.
 * The mutation itself happens in `executePendingIntent`, reached only from
 * the deterministic YES router.
 */

const LOOKAHEAD_DAYS = 14;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour");

function sessionLabel(s: Pick<Session, "date" | "time" | "room">): string {
  return `${s.room} session on ${spokenDate(s.date)} at ${spokenTime(s.time)}`;
}

function dateProblem(date: string, ctx: ToolContext): string | null {
  if (!isIsoDate(date)) return "That is not a real calendar date.";
  const today = localDate(ctx.now, ctx.services.store.config.timeZone);
  if (date < today) return "That date has already passed.";
  if (date > addDays(today, LOOKAHEAD_DAYS)) return `Bookings open ${LOOKAHEAD_DAYS} days ahead.`;
  return null;
}

/** Resolve which upcoming session a cancel/move refers to. Never guesses between several. */
function resolveTarget(sessionId: string | undefined, ctx: ToolContext): { session: Session } | { status: string; message: string; candidates?: unknown[] } {
  if (!ctx.customerId) return { status: "needs_identity", message: "I need to confirm who I'm texting with before changing a booking." };
  const upcoming = ctx.services.store.upcomingSessions(ctx.customerId, ctx.now);
  if (sessionId) {
    const match = upcoming.find((s) => s.id === sessionId);
    return match ? { session: match } : { status: "session_not_found", message: "I couldn't find that upcoming session." };
  }
  if (upcoming.length === 0) return { status: "no_upcoming_session", message: "There are no upcoming sessions on this account." };
  if (upcoming.length > 1) {
    return {
      status: "needs_disambiguation",
      message: "There is more than one upcoming session. Ask which one.",
      candidates: upcoming.map((s) => ({ session_id: s.id, date: s.date, time: s.time, room: s.room, label: sessionLabel(s) })),
    };
  }
  return { session: upcoming[0] };
}

export const checkAvailability = defineTool({
  name: "check_availability",
  description: "Read real open start times for one studio-local date (YYYY-MM-DD) and room type.",
  schema: z.object({ date: isoDate, room: z.enum(["standard", "suite"]).default("standard") }),
  autonomyLevel: "auto_read",
  execute: (args, ctx) => {
    const problem = dateProblem(args.date, ctx);
    if (problem) return { status: "invalid_date", message: problem };
    const openTimes = ctx.services.store.openTimes(args.date, args.room, ctx.now);
    return {
      status: openTimes.length ? "ok" : "none_open",
      date: args.date,
      room: args.room,
      dayLabel: spokenDate(args.date),
      openTimes,
      spokenTimes: openTimes.map(spokenTime),
    };
  },
});

export const mySessions = defineTool({
  name: "my_sessions",
  description: "Read the resolved customer's upcoming booked sessions.",
  schema: z.object({}),
  autonomyLevel: "auto_read",
  execute: (_args, ctx) => {
    if (!ctx.customerId) return { status: "needs_identity", sessions: [] };
    const sessions = ctx.services.store.upcomingSessions(ctx.customerId, ctx.now);
    return { status: "ok", sessions: sessions.map((s) => ({ session_id: s.id, date: s.date, time: s.time, room: s.room, label: sessionLabel(s) })) };
  },
});

export const requestBooking = defineTool({
  name: "request_booking",
  description: "Prepare a booking for a specific date, start time and room. The customer must reply YES before it is booked.",
  schema: z.object({ date: isoDate, time: clock, room: z.enum(["standard", "suite"]).default("standard") }),
  autonomyLevel: "confirm_required",
  prepareOnly: true,
  execute: (args, ctx) => {
    if (!ctx.customerId) return { status: "needs_identity", message: "Ask for their first name so the team can set up the booking." };
    const problem = dateProblem(args.date, ctx);
    if (problem) return { status: "invalid_date", message: problem };
    if (!ctx.services.store.isOpen(args.date, args.time, args.room, ctx.now)) {
      return { status: "slot_unavailable", date: args.date, room: args.room, openTimes: ctx.services.store.openTimes(args.date, args.room, ctx.now) };
    }
    const label = sessionLabel(args);
    if (ctx.dryRun) return { status: "ready_to_prepare", label };
    const intent = ctx.services.intents.create({ customerId: ctx.customerId, intentType: "BOOK_SESSION", payload: { ...args }, now: ctx.now, sourceTurnId: ctx.turnId });
    return { status: "prepared", pendingIntentId: intent.id, message: `To confirm: a ${label}. Reply YES to book it.` };
  },
});

export const requestCancel = defineTool({
  name: "request_cancel",
  description: "Prepare cancelling an upcoming session. Omit session_id when the customer has exactly one. The customer must reply YES.",
  schema: z.object({ session_id: z.string().optional() }),
  autonomyLevel: "confirm_required",
  prepareOnly: true,
  execute: (args, ctx) => {
    const target = resolveTarget(args.session_id, ctx);
    if (!("session" in target)) return target;
    const { session } = target;
    if (ctx.services.store.hoursUntil(session, ctx.now) < CHANGE_WINDOW_HOURS) {
      return { status: "outside_change_window", message: `Sessions can be changed up to ${CHANGE_WINDOW_HOURS} hours ahead; staff must handle this one.` };
    }
    if (ctx.dryRun) return { status: "ready_to_prepare", label: sessionLabel(session) };
    const intent = ctx.services.intents.create({ customerId: session.customerId, intentType: "CANCEL_SESSION", payload: { session_id: session.id }, now: ctx.now, sourceTurnId: ctx.turnId });
    return { status: "prepared", pendingIntentId: intent.id, message: `To confirm: cancel your ${sessionLabel(session)}? Reply YES to cancel it.` };
  },
});

export const requestReschedule = defineTool({
  name: "request_reschedule",
  description: "Prepare moving an upcoming session to a new date and start time (an in-place move, not cancel + rebook). The customer must reply YES.",
  schema: z.object({ session_id: z.string().optional(), new_date: isoDate, new_time: clock }),
  autonomyLevel: "confirm_required",
  prepareOnly: true,
  execute: (args, ctx) => {
    const target = resolveTarget(args.session_id, ctx);
    if (!("session" in target)) return target;
    const { session } = target;
    if (ctx.services.store.hoursUntil(session, ctx.now) < CHANGE_WINDOW_HOURS) {
      return { status: "outside_change_window", message: `Sessions can be changed up to ${CHANGE_WINDOW_HOURS} hours ahead; staff must handle this one.` };
    }
    const problem = dateProblem(args.new_date, ctx);
    if (problem) return { status: "invalid_date", message: problem };
    if (!ctx.services.store.isOpen(args.new_date, args.new_time, session.room, ctx.now)) {
      return { status: "slot_unavailable", date: args.new_date, room: session.room, openTimes: ctx.services.store.openTimes(args.new_date, session.room, ctx.now) };
    }
    const to = { date: args.new_date, time: args.new_time, room: session.room };
    if (ctx.dryRun) return { status: "ready_to_prepare", from: sessionLabel(session), to: sessionLabel(to) };
    const intent = ctx.services.intents.create({
      customerId: session.customerId,
      intentType: "RESCHEDULE_SESSION",
      payload: { session_id: session.id, new_date: args.new_date, new_time: args.new_time },
      now: ctx.now,
      sourceTurnId: ctx.turnId,
    });
    return {
      status: "prepared",
      pendingIntentId: intent.id,
      message: `To confirm: move your ${sessionLabel(session)} to ${spokenDate(to.date)} at ${spokenTime(to.time)}? Reply YES to move it.`,
    };
  },
});

export const requestStaffFollowup = defineTool({
  name: "request_staff_followup",
  description:
    "Hand the conversation to a human: creates a staff task. Use for pricing, billing, membership changes, complaints, or when the person asks for a human. Write a one- or two-sentence directive for staff.",
  schema: z.object({
    reason: z.enum(["asked_for_human", "pricing", "billing", "membership", "complaint", "other"]),
    summary: z.string().min(10).max(400),
  }),
  autonomyLevel: "auto_write_guarded",
  guard: (_args, ctx) => {
    // Once per conversation per day: repeated handoffs spam the team and
    // tell the customer nothing new.
    const dayAgo = ctx.now.getTime() - 86_400_000;
    const recent = ctx.services.staffTasks.some((t) => t.phone === ctx.phone && Date.parse(t.createdAt) > dayAgo);
    return recent
      ? { allowed: false, action: "defer", reason: "followup_already_open", message: "The team already has an open follow-up for this person. Say so; do not create another." }
      : { allowed: true, reason: "first_followup" };
  },
  execute: (args, ctx) => {
    if (ctx.dryRun) return { status: "followup_ready" };
    const task = { id: randomUUID(), reason: args.reason, summary: args.summary, phone: ctx.phone, createdAt: ctx.now.toISOString() };
    ctx.services.staffTasks.push(task);
    return { status: "followup_requested", taskId: task.id };
  },
});

export const membershipChange = defineTool({
  name: "membership_change",
  description: "Membership upgrades, pauses, freezes and cancellations. Always handled by staff.",
  schema: z.object({ request: z.string().min(3).max(200) }),
  autonomyLevel: "escalate",
  execute: () => {
    throw new Error("unreachable: escalate-only tool");
  },
});

export const FRONT_DESK_TOOLS: readonly AgentTool[] = [
  checkAvailability,
  mySessions,
  requestBooking,
  requestCancel,
  requestReschedule,
  requestStaffFollowup,
  membershipChange,
];

export function createFrontDeskRegistry(): ToolRegistry {
  return new ToolRegistry(FRONT_DESK_TOOLS);
}

/** Tools that change a session. Their result owns the consequential sentence. */
export const SESSION_CHANGING_TOOLS = new Set(["request_booking", "request_cancel", "request_reschedule"]);

export type IntentExecution = { ok: true; text: string; receipt: Receipt } | { ok: false; text: string; reason: string };

/**
 * Execute a confirmed intent. Live state is re-read here: the slot may have
 * been taken since the prompt went out. The reply is composed from the
 * receipt, never from model text.
 */
export function executePendingIntent(intent: PendingIntent, services: ToolServices, now: Date): IntentExecution {
  const { store } = services;
  const p = intent.payload as Record<string, string>;
  try {
    let receipt: Receipt;
    switch (intent.intentType) {
      case "BOOK_SESSION":
        receipt = store.book(intent.customerId, p.date, p.time, p.room, now);
        return { ok: true, receipt, text: `You're booked: ${sessionLabel(receipt)}. See you then!` };
      case "CANCEL_SESSION":
        receipt = store.cancel(p.session_id, now);
        return { ok: true, receipt, text: `Done. Your ${sessionLabel(receipt)} is cancelled.` };
      case "RESCHEDULE_SESSION":
        receipt = store.reschedule(p.session_id, p.new_date, p.new_time, now);
        return { ok: true, receipt, text: `Done. Your session is moved to ${spokenDate(receipt.date)} at ${spokenTime(receipt.time)}.` };
    }
  } catch (error) {
    const code = error instanceof BookingError ? error.code : "execution_failed";
    const text =
      code === "slot_unavailable"
        ? "Sorry, that time was just taken, so nothing was changed. Want me to check other times?"
        : code === "outside_change_window"
          ? "That session is too close to its start time for me to change, so nothing was changed. I've asked the team to help."
          : "I couldn't complete that, so nothing was changed. I've asked the team to follow up.";
    return { ok: false, text, reason: code };
  }
}
