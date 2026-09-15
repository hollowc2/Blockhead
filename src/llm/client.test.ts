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
