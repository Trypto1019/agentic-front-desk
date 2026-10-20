import { ACME_STUDIO } from "../src/config.ts";
import { PendingIntentStore } from "../src/state/pending-intent.ts";
import { BookingStore } from "../src/tools/booking-store.ts";
import type { ToolContext, ToolServices } from "../src/tools/registry.ts";

/** Tuesday 2026-03-10, 10:00 AM studio time (America/Los_Angeles, PDT). */
export const NOW = new Date("2026-03-10T17:00:00Z");
export const TODAY = "2026-03-10";
export const PHONE = "+15550100142";

export function makeServices(): ToolServices & { customerId: string; sessionId: string } {
  const store = new BookingStore(ACME_STUDIO);
  const customer = store.addCustomer({ firstName: "Riley", phone: PHONE, membership: "active" });
  const session = store.seedSession({ customerId: customer.id, date: "2026-03-12", time: "15:00", room: "standard", status: "booked" });
  return { store, intents: new PendingIntentStore(), settings: new Map(), staffTasks: [], customerId: customer.id, sessionId: session.id };
}

export function makeCtx(services: ToolServices, customerId: string | null, overrides: Partial<ToolContext> = {}): ToolContext {
  return { phone: PHONE, customerId, channel: "sms", turnId: "turn-test", now: NOW, services, decisions: [], priorToolNames: [], ...overrides };
}
