import { ACME_STUDIO } from "../src/config.ts";
import { addDays, localDate } from "../src/lib/time.ts";
import { BookingStore } from "../src/tools/booking-store.ts";

/** Synthetic demo customers. Phones use the reserved fictional 555-01xx range. */
export const DEMO_PHONES = {
  member: "+15550100101",
  household: "+15550100102",
  newLead: "+15550100103",
} as const;

export function seedDemoStore(now: Date): BookingStore {
  const store = new BookingStore(ACME_STUDIO);
  const today = localDate(now, ACME_STUDIO.timeZone);
  const member = store.addCustomer({ firstName: "Alex", phone: DEMO_PHONES.member, membership: "active" });
  store.seedSession({ customerId: member.id, date: addDays(today, 3), time: "15:00", room: "standard", status: "booked" });
  const jordan = store.addCustomer({ firstName: "Jordan", phone: DEMO_PHONES.household, membership: "none" });
  store.addCustomer({ firstName: "Casey", phone: DEMO_PHONES.household, membership: "active" });
  store.seedSession({ customerId: jordan.id, date: addDays(today, 2), time: "10:00", room: "suite", status: "booked" });
  // Some slots are already taken or held.
  store.block(addDays(today, 1), "09:00", "standard");
  store.block(addDays(today, 1), "13:00", "standard");
  return store;
}
