import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification for Twilio-compatible telephony providers
 * (the scheme used by SignalWire's Compatibility API and by Twilio).
 *
 * Two schemes are accepted, both timing-safe:
 *   A. hex HMAC-SHA1 over URL + exact raw body (newer JSON/RELAY-style hooks)
 *   B. base64 HMAC-SHA1 over URL + sorted form params, concatenated key+value
 *      (classic LaML/cXML form posts)
 *
 * Fail-closed: no signing key or no signature header means `false`. Callers
 * treat `false` as "reject with 403".
 */

export type VerifyWebhookSignatureOptions = {
  /**
   * The full URL the provider called, as the provider saw it. Rebuild it
   * from a trusted PUBLIC_URL + request path. Never trust the Host or
   * X-Forwarded-* headers: those are attacker-controllable upstream.
   */
  url: string;
  /** Parsed form parameters. Array values are concatenated under the same key, in order. */
  params: Record<string, string | string[] | undefined>;
  /** Exact UTF-8 request body, before parsing. Enables scheme A. */
  rawBody?: string;
  /** Value of the signature header. */
  signature: string;
  /** Signing key. Defaults to WEBHOOK_SIGNING_KEY. */
  signingKey?: string;
};

/** Accept the provider-native header and the Twilio-compatible alias. */
export function getWebhookSignature(headers: Headers): string {
  return headers.get("x-signalwire-signature") ?? headers.get("x-twilio-signature") ?? "";
}

function safeEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function canonicalFormString(url: string, params: VerifyWebhookSignatureOptions["params"]): string {
  let canonical = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) canonical += key + (item ?? "");
    } else {
      canonical += key + (value ?? "");
    }
  }
  return canonical;
}

export function verifyWebhookSignature(opts: VerifyWebhookSignatureOptions): boolean {
  const signingKey = opts.signingKey ?? process.env.WEBHOOK_SIGNING_KEY;
  if (!signingKey || !opts.signature) return false;
  const provided = opts.signature.trim();

  // Scheme A: lowercase hex over URL + raw body.
  if (opts.rawBody !== undefined) {
    const expectedHex = createHmac("sha1", signingKey).update(`${opts.url}${opts.rawBody}`, "utf8").digest("hex");
    if (safeEqual(expectedHex, provided)) return true;
  }

  // Scheme B: base64 over URL + sorted params. Providers have been observed
  // signing the public URL both with and without the standard port, so both
  // spellings are accepted while the configured no-port URL stays canonical.
  const urls = [opts.url];
  const parsed = new URL(opts.url);
  if (!parsed.port) {
    const port = parsed.protocol === "https:" ? "443" : "80";
    urls.push(`${parsed.protocol}//${parsed.hostname}:${port}${parsed.pathname}${parsed.search}${parsed.hash}`);
  }
  for (const url of urls) {
    const expected = createHmac("sha1", signingKey).update(canonicalFormString(url, opts.params), "utf8").digest("base64");
    if (safeEqual(expected, provided)) return true;
  }
  return false;
}

/** Test/demo helper: sign a form post the way the provider would. */
export function signFormPost(url: string, params: Record<string, string>, signingKey: string): string {
  return createHmac("sha1", signingKey).update(canonicalFormString(url, params), "utf8").digest("base64");
}

/** Test/demo helper: sign a raw-body post (scheme A). */
export function signRawBody(url: string, rawBody: string, signingKey: string): string {
  return createHmac("sha1", signingKey).update(`${url}${rawBody}`, "utf8").digest("hex");
}
