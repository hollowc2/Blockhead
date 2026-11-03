import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AlertBook, AlertSink, cleanDetail, loadBook, openAlerts, readAlerts, saveBook } from "./alerts.mjs";

const MIN = 60_000;
const clock = () => { let t = 1_000_000; const now = () => t; now.advance = ms => { t += ms; }; return now; };
const wall = () => { const base = Date.parse("2026-11-02T12:00:00Z"); let off = 0; const w = () => new Date(base + off); w.advance = ms => { off += ms; }; return w; };
const book = (opts = {}) => {
  const now = clock(), events = [];
  const b = new AlertBook({ now, boot: "boot-a", onEvent: e => events.push(e), ...opts });
  return { b, now, events };
};

test("a condition alerts once after its debounce and once more when it has stayed clear", () => {
  const { b, now, events } = book();
  for (let i = 0; i < 9; i++) { b.update("not-live", true, { state: "holding" }); now.advance(MIN); }
  assert.equal(events.length, 0, "9 minutes is inside the 10-minute debounce");
  now.advance(MIN); b.update("not-live", true, { state: "holding" });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "alert");
  assert.equal(events[0].condition, "not-live");
  assert.equal(events[0].sinceSeconds, 600);
  for (let i = 0; i < 60; i++) { now.advance(MIN); b.update("not-live", true); }
  assert.equal(events.length, 1, "an hour more of the same incident: no storm");
  b.update("not-live", false); now.advance(MIN); b.update("not-live", false);
  b.update("not-live", true);
  assert.equal(events.length, 1, "a brief recovery inside clearMs neither recovers nor re-alerts");
  b.update("not-live", false); now.advance(2 * MIN); b.update("not-live", false);
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, "recovered");
  assert.equal(events[1].id, events[0].id);
  assert.equal(events[1].durationSeconds, 63 * 60);
  now.advance(MIN); b.update("not-live", false);
  assert.equal(events.length, 2, "one recovered note per incident");
});

test("a flapping condition that never holds for the debounce never alerts", () => {
  const { b, now, events } = book();
  for (let i = 0; i < 100; i++) { b.update("output-stalled", true); now.advance(5 * MIN); b.update("output-stalled", false); now.advance(MIN); }
  assert.equal(events.length, 0);
});

test("unknown (null) changes nothing", () => {
  const { b, now, events } = book();
  b.update("encoder-exhausted", true);
  assert.equal(events.length, 1, "no debounce: exhaustion is already the end of a budget");
  for (let i = 0; i < 20; i++) { now.advance(MIN); b.update("encoder-exhausted", null); }
  assert.equal(events.length, 1, "restarting encoder: neither healthy nor exhausted");
  b.update("encoder-exhausted", false); now.advance(5 * MIN); b.update("encoder-exhausted", false);
  assert.equal(events.at(-1).kind, "recovered");
});

test("an open incident survives a restart without a second alert; a crash keeps the pending onset", () => {
  const { b, now, events } = book();
  b.update("encoder-exhausted", true);
  for (let i = 0; i < 6; i++) { b.update("not-live", true); now.advance(MIN); }
  const saved = JSON.parse(JSON.stringify(b.toJSON()));
  const after = []; const b2 = new AlertBook({ now, boot: "boot-a", saved, resume: true, onEvent: e => after.push(e) });
  b2.update("encoder-exhausted", true);
  assert.equal(after.length, 0, "same incident, new process");
  b2.update("not-live", true);
  now.advance(4 * MIN); b2.update("not-live", true);
  assert.equal(after.length, 1, "6 + 4 minutes across a crash restart");
  assert.equal(after[0].condition, "not-live");
  b2.update("encoder-exhausted", false); now.advance(5 * MIN); b2.update("encoder-exhausted", false);
  assert.equal(after.at(-1).kind, "recovered");
  assert.equal(after.at(-1).condition, "encoder-exhausted");
  assert.equal(events.length, 1);
});

test("a planned start or a new boot drops pending onsets but keeps open incidents", () => {
  for (const [boot, resume] of [["boot-a", false], ["boot-b", true]]) {
    const { b, now } = book();
    b.update("output-stalled", true); now.advance(9 * MIN); b.update("output-stalled", true);
    b.update("encoder-exhausted", true);
    const after = []; const b2 = new AlertBook({ now, boot, saved: b.toJSON(), resume, onEvent: e => after.push(e) });
    assert.equal(b2.dirty, true);
    now.advance(MIN); b2.update("output-stalled", true);
    assert.equal(after.length, 0, `${boot}/${resume}: onset restarted`);
    now.advance(10 * MIN); b2.update("output-stalled", true);
    assert.equal(after.length, 1);
    assert.deepEqual(b2.openIncidents().map(i => i.condition).sort(), ["encoder-exhausted", "output-stalled"]);
    b2.update("encoder-exhausted", false); now.advance(5 * MIN); b2.update("encoder-exhausted", false);
    const recovered = after.find(e => e.kind === "recovered");
    assert.equal("durationSeconds" in recovered, boot === "boot-a", "durations only within one boot");
  }
});

test("details keep only allowlisted codes and numbers: no key, address, coordinates or text", () => {
  const detail = cleanDetail({
    reason: "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst", state: "holding", restarts: 4,
    x: 1234, z: -987, server: "mc.example.org", key: "abcd-efgh-ijkl-mnop-qrst", missing: ["break", "Free text here", "starting"],
    region: "game-black", mean: 3.14159, spread: Infinity,
  });
  assert.deepEqual(detail, { state: "holding", restarts: 4, missing: ["break", "starting"], region: "game-black", mean: 3.1 });
  const { b, events } = book();
  b.update("output-stalled", true, { reason: "rtmp://example/key" });
  b.update("holding-assets-missing", true, { missing: ["break"], position: { x: 1, y: 2, z: 3 } });
  assert.ok(!JSON.stringify(events).match(/rtmp|example|position/));
});

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.input = ""; this.stdin.on("data", d => { this.input += d; }); this.killed = null; }
  kill(signal) { this.killed = signal; queueMicrotask(() => this.emit("exit", null, signal)); }
}

function sinkHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alerts-")), now = clock(), logs = [], children = [], calls = [], timers = [];
  const sink = new AlertSink({
    file: join(dir, "alerts.jsonl"), now, log: (msg, extra) => logs.push({ msg, ...extra }),
    command: "notify-me", env: { PATH: "/usr/bin", STREAM_KEY_FILE: "/secret/stream.key", HOME: "/home/x" },
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); const c = new FakeChild(); children.push(c); return c; },
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    ...options,
  });
  return { dir, sink, now, logs, children, calls, timers };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (n = 0) => ({ time: "2026-11-02T12:00:00.000Z", kind: "alert", condition: "not-live", id: `not-live-${n}`, summary: "s", detail: {} });

test("the sink records every event privately and hands each to the hook on stdin, one at a time", async () => {
  const { dir, sink, logs, children, calls } = sinkHarness();
  sink.emit(event(1)); sink.emit(event(2));
  const lines = readFileSync(join(dir, "alerts.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.id, l.hook]), [["not-live-1", "queued"], ["not-live-2", "queued"]]);
  assert.equal(statSync(join(dir, "alerts.jsonl")).mode & 0o777, 0o600);
  assert.equal(logs.filter(l => l.msg === "stream alert").length, 2, "every event reaches the journal");
  assert.equal(children.length, 1, "hooks run one at a time");
  assert.deepEqual([calls[0].cmd, calls[0].args], ["/bin/sh", ["-c", "notify-me"]]);
  assert.equal(calls[0].opts.env.STREAM_KEY_FILE, undefined, "the hook doesn't learn where the key is");
  assert.equal(calls[0].opts.env.HOME, "/home/x");
  await flush();
  assert.equal(JSON.parse(children[0].input).id, "not-live-1");
  assert.equal("hook" in JSON.parse(children[0].input), false);
  children[0].emit("exit", 0, null); await flush();
  assert.equal(children.length, 2);
  children[1].emit("exit", 3, null); await flush();
  assert.deepEqual(logs.filter(l => l.msg === "alert hook finished").map(l => l.result), ["exit:0", "exit:3"]);
  await sink.drain(10);
});

test("a hung hook is killed at its timeout, and the hook is rate-limited while the record is not", async () => {
  const { dir, sink, children, timers, logs } = sinkHarness();
  sink.emit(event(0));
  timers.find(t => t.ms === 10_000).fn();
  assert.equal(children[0].killed, "SIGKILL");
  await flush();
  assert.equal(logs.find(l => l.msg === "alert hook finished").result, "timeout");
  for (let i = 1; i < 10; i++) sink.emit(event(i));
  const hooks = readFileSync(join(dir, "alerts.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l).hook);
  assert.equal(hooks.length, 10);
  assert.equal(hooks.filter(h => h === "queued").length, 6);
  assert.equal(hooks.filter(h => h === "rate-limited").length, 4);
});

test("a hook that can't spawn is logged and never throws into the stream", async () => {
  const { sink, logs } = sinkHarness({ spawn: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
  assert.doesNotThrow(() => sink.emit(event()));
  await flush();
  assert.equal(logs.find(l => l.msg === "alert hook finished").result, "error:ENOENT");
  await sink.drain(10);
});

test("without a command the hook is off", () => {
  const { dir, sink, calls } = sinkHarness({ command: "" });
  sink.emit(event());
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, "alerts.jsonl"), "utf8")).hook, "off");
});

test("streamctl readers: recent events across rotation and open incidents from the saved book", () => {
  const { dir, sink } = sinkHarness({ command: "", maxBytes: 200 });
  for (let i = 0; i < 6; i++) sink.emit(event(i));
  assert.deepEqual(readAlerts(dir, 3).map(l => JSON.parse(l).id), ["not-live-3", "not-live-4", "not-live-5"]);
  const now = clock(), b = new AlertBook({ now, boot: "boot-a", wallClock: wall() });
  b.update("picture-black", true, { region: "frame-uniform" });
  saveBook(dir, b);
  assert.deepEqual(openAlerts(dir).map(a => a.condition), ["picture-black"]);
  assert.equal(loadBook(dir).boot, "boot-a");
  assert.deepEqual(openAlerts(join(dir, "missing")), []);
});
