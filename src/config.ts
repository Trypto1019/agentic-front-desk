/**
 * Studio configuration. Everything here is fictional demo data for
 * "Acme Wellness Studio". In production these values lived in database
 * settings so operators could change them without a deploy.
 */
export type StudioConfig = {
  name: string;
  assistantName: string;
  timeZone: string;
  rooms: readonly string[];
  /** Bookable start times, studio-local HH:MM. */
  sessionStartTimes: readonly string[];
  /** Server-controlled links the assistant may send verbatim. */
  portalUrls: readonly string[];
  /** Hosts the studio owns whose public root pages may be linked. */
  ownedHosts: readonly string[];
  /** Approved public facts. The value gate accepts numbers that appear here. */
  facts: Record<string, string>;
};

export const ACME_STUDIO: StudioConfig = {
  name: "Acme Wellness Studio",
  assistantName: "Ava",
  timeZone: "America/Los_Angeles",
  rooms: ["standard", "suite"],
  sessionStartTimes: ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"],
  portalUrls: ["https://book.example.com/acme/intro", "https://book.example.com/acme/profile"],
  ownedHosts: ["example.com", "www.example.com", "book.example.com"],
  facts: {
    hours: "Open daily, first session 8:00 AM, last session 6:00 PM.",
    session_length: "Sessions are 45 minutes.",
    rooms: "Two room types: standard and suite.",
    cancellation: "Cancel or move a session up to 12 hours before it starts.",
    pricing: "Pricing is handled by the front-desk team, never by the assistant.",
  },
};

export type AgentLimits = {
  model: string;
  temperature: number;
  maxLlmIterations: number;
  maxToolCalls: number;
  maxReplyChars: number;
  timeoutMs: number;
  promptVersion: string;
};

export const DEFAULT_LIMITS: AgentLimits = {
  model: "anthropic/claude-sonnet-4.6",
  temperature: 0.2,
  maxLlmIterations: 4,
  maxToolCalls: 3,
  maxReplyChars: 480,
  timeoutMs: 20_000,
  promptVersion: "front-desk-v1",
};

/** Settings are clamped the way a DB-backed setting would be: a typo cannot remove the breaker. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentLimits {
  return {
    ...DEFAULT_LIMITS,
    model: env.AGENT_MODEL || DEFAULT_LIMITS.model,
    maxToolCalls: clampInt(env.AGENT_MAX_TOOL_CALLS, 0, 12, DEFAULT_LIMITS.maxToolCalls),
    maxLlmIterations: clampInt(env.AGENT_MAX_LLM_ITERATIONS, 1, 8, DEFAULT_LIMITS.maxLlmIterations),
  };
}

/** Flags default ON; only an explicit "0"/"false"/"off" disables. */
export function envFlagDefaultOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[name]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}
