import test from "node:test";
import assert from "node:assert/strict";
import { formatAlert, parseConfig, send } from "./alert-telegram.mjs";

test("config needs both the token and the chat, and tolerates quotes and comments", () => {
  assert.deepEqual(parseConfig('# bot\nTELEGRAM_BOT_TOKEN="123:abc-DEF"\nTELEGRAM_CHAT_ID=-1001 # group\n'), { token: "123:abc-DEF", chat: "-1001" });
  assert.throws(() => parseConfig("TELEGRAM_BOT_TOKEN=123:abc\n"), /TELEGRAM_CHAT_ID/);
});

test("alerts and recoveries read as short messages with fixed labels", () => {
  const alert = formatAlert({ kind: "alert", condition: "not-live", summary: "The broadcast has not shown the live world for 10 minutes.", sinceSeconds: 610 });
  assert.match(alert, /^⚠️ CobbleBob stream: Broadcast not showing the live world \(for 10 min\)\n/);
  assert.match(formatAlert({ kind: "recovered", condition: "picture-black" }), /recovered: Live picture black/);
  assert.match(formatAlert({ kind: "alert", condition: "weird<b>", summary: "x" }), /stream: Stream alert\n/);
});

test("event text (summary, detail) never reaches the message", () => {
  const text = formatAlert({ kind: "alert", condition: "not-live", summary: "rtmp://a.example/live2/abcd-efgh <script>" });
  assert.doesNotMatch(text, /script|rtmp|abcd/);
});

test("send posts to sendMessage and reports Telegram's refusal without the token", async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  await send({ token: "123:secret", chat: "42" }, "hi", ok);
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:secret/sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: "42", text: "hi", disable_web_page_preview: true });
  const refused = async () => ({ ok: false, status: 400, json: async () => ({ description: "Bad Request: chat not found" }) });
  await assert.rejects(send({ token: "123:secret", chat: "42" }, "hi", refused), error => /chat not found/.test(error.message) && !/secret/.test(error.message));
});
