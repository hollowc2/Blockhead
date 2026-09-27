import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { clientAddress, RateLimiter } from "./http-guard.js";

const request = (headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

test("client address uses the proxy-appended (last) forwarded entry", () => {
  assert.equal(clientAddress(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), true), "203.0.113.9");
  assert.equal(clientAddress(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), false), "127.0.0.1");
  assert.equal(clientAddress(request({}), true), "127.0.0.1");
});

test("rate limiter enforces burst and refill per key", () => {
  let now = 0;
  const limiter = new RateLimiter(3, 1, () => now);
  assert.deepEqual([limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("a")], [true, true, true, false]);
  assert.equal(limiter.take("b"), true);
  now = 1000;
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
});

test("rate limiter memory stays bounded under many keys", () => {
  const limiter = new RateLimiter(1, 1, () => 0, 100);
  for (let i = 0; i < 1000; i += 1) limiter.take(`k${i}`);
  assert.ok((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size <= 100);
});
