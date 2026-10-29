import assert from "node:assert/strict";
import { test } from "node:test";
import { LlamaClient, type LlmMessage } from "./client.js";

const messages: LlmMessage[] = [{ role: "user", content: "test" }];
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("HTTP retries are bounded and recover independently", async () => {
  let calls = 0;
  const client = new LlamaClient({
    baseUrl: "http://test",
    timeoutMs: 1000,
    maxRetries: 1,
    fetchImpl: async (url) => {
      calls++;
      const path = String(url);
      if (path.endsWith("/v1/models")) return response({ data: [{ id: "test-model" }] });
      if (calls === 2) return response({}, 503);
      return response({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  assert.equal(await client.complete(messages), '{"ok":true}');
  assert.equal(calls, 3, "model discovery plus one failed completion and one retry");
});

test("persistent HTTP failures stop after the configured retry budget", async () => {
  let calls = 0;
  const client = new LlamaClient({
    baseUrl: "http://test",
    timeoutMs: 1000,
    maxRetries: 1,
    fetchImpl: async () => {
      calls++;
      throw new Error("connection refused");
    },
  });
  await assert.rejects(() => client.complete(messages), /connection refused/);
  assert.equal(calls, 2);
});

test("cancelled queued public requests never reach inference, private work is prioritized", async () => {
  let finish!: () => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const calls: string[] = [];
  const client = new LlamaClient({ baseUrl: "http://test", timeoutMs: 1000, maxRetries: 0,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/models")) return response({ data: [{ id: "test" }] });
      const text = JSON.parse(String(options!.body)).messages[0].content; calls.push(text);
      if (text === "first") { started(); await new Promise<void>(resolve => { finish = resolve; }); }
      return response({ choices: [{ message: { content: text } }] });
    },
  });
  const msg = (content: string): LlmMessage[] => [{ role: "user", content }];
  const first = client.complete(msg("first")); await begun;
  const controller = new AbortController();
  const abandoned = client.complete(msg("abandoned"), { priority: "public", signal: controller.signal });
  const rejected = assert.rejects(abandoned); controller.abort(); await rejected;
  const expired = client.complete(msg("expired"), { priority: "public", deadline: Date.now() - 1 });
  await assert.rejects(expired);
  const publicQuestion = client.complete(msg("public"), { priority: "public" });
  const owner = client.complete(msg("owner")); finish();
  assert.deepEqual(await Promise.all([first, publicQuestion, owner]), ["first", "public", "owner"]);
  assert.deepEqual(calls, ["first", "owner", "public"]);
  assert.equal(client.queueState.queued, 0);
});

test("active cancellation aborts discovery/transport and serialization remains held until settlement", async () => {
  let rejectTransport!: (error: unknown) => void, begun!: () => void;
  let activeSignal!: AbortSignal;
  const started = new Promise<void>(resolve => { begun = resolve; });
  let calls = 0;
  const client = new LlamaClient({ baseUrl: "http://test", timeoutMs: 1000, maxRetries: 2, fetchImpl: async (_url, options) => {
    calls++;
    if (calls === 1) { activeSignal = options!.signal!; begun(); return new Promise((_resolve, reject) => { rejectTransport = reject; }); }
    if (calls === 2) return response({ data: [{ id: "test" }] });
    return response({ choices: [{ message: { content: "owner" } }] });
  } });
  const controller = new AbortController();
  const publicQuestion = client.complete(messages, { signal: controller.signal, priority: "public" });
  await started; const failure = assert.rejects(publicQuestion); controller.abort();
  assert(activeSignal.aborted);
  const owner = client.complete(messages);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1, "aborted running transport still owns the queue until it settles");
  rejectTransport(new DOMException("cancelled", "AbortError")); await failure;
  assert.equal(await owner, "owner"); assert.equal(calls, 3, "no retry of cancelled discovery");
});

test("a deadline that expires in the queue removes work before inference can start", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let finish!: () => void, begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  let inferenceCalls = 0;
  const client = new LlamaClient({ baseUrl: "http://test", timeoutMs: 10_000, maxRetries: 0, fetchImpl: async url => {
    if (String(url).endsWith("/models")) return response({ data: [{ id: "test" }] });
    inferenceCalls++; begun(); await new Promise<void>(resolve => { finish = resolve; });
    return response({ choices: [{ message: { content: "ok" } }] });
  } });
  try {
    const hold = client.complete(messages); await started;
    const expired = client.complete(messages, { deadline: 2000, priority: "public" });
    const refused = assert.rejects(expired); t.mock.timers.tick(1001); await refused;
    assert.equal(client.queueState.publicQueued, 0);
    finish(); await hold; assert.equal(inferenceCalls, 1);
  } finally { t.mock.timers.reset(); }
});

test("active public inference aborts its transport before queued owner inference starts", async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const signal = new AbortController();
  let calls = 0, active = 0, peak = 0;
  const client = new LlamaClient({ baseUrl: "http://test", timeoutMs: 1000, maxRetries: 1, fetchImpl: async (url, options) => {
    if (String(url).endsWith("/models")) return response({ data: [{ id: "test" }] });
    calls++; active++; peak = Math.max(peak, active);
    try {
      if (calls === 1) { began(); await new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })); }
      return response({ choices: [{ message: { content: "owner" } }] });
    } finally { active--; }
  } });
  const question = client.complete(messages, { priority: "public", signal: signal.signal });
  const cancelled = assert.rejects(question); await started;
  const owner = client.complete(messages); signal.abort();
  await cancelled; assert.equal(await owner, "owner");
  assert.equal(calls, 2); assert.equal(peak, 1);
});
