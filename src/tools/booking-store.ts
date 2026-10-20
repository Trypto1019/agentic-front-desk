import { randomUUID } from "node:crypto";

import type { StudioConfig } from "../config.ts";
import { localClock, localDate } from "../lib/time.ts";
import { normalizePhone } from "../lib/text.ts";

/**
 * In-memory stand-in for the booking database. Synthetic data only.
 *
 * Every successful mutation returns a Receipt and bumps `revision`. Receipts
 * are the only thing allowed to back a "you're booked / cancelled / moved"
 * sentence (see src/verifier), and the revision lets evidence readers detect
 * that a read went stale after a write.
 */

export type Customer = {
  id: string;
  firstName: string;
  phone: string;
  membership: "active" | "none";
};

export type SessionStatus = "booked" | "cancelled" | "completed";

export type Session = {
  id: string;
  customerId: string;
  date: string;
  time: string;
  room: string;
  status: SessionStatus;
};

export type Receipt = {
  receiptId: string;
  action: "booked" | "cancelled" | "rescheduled";
  sessionId: string;
  customerId: string;
  date: string;
  time: string;
  room: string;
  previous?: { date: string; time: string };
  at: string;
  revision: number;
};

export class BookingError extends Error {
  constructor(readonly code: "slot_unavailable" | "session_not_found" | "outside_change_window" | "invalid_slot") {
    super(code);
  }
}

/** A session can be changed up to this many hours before it starts. */
export const CHANGE_WINDOW_HOURS = 12;

export class BookingStore {
  private customers = new Map<string, Customer>();
  private sessions = new Map<string, Session>();
  private blocked = new Set<string>();
  private _revision = 0;

  constructor(readonly config: StudioConfig) {}

  get revision(): number {
    return this._revision;
  }

  addCustomer(input: Omit<Customer, "id"> & { id?: string }): Customer {
    const customer: Customer = { ...input, id: input.id ?? randomUUID(), phone: normalizePhone(input.phone) };
    this.customers.set(customer.id, customer);
    return { ...customer };
  }

  /** Seed a session directly (fixtures only; never used by the agent path). */
  seedSession(input: Omit<Session, "id"> & { id?: string }): Session {
    const session: Session = { ...input, id: input.id ?? randomUUID() };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  /** Mark a slot as unavailable (staff hold, maintenance). */
  block(date: string, time: string, room: string): void {
    this.blocked.add(`${date}|${time}|${room}`);
  }

  customersByPhone(phone: string): Customer[] {
    const key = normalizePhone(phone);
    return [...this.customers.values()].filter((c) => c.phone === key).map((c) => ({ ...c }));
  }

  getCustomer(id: string): Customer | null {
    const c = this.customers.get(id);
    return c ? { ...c } : null;
  }

  isOpen(date: string, time: string, room: string, now: Date): boolean {
    if (!this.config.rooms.includes(room) || !this.config.sessionStartTimes.includes(time)) return false;
    if (this.blocked.has(`${date}|${time}|${room}`)) return false;
    const today = localDate(now, this.config.timeZone);
    if (date < today || (date === today && time <= localClock(now, this.config.timeZone))) return false;
    return ![...this.sessions.values()].some((s) => s.status === "booked" && s.date === date && s.time === time && s.room === room);
  }

  openTimes(date: string, room: string, now: Date): string[] {
    return this.config.sessionStartTimes.filter((time) => this.isOpen(date, time, room, now));
  }

  upcomingSessions(customerId: string, now: Date): Session[] {
    const today = localDate(now, this.config.timeZone);
    const clock = localClock(now, this.config.timeZone);
    return [...this.sessions.values()]
      .filter((s) => s.customerId === customerId && s.status === "booked" && (s.date > today || (s.date === today && s.time > clock)))
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
      .map((s) => ({ ...s }));
  }

  getSession(id: string): Session | null {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  /** Hours until a session starts, measured on the studio's wall clock. */
  hoursUntil(session: Pick<Session, "date" | "time">, now: Date): number {
    const nowLocal = Date.parse(`${localDate(now, this.config.timeZone)}T${localClock(now, this.config.timeZone)}:00Z`);
    return (Date.parse(`${session.date}T${session.time}:00Z`) - nowLocal) / 3_600_000;
  }

  book(customerId: string, date: string, time: string, room: string, now: Date): Receipt {
    if (!this.isOpen(date, time, room, now)) throw new BookingError("slot_unavailable");
    const session = this.seedSession({ customerId, date, time, room, status: "booked" });
    return this.receipt("booked", session, now);
  }

  cancel(sessionId: string, now: Date): Receipt {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "booked") throw new BookingError("session_not_found");
    if (this.hoursUntil(session, now) < CHANGE_WINDOW_HOURS) throw new BookingError("outside_change_window");
    session.status = "cancelled";
    return this.receipt("cancelled", session, now);
  }

  reschedule(sessionId: string, date: string, time: string, now: Date): Receipt {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "booked") throw new BookingError("session_not_found");
    if (this.hoursUntil(session, now) < CHANGE_WINDOW_HOURS) throw new BookingError("outside_change_window");
    if (!this.isOpen(date, time, session.room, now)) throw new BookingError("slot_unavailable");
    // Atomic in-place move, never cancel-then-rebook: a failure cannot leave the customer with nothing.
    const previous = { date: session.date, time: session.time };
    session.date = date;
    session.time = time;
    return { ...this.receipt("rescheduled", session, now), previous };
  }

  private receipt(action: Receipt["action"], session: Session, now: Date): Receipt {
    this._revision += 1;
    return {
      receiptId: randomUUID(),
      action,
      sessionId: session.id,
      customerId: session.customerId,
      date: session.date,
      time: session.time,
      room: session.room,
      at: now.toISOString(),
      revision: this._revision,
    };
  }
}
