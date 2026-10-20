import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isWebhookAuthorized } from "../src/webhooks/basic-auth.ts";
import { getWebhookSignature, signFormPost, signRawBody, verifyWebhookSignature } from "../src/webhooks/verify-signature.ts";

const KEY = "test-signing-key";
const URL_ = "https://desk.example.com/webhooks/sms";
const params = { From: "+15550100101", Body: "hello", MessageSid: "SM0001" };

describe("webhook signature (HMAC-SHA1)", () => {
  it("accepts a valid form signature and rejects tampering", () => {
    const signature = signFormPost(URL_, params, KEY);
    assert.ok(verifyWebhookSignature({ url: URL_, params, signature, signingKey: KEY }));
    assert.equal(verifyWebhookSignature({ url: URL_, params: { ...params, Body: "STOP" }, signature, signingKey: KEY }), false);
    assert.equal(verifyWebhookSignature({ url: "https://evil.example.com/webhooks/sms", params, signature, signingKey: KEY }), false);
    assert.equal(verifyWebhookSignature({ url: URL_, params, signature, signingKey: "other-key" }), false);
  });

  it("is order-independent over params (sorted canonical form)", () => {
    const signature = signFormPost(URL_, params, KEY);
    const reordered = { MessageSid: "SM0001", Body: "hello", From: "+15550100101" };
    assert.ok(verifyWebhookSignature({ url: URL_, params: reordered, signature, signingKey: KEY }));
  });

  it("accepts the provider signing the URL with the explicit standard port", () => {
    const signature = signFormPost("https://desk.example.com:443/webhooks/sms", params, KEY);
    assert.ok(verifyWebhookSignature({ url: URL_, params, signature, signingKey: KEY }));
  });

  it("accepts scheme A: hex HMAC over URL + raw body", () => {
    const raw = JSON.stringify({ event: "call.ended" });
    const signature = signRawBody(URL_, raw, KEY);
    assert.ok(verifyWebhookSignature({ url: URL_, params: {}, rawBody: raw, signature, signingKey: KEY }));
    assert.equal(verifyWebhookSignature({ url: URL_, params: {}, rawBody: raw + " ", signature, signingKey: KEY }), false);
  });

  it("fails closed without a key or signature", () => {
    const signature = signFormPost(URL_, params, KEY);
    assert.equal(verifyWebhookSignature({ url: URL_, params, signature, signingKey: "" }), false);
    assert.equal(verifyWebhookSignature({ url: URL_, params, signature: "", signingKey: KEY }), false);
  });

  it("reads either signature header", () => {
    assert.equal(getWebhookSignature(new Headers({ "x-twilio-signature": "abc" })), "abc");
    assert.equal(getWebhookSignature(new Headers({ "x-signalwire-signature": "def", "x-twilio-signature": "abc" })), "def");
  });
});

describe("basic auth", () => {
  const config = { user: "tools", password: "correct horse" };
  const header = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

  it("accepts the configured credentials only", () => {
    assert.ok(isWebhookAuthorized(header("tools", "correct horse"), config));
    assert.equal(isWebhookAuthorized(header("tools", "wrong"), config), false);
    assert.equal(isWebhookAuthorized(header("other", "correct horse"), config), false);
    assert.equal(isWebhookAuthorized("Bearer abc", config), false);
    assert.equal(isWebhookAuthorized(null, config), false);
  });

  it("allows a colon inside the password", () => {
    assert.ok(isWebhookAuthorized(header("tools", "a:b"), { user: "tools", password: "a:b" }));
  });

  it("fails closed when unconfigured", () => {
    assert.equal(isWebhookAuthorized(header("tools", "x"), {}), false);
  });
});
