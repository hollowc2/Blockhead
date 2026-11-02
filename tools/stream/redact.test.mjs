import test from "node:test";
import assert from "node:assert/strict";
import { lineRedactor, redactLine } from "./redact.mjs";

const KEY = "abcd-efgh-ijkl-mnop-qrst";

function collect(secrets = [KEY]) {
  const lines = [];
  return { lines, r: lineRedactor(line => lines.push(line), secrets) };
}

test("rtmp and rtmps URLs are masked, with or without the key", () => {
  for (const url of [`rtmp://a.rtmp.youtube.com/live2/${KEY}`, `rtmps://a.rtmps.youtube.com:443/live2/${KEY}`, `RTMP://b.rtmp.youtube.com/live2?backup=1/${KEY}`]) {
    const line = redactLine(`[flv @ 0x1] Failed to open '${url}': Connection refused`, [KEY]);
    assert.ok(!line.includes(KEY), line);
    assert.ok(!/youtube\.com/.test(line), line);
  }
});

test("a key split across stderr chunks is still masked", () => {
  const { lines, r } = collect();
  const text = `Error writing trailer of rtmp://a.rtmp.youtube.com/live2/${KEY}: Broken pipe\n`;
  for (let i = 0; i < text.length; i += 7) r.push(text.slice(i, i + 7));
  r.end();
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(KEY) && !lines[0].includes("efgh"), lines[0]);
});

test("a bare key without a URL (e.g. in a multiline error) is masked", () => {
  const { lines, r } = collect();
  r.push(`first line\nstream ${KEY.slice(0, 10)}`);
  r.push(`${KEY.slice(10)} rejected\r\nthird\n`);
  r.end();
  assert.deepEqual(lines.length, 3);
  assert.ok(lines.every(l => !l.includes(KEY)), lines.join("|"));
  assert.ok(lines[1].includes("[redacted]"));
});

test("key-shaped tokens are masked even when the secret list is empty", () => {
  assert.ok(!redactLine(`opened ${KEY}`).includes(KEY));
});

test("an overlong line without newlines is dropped whole, never partially emitted", () => {
  const { lines, r } = collect();
  r.push("x".repeat(9000));
  r.push(`${KEY}tail\nnext line\n`);
  r.end();
  assert.deepEqual(lines, ["[overlong line dropped]", "next line"]);
});

test("lines are length-capped", () => {
  assert.ok(redactLine("y".repeat(5000)).length <= 301);
});
