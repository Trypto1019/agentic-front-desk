import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * One audit record per inbound turn: which route handled it, which model and
 * prompt version ran, every tool call and result, every guard/autonomy
 * decision, the reply, and any error. When a guard blocks a draft, the
 * original draft is stored ENCRYPTED (it may contain whatever the model made
 * up), so reviewers can see why a guard fired without the text sitting in
 * plaintext logs.
 */

export type TurnRoute = "opt_out" | "start" | "suppressed" | "confirm_yes" | "confirm_no" | "agent" | "error";

export type TurnAudit = {
  turnId: string;
  at: string;
  phoneLast4: string;
  inbound: string;
  route: TurnRoute;
  optOutRule: string | null;
  customerId: string | null;
  identityState: string;
  model: string | null;
  promptVersion: string | null;
  temperature: number | null;
  llmCalls: number;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  toolResults: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  reply: string | null;
  error: string | null;
  durationMs: number;
};

export function newTurnAudit(turnId: string, phone: string, inbound: string, now: Date): TurnAudit {
  return {
    turnId,
    at: now.toISOString(),
    phoneLast4: phone.replace(/\D/g, "").slice(-4),
    inbound,
    route: "agent",
    optOutRule: null,
    customerId: null,
    identityState: "NO_MATCH",
    model: null,
    promptVersion: null,
    temperature: null,
    llmCalls: 0,
    toolCalls: [],
    toolResults: [],
    decisions: [],
    reply: null,
    error: null,
    durationMs: 0,
  };
}

let processKey: Buffer | null = null;

function auditKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.AUDIT_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("AUDIT_ENCRYPTION_KEY must be 32 bytes, base64");
    return key;
  }
  // Demo/test fallback: an ephemeral per-process key (drafts are unreadable after exit).
  processKey ??= randomBytes(32);
  return processKey;
}

/** AES-256-GCM, bound to the turn id as associated data. */
export function encryptAuditEvidence(plaintext: string, turnId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", auditKey(), iv);
  cipher.setAAD(Buffer.from(turnId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptAuditEvidence(token: string, turnId: string): string {
  const [version, iv, tag, body] = token.split(".");
  if (version !== "v1") throw new Error("unknown audit evidence version");
  const decipher = createDecipheriv("aes-256-gcm", auditKey(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(turnId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
