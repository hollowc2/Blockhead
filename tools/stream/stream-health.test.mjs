import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamHealth, recordStart, recordStop, StreamHealth, unplannedStarts } from "./stream-health.mjs";

const MIN = 60_000;
const OK = { ok: true };

/** One machine: a shared monotonic clock and wall clock, and processes that start and exit on it. */
function machine() {
  const dir = mkdtempSync(join(tmpdir(), "stream-health-"));
  let mono = 5_000_000, wall = Date.parse("2026-11-02T12:00:00Z"), boot = "boot-a";
  const logs = [];
  const frames = { frozen: false, black: null, observe() {}, status: () => ({ unchangedMinutes: 0, last: { mean: 0, spread: 0 } }) };
  const m = {
    dir, logs, frames,
    advance(ms) { mono += ms; wall += ms; },
    reboot(gapMs = MIN) { boot = `boot-${Math.random()}`; mono = 1_000; wall += gapMs; },
    start(extra = {}) {
      return new StreamHealth({ dir, now: () => mono, boot, wallClock: () => new Date(wall), log: (msg, e) => logs.push({ msg, ...e }), frameWatch: frames, ...extra });
    },
    alerts() { try { return readFileSync(join(dir, "alerts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } },
  };
  return m;
}
const healthy = { state: "LIVE", live: true, frame: null, encoder: OK, exhausted: false, holdingMissing: [] };

test("restart counting: clean stops are planned; crashes and exit 1 are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const at = (mono) => ({ boot: "b", mono, time: new Date(1_800_000_000_000 + mono) });
  assert.equal(recordStart(dir, at(0)).planned, true, "first start ever");
  recordStop(dir, { ...at(1_000), code: 0 });
  assert.equal(recordStart(dir, at(2_000)).planned, true, "after systemctl restart (SIGTERM → exit 0)");
  assert.equal(recordStart(dir, at(3_000)).planned, false, "no stop record: crash / OOM kill");
  recordStop(dir, { ...at(4_000), code: 1 });
  const { planned, records } = recordStart(dir, at(5_000));
  assert.equal(planned, false, "the encoder budget gave up");
  assert.equal(unplannedStarts(records, { boot: "b", mono: 5_000, windowMs: 10_000 }), 2);
  assert.equal(unplannedStarts(records, { boot: "b", mono: 13_500, windowMs: 10_000 }), 1, "the window is monotonic");
  assert.equal(statSync(join(dir, "lifecycle.jsonl")).mode & 0o777, 0o600);
});

test("lifecycle records stay bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  for (let i = 0; i < 30; i++) recordStart(dir, { boot: "b", mono: i, keep: 10 });
  assert.equal(readFileSync(join(dir, "lifecycle.jsonl"), "utf8").trim().split("\n").length, 10);
});

test("across boots the restart window falls back to the wall clock", () => {
  const records = [{ event: "start", unplanned: true, boot: "old", mono: 9e9, time: "2026-11-02T11:50:00.000Z" }];
  assert.equal(unplannedStarts(records, { boot: "new", mono: 10, time: new Date("2026-11-02T12:00:00Z"), windowMs: 30 * MIN }), 1);
  assert.equal(unplannedStarts(records, { boot: "new", mono: 10, time: new Date("2026-11-02T12:30:00Z"), windowMs: 30 * MIN }), 0);
});

test("repeated crash restarts alert once, never once per restart, and recover after a quiet window", () => {
  const m = machine();
  let h = m.start(); h.observe(healthy);
  for (let i = 0; i < 2; i++) { m.advance(MIN); h = m.start(); h.observe(healthy); }       // two crashes
  assert.equal(m.alerts().length, 0, "two restarts in 30 min");
  m.advance(MIN); h = m.start(); h.observe(healthy);                                          // third
  assert.deepEqual(m.alerts().map(a => [a.kind, a.condition, a.detail.restarts]), [["alert", "service-restarting", 3]]);
  for (let i = 0; i < 5; i++) { m.advance(MIN); h = m.start(); h.observe(healthy); }       // a crash loop
  assert.equal(m.alerts().length, 1, "one alert per incident across process lifetimes");
  assert.equal(h.status().restartsInWindow, 8);
  for (let i = 0; i < 27; i++) { m.advance(MIN); h.observe(healthy); }
  assert.equal(m.alerts().length, 1, "the last three restarts are still inside the 30-minute window");
  m.advance(2 * MIN); h.observe(healthy);
  assert.deepEqual(m.alerts().map(a => a.kind), ["alert", "recovered"]);
  assert.deepEqual(h.status().open, []);
});

test("operator restarts are not counted", () => {
  const m = machine();
  for (let i = 0; i < 6; i++) { const h = m.start(); h.observe(healthy); m.advance(MIN); h.stop(0); }
  assert.equal(m.alerts().length, 0);
});

test("the encoder budget running out alerts at once, and recovers when a new process's encoder stays healthy", () => {
  const m = machine();
  let h = m.start();
  h.observe({ ...healthy, encoder: { ok: false, reason: "encoder-exhausted" }, exhausted: true });
  h.stop(1);
  assert.deepEqual(m.alerts().map(a => a.condition), ["encoder-exhausted"]);
  m.advance(15_000); h = m.start();
  h.observe({ ...healthy, state: "STARTING", encoder: { ok: false, reason: "encoder-restarting" } });
  m.advance(MIN); h.observe({ ...healthy, state: "STARTING" });
  m.advance(4 * MIN); h.observe(healthy);
  assert.equal(m.alerts().length, 1);
  m.advance(MIN); h.observe(healthy);
  assert.deepEqual(m.alerts().map(a => a.kind), ["alert", "recovered"]);
});

test("output not progressing and not live for 10 minutes alert; maintenance does not", () => {
  const m = machine();
  const h = m.start();
  for (let i = 0; i <= 10; i++) { h.observe({ ...healthy, state: "MAINTENANCE", live: false }); m.advance(MIN); }
  assert.equal(m.alerts().length, 0, "the operator's latch is a choice");
  for (let i = 0; i <= 10; i++) { h.observe({ ...healthy, state: "HOLDING", live: false, encoder: { ok: false, reason: "encoder-stalled" } }); m.advance(MIN); }
  assert.deepEqual(m.alerts().map(a => [a.condition, a.detail.reason ?? a.detail.state]).sort(), [["not-live", "holding"], ["output-stalled", "encoder-stalled"]]);
  for (let i = 0; i <= 3; i++) { h.observe(healthy); m.advance(MIN); }
  assert.deepEqual(m.alerts().filter(a => a.kind === "recovered").map(a => a.condition).sort(), ["not-live", "output-stalled"]);
});

test("a pending outage keeps counting across a crash restart but not across a planned one", () => {
  const m = machine();
  let h = m.start();
  for (let i = 0; i < 7; i++) { h.observe({ ...healthy, state: "RECOVERING", live: false }); m.advance(MIN); }
  h = m.start();                                       // crash: no stop record
  for (let i = 0; i < 4; i++) { h.observe({ ...healthy, state: "STARTING", live: false }); m.advance(MIN); }
  assert.deepEqual(m.alerts().map(a => [a.condition, a.sinceSeconds]), [["not-live", 600]]);

  const m2 = machine();
  h = m2.start();
  for (let i = 0; i < 7; i++) { h.observe({ ...healthy, state: "RECOVERING", live: false }); m2.advance(MIN); }
  h.stop(0); m2.advance(3 * 24 * 60 * MIN); h = m2.start();
  for (let i = 0; i < 4; i++) { h.observe({ ...healthy, state: "STARTING", live: false }); m2.advance(MIN); }
  assert.equal(m2.alerts().length, 0, "days of planned downtime don't count as an outage");
});

test("frozen and black pictures alert only while live", () => {
  const m = machine();
  const h = m.start();
  m.frames.frozen = true; m.frames.black = "frame-uniform";
  h.observe({ ...healthy, state: "HOLDING", live: false });
  assert.equal(m.alerts().length, 0);
  h.observe(healthy);
  assert.deepEqual(m.alerts().map(a => a.condition).sort(), ["picture-black", "picture-frozen"]);
  assert.equal(m.alerts().find(a => a.condition === "picture-black").detail.reason, "frame-uniform");
  m.frames.frozen = false; m.frames.black = null;
  h.observe(healthy); m.advance(2 * MIN); h.observe(healthy);
  assert.equal(m.alerts().filter(a => a.kind === "recovered").length, 2);
});

test("holding assets missing is reported once", () => {
  const m = machine();
  const h = m.start();
  for (let i = 0; i < 5; i++) { h.observe({ ...healthy, holdingMissing: ["break"] }); m.advance(MIN); }
  assert.deepEqual(m.alerts().map(a => [a.condition, a.detail.missing]), [["holding-assets-missing", ["break"]]]);
});

test("status and records carry no key, address or coordinates", () => {
  const m = machine();
  const h = m.start();
  const junk = { ok: false, reason: "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst x=123 z=-45" };
  for (let i = 0; i <= 11; i++) { h.observe({ ...healthy, state: "HOLDING", encoder: junk, holdingMissing: ["mc.example.org:25565"] }); m.advance(MIN); }
  const text = readFileSync(join(m.dir, "alerts.jsonl"), "utf8") + readFileSync(join(m.dir, "alerts-state.json"), "utf8") + JSON.stringify(h.status()) + JSON.stringify(m.logs);
  for (const bad of ["rtmp", "abcd-efgh", "x=123", "example.org", "25565"]) assert.ok(!text.includes(bad), bad);
  assert.equal(statSync(join(m.dir, "alerts-state.json")).mode & 0o777, 0o600);
});

test("createStreamHealth never throws into the stream", async () => {
  const logs = [];
  const log = (msg, e) => logs.push({ msg, ...e });
  const file = join(mkdtempSync(join(tmpdir(), "notadir-")), "file");
  writeFileSync(file, "x");
  const dead = createStreamHealth({ stateDir: join(file, "sub"), log, env: {}, onExit: () => {} });
  assert.doesNotThrow(() => dead.observe(healthy));
  assert.equal(dead.status(), null);
  await dead.drain(10);
  assert.equal(logs[0].msg, "health checks unavailable");

  const dir = mkdtempSync(join(tmpdir(), "stream-health-"));
  let exit;
  const live = createStreamHealth({ stateDir: dir, log, env: {}, onExit: handler => { exit = handler; }, frameWatch: { observe() { throw new Error("boom"); }, status: () => ({}) } });
  assert.doesNotThrow(() => live.observe(healthy));
  assert.ok(logs.some(l => l.msg === "health check error"));
  assert.equal(live.status().hook, "off");
  exit(0);
  assert.match(readFileSync(join(dir, "lifecycle.jsonl"), "utf8"), /"event":"stop".*"code":0/);
  if (process.getuid?.() !== 0) {
    chmodSync(dir, 0o500);
    try { assert.doesNotThrow(() => live.observe({ ...healthy, exhausted: true })); } finally { chmodSync(dir, 0o700); }
  }
});
