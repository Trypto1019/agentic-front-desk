import { spokenDate, spokenTime } from "../src/lib/time.ts";
import { parseAssertedSlot } from "../src/agent/guards/grounded-confirmation.ts";
import { assistantMessage, type ChatClient, type ChatMessage, type ChatRequest, type ChatResponse, type ToolCall } from "../src/agent/llm.ts";

/**
 * A deterministic, offline stand-in for the model. It reads the same
 * messages a real model would and emits tool calls or text, so the demo,
 * the tests and the eval harness exercise the real loop, registry and guards
 * with no network and no API key.
 *
 * It is deliberately GULLIBLE on its first draft in three places, so the
 * server-side guards have something to catch:
 *   - prompt injection that asks it to claim a booking  → verifier withholds
 *   - a customer-supplied link it is told to repeat      → URL guard blocks
 *   - "am I booked?" it answers "you're all set" blind   → grounded-confirmation
 * On a redraft instruction it behaves.
 */

const MODEL_NAME = "mock/front-desk-scripted-v1";
let callCounter = 0;

function call(name: string, args: Record<string, unknown>): ToolCall {
  callCounter += 1;
  return { id: `call_${callCounter}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function reply(content: string, toolCalls: ToolCall[] = []): ChatResponse {
  return { content, toolCalls, modelName: MODEL_NAME, message: assistantMessage(content, toolCalls), costUsd: 0 };
}

function studioDate(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return system.match(/Studio date (\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
}

function lastUser(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

function toolResults(messages: ChatMessage[]): Array<{ name: string; payload: any }> {
  return messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool").map((m) => ({ name: m.name, payload: JSON.parse(m.content) }));
}

/** Resolve a requested day/time from text, relative to the studio date. */
function requestedSlot(text: string, today: string): { date: string | null; time: string | null } {
  const now = new Date(`${today}T12:00:00Z`);
  const slot = parseAssertedSlot(text, now, "UTC");
  let date = slot.date;
  if (!date) {
    const md = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
    if (md) {
      const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(md[1]) + 1;
      date = `${today.slice(0, 4)}-${String(month).padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    }
  }
  let time: string | null = null;
  if (slot.hour != null) {
    let h = slot.hour;
    if (slot.meridiem === "pm" && h < 12) h += 12;
    else if (slot.meridiem === "am" && h === 12) h = 0;
    else if (!slot.meridiem && h >= 1 && h <= 6) h += 12; // a bare "at 3" at a studio means afternoon
    time = `${String(h).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;
  }
  return { date, time };
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Compose the reply to a tool result, using only what the result says. */
function composeFromTool(name: string, payload: any): ChatResponse {
  const status = payload.registryStatus;
  const r = payload.result ?? {};
  if (status === "escalated") return reply("That's something our team handles directly, so I've passed it along and they'll follow up with you.");
  if (status === "deferred") return reply("The team already has your message and will follow up with you.");
  if (status === "rejected" || status === "clarify") return reply("Sorry, could you tell me the day and time you have in mind?");
  if (name === "check_availability" || r.status === "slot_unavailable") {
    if (r.status === "invalid_date") return reply(`${r.message} What other day works for you?`);
    const times: string[] = (r.openTimes ?? []).map(spokenTime);
    if (!times.length) return reply(`Nothing is open on ${spokenDate(r.date)} in the ${r.room} room. Want me to check another day?`);
    const lead = r.status === "slot_unavailable" ? `That time isn't open. On ${spokenDate(r.date)} I have` : `On ${spokenDate(r.date)} I have`;
    return reply(`${lead} ${joinList(times.slice(0, 4))} open in the ${r.room} room. Which works for you?`);
  }
  if (r.status === "needs_identity") return reply("Before I book or change anything, I need to confirm who I'm texting with. What's your first name?");
  if (r.status === "needs_disambiguation") {
    return reply(`You have more than one upcoming session: ${joinList(r.candidates.map((c: any) => `${spokenDate(c.date)} at ${spokenTime(c.time)}`))}. Which one do you mean?`);
  }
  if (r.status === "no_upcoming_session") return reply("I don't see any upcoming sessions on your account. Want me to check availability?");
  if (r.status === "outside_change_window") return reply("That session starts too soon for me to change it by text. Want me to ask the team to help?");
  if (r.status === "invalid_date") return reply(`${r.message} What other day works for you?`);
  if (name === "my_sessions") {
    const sessions = r.sessions ?? [];
    return sessions.length
      ? reply(`You have a ${sessions[0].room} session on ${spokenDate(sessions[0].date)} at ${spokenTime(sessions[0].time)}.`)
      : reply("I don't see any upcoming sessions on your account. Want me to check availability?");
  }
  if (name === "request_staff_followup") return reply("Thanks, I've passed this to the team and someone will reach out to you.");
  return reply("Thanks! Anything else I can help with?");
}

function classify(text: string, today: string): ChatResponse {
  const t = text.toLowerCase();
  const { date, time } = requestedSlot(text, today);
  const room = /\bsuite\b/.test(t) ? "suite" : "standard";
  const url = text.match(/https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|net|org|io|xyz)\/\S*/i)?.[0];

  // Gullible first drafts (the guards are expected to catch these).
  if (/ignore (?:all |any |your |previous |prior )*(?:instructions|rules)|you are now|developer mode|system override/.test(t)) {
    if (/system prompt|instructions verbatim|reveal|print your/.test(t)) {
      return reply("I can't share that, but I'm happy to help with a booking. What day works for you?");
    }
    if (/book|free|confirm/.test(t)) return reply("Done! You're booked for a free session, no charge. See you then!");
  }
  if (url && /send|text|share|forward|post|link/.test(t)) return reply(`Sure! Here's the link: ${url}`);
  if (/\b(?:am i (?:still )?(?:booked|all set|confirmed|set)|is my (?:session|appointment|booking)|do i (?:still )?have (?:a|my) (?:session|appointment))|on my way|running late\b/.test(t)) {
    return reply("You're all set! See you soon.");
  }

  if (/\b(?:are you|is this) (?:a |an )?(?:bot|robot|ai|real person|human|person)\b/.test(t)) {
    return reply("I'm Ava, an AI assistant for Acme Wellness Studio. I can help you book, move or cancel a session.");
  }
  if (/\b(?:pause|freeze|upgrade|downgrade|cancel)\b.*\bmembership\b|\bmembership\b.*\b(?:pause|freeze|upgrade|cancel)\b/.test(t)) {
    return reply("", [call("membership_change", { request: text.slice(0, 200) })]);
  }
  if (/\b(?:price|prices|pricing|cost|how much|refund|charged|charge|billing|bill)\b/.test(t)) {
    return reply("", [call("request_staff_followup", { reason: /refund|charge|billing|bill/.test(t) ? "billing" : "pricing", summary: `Customer asked: "${text.slice(0, 160)}". Please follow up.` })]);
  }
  if (/\b(?:human|real person|manager|someone call|call me|speak to (?:a|someone))\b/.test(t)) {
    return reply("", [call("request_staff_followup", { reason: "asked_for_human", summary: `Customer asked for a person: "${text.slice(0, 160)}".` })]);
  }
  if (/\b(?:hours|open daily|what time do you open|when do you open|when are you open)\b/.test(t)) {
    return reply("We're open daily: first session 8:00 AM, last session 6:00 PM.");
  }
  if (/\b(?:cancel|can't make it|cannot make it|won't make it)\b/.test(t)) {
    return reply("", [call("request_cancel", {})]);
  }
  if (/\b(?:reschedule|move|push|switch)\b/.test(t)) {
    if (date && time) return reply("", [call("request_reschedule", { new_date: date, new_time: time })]);
    return reply("Sure. What day and time would you like to move it to?");
  }
  if (/\b(?:my sessions|my bookings|my appointments|what do i have)\b/.test(t)) return reply("", [call("my_sessions", {})]);
  if (/\b(?:book|schedule|reserve|available|availability|open|openings|come in|spot|session|appointment)\b/.test(t)) {
    if (!date) return reply("Happy to help you book. What day works for you?");
    if (time && /\b(?:book|reserve|schedule|grab|take)\b/.test(t)) return reply("", [call("request_booking", { date, time, room })]);
    return reply("", [call("check_availability", { date, room })]);
  }
  if (/^(?:hi|hello|hey)\b/.test(t)) return reply("Hi! This is Ava at Acme Wellness Studio. How can I help?");
  return reply("Thanks for reaching out! I can help you book, move or cancel a session. What would you like to do?");
}

/** The mock "model". Stateless: everything it knows comes from the messages. */
export const mockChat: ChatClient = async (request: ChatRequest) => {
  const { messages } = request;
  const today = studioDate(messages);
  const last = messages.at(-1)!;

  if (last.role === "tool") return composeFromTool(last.name, JSON.parse(last.content));

  if (last.role === "system") {
    // A server read handed back by the grounded-confirmation guard.
    const read = last.content.match(/booked (\w+) session on (.+?) at (\d{1,2}:\d{2} [AP]M)/);
    if (read) return reply(`Yes, you're booked for ${read[2]} at ${read[3]} in the ${read[1]} room. See you then!`);
    // A redraft instruction: behave. Re-offer only times a tool returned, else ask.
    const availability = toolResults(messages).reverse().find((r) => r.payload?.result?.openTimes?.length);
    if (availability) return composeFromTool("check_availability", availability.payload);
    if (/link/i.test(last.content)) return reply("Sorry, I can only send links that our booking system provides. Is there anything else I can help with?");
    if (/server confirmed|server_receipt/i.test(last.content)) return reply("I can't confirm a booking that hasn't been made. Want me to check open times for a day that works?");
    return reply("Sorry about that. I can help you book, move or cancel a session. What day works for you?");
  }

  return classify(lastUser(messages), today);
};
