import test from "node:test";
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { Script } from "node:vm";
import { createBrowserRequestId, browserRequestIdScript } from "../src/web/browser-request-id.js";

test("uses native randomUUID when the browser exposes it", () => {
  assert.equal(createBrowserRequestId({ randomUUID: () => "native-id", getRandomValues() { throw Error("must not fall back"); } }), "native-id");
});

test("LAN HTTP fallback produces distinct valid v4 UUIDs using secure random bytes", () => {
  const cryptoApi = { getRandomValues: (bytes: Uint8Array) => randomFillSync(bytes) };
  const values = new Set(Array.from({ length: 100 }, () => createBrowserRequestId(cryptoApi)));
  assert.equal(values.size, 100);
  for (const value of values) assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test("serialized browser helper runs without Node globals or randomUUID", () => {
  const result = new Script(browserRequestIdScript + ";createBrowserRequestId(crypto)").runInNewContext({
    crypto: { getRandomValues: (bytes: Uint8Array) => randomFillSync(bytes) }
  });
  assert.match(result, /^[a-f0-9-]{36}$/);
});

test("unavailable secure RNG fails rather than using a weak idempotency identifier", () => {
  assert.throws(() => createBrowserRequestId({ getRandomValues() { throw Error("unavailable"); } }), /unavailable/);
});
