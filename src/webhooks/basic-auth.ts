import { timingSafeEqual } from "node:crypto";

/**
 * HTTP Basic auth for function-calling webhooks (the voice agent platform
 * calls the app's tool endpoints with Basic credentials, not an HMAC).
 *
 * Both the user and the password are compared in constant time, and missing
 * configuration fails closed.
 */

export type BasicAuthConfig = { user?: string; password?: string };

export function isWebhookAuthorized(
  authorization: string | null | undefined,
  config: BasicAuthConfig = { user: process.env.TOOL_WEBHOOK_USER, password: process.env.TOOL_WEBHOOK_PASSWORD },
): boolean {
  const { user: expectedUser, password: expectedPassword } = config;
  if (!expectedUser || !expectedPassword) return false;

  const match = /^Basic\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  // Evaluate both comparisons so the response time does not reveal which half was wrong.
  const userOk = constantTimeEquals(user, expectedUser);
  const passwordOk = constantTimeEquals(password, expectedPassword);
  return userOk && passwordOk;
}

export function unauthorizedResponse(realm = "Agent tools"): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "WWW-Authenticate": `Basic realm="${realm}"` },
  });
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still spend a comparison so length mismatches are not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
