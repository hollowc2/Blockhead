import test from "node:test";
import assert from "node:assert/strict";
import { BroadcastState, STATES, withOfflineScene } from "./broadcast-state.mjs";

const ok = { ok: true };
const healthy = { bot: ok, viewer: ok, renderer: ok };
const bad = (name, reason) => ({ ...healthy, [name]: { ok: false, reason } });

/** Drive the machine once per second from `from` to `to` (inclusive), returning transitions. */
function run(machine, from, to, input) {
  const seen = [];
  for (let t = from; t <= to; t += 1000) {
    const i = typeof input === "function" ? input(t) : input;
    const tr = machine.update(t, i);
    if (tr) seen.push(tr);
  }
  return seen;
}

function goLive(machine, start = 0) {
  const seen = run(machine, start, start + 20_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(machine.state, STATES.LIVE);
  return seen;
}

test("starts on the holding card before anything is healthy", () => {
  const m = new BroadcastState(0);
  assert.equal(m.state, STATES.STARTING);
  assert.equal(m.sourceKind, "holding");
  assert.equal(m.variant, "starting");
  run(m, 0, 60_000, { health: {} });
  assert.equal(m.state, STATES.STARTING);
  assert.equal(m.reason, "bot-unknown");
});

test("returns to live only after 15 s of sustained health and a frame rendered inside that window", () => {
  const m = new BroadcastState(0);
  // Healthy but the only live frame predates the window: no admission.
  run(m, 0, 30_000, { health: healthy, liveFrameAt: -1 });
  assert.equal(m.state, STATES.STARTING);
  const m2 = new BroadcastState(0);
  const seen = run(m2, 0, 30_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, STATES.LIVE);
  assert.equal(seen[0].at, 15_000);
});

test("a confirmed renderer crash selects holding immediately", () => {
  const m = new BroadcastState(0);
  goLive(m);
  const tr = m.update(21_000, { health: healthy, hardFailure: "page-crashed", liveFrameAt: 21_000 });
  assert.equal(tr.to, STATES.RECOVERING);
  assert.equal(tr.reason, "page-crashed");
  assert.equal(m.variant, "reconnecting");
});

test("transient health loss is debounced and shows holding within 10 s", () => {
  const m = new BroadcastState(0);
  goLive(m);
  // A 3 s blip does not flip the scene.
  run(m, 21_000, 23_000, t => ({ health: bad("viewer", "viewer-not-connected"), liveFrameAt: t }));
  run(m, 24_000, 25_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(m.state, STATES.LIVE);
  const seen = run(m, 26_000, 40_000, t => ({ health: bad("viewer", "viewer-not-connected"), liveFrameAt: t }));
  assert.equal(seen[0].to, STATES.RECOVERING);
  assert.ok(seen[0].at - 26_000 <= 10_000);
  assert.equal(seen[0].reason, "viewer-not-connected");
});

test("unknown health counts as unhealthy", () => {
  const m = new BroadcastState(0);
  goLive(m);
  const seen = run(m, 21_000, 30_000, t => ({ health: { bot: ok, viewer: ok, renderer: null }, liveFrameAt: t }));
  assert.equal(seen[0].to, STATES.RECOVERING);
  assert.equal(seen[0].reason, "renderer-unknown");
});

test("recovery that runs long stops claiming 'Reconnecting'", () => {
  const m = new BroadcastState(0);
  goLive(m);
  m.update(21_000, { health: healthy, hardFailure: "browser-disconnected" });
  run(m, 22_000, 600_000, { health: bad("renderer", "renderer-recovering") });
  assert.equal(m.state, STATES.RECOVERING);
  const seen = run(m, 601_000, 640_000, { health: bad("renderer", "renderer-recovering") });
  assert.equal(seen[0].to, STATES.HOLDING);
  assert.equal(m.variant, "break");
  // And still comes back when healthy.
  run(m, 641_000, 700_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(m.state, STATES.LIVE);
});

test("the maintenance latch overrides health and never clears itself", () => {
  const m = new BroadcastState(0);
  goLive(m);
  const tr = m.update(21_000, { health: healthy, liveFrameAt: 21_000, maintenance: true });
  assert.equal(tr.to, STATES.MAINTENANCE);
  run(m, 22_000, 3_600_000, t => ({ health: healthy, liveFrameAt: t, maintenance: true }));
  assert.equal(m.state, STATES.MAINTENANCE);
  assert.equal(m.variant, "break");
  // Clearing the latch goes through admission again, not straight to live.
  const seen = run(m, 3_601_000, 3_640_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.deepEqual(seen.map(s => s.to), [STATES.RECOVERING, STATES.LIVE]);
  assert.ok(seen[1].at - seen[0].at >= 15_000);
});

test("a maintenance latch set during recovery survives that recovery", () => {
  const m = new BroadcastState(0);
  goLive(m);
  m.update(21_000, { health: healthy, hardFailure: "page-crashed" });
  m.update(22_000, { health: bad("renderer", "renderer-recovering"), maintenance: true });
  run(m, 23_000, 120_000, t => ({ health: healthy, liveFrameAt: t, maintenance: true }));
  assert.equal(m.state, STATES.MAINTENANCE);
});

test("flapping lengthens the admission window instead of toggling scenes", () => {
  const m = new BroadcastState(0);
  let t = 0;
  const admissions = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    const seen = run(m, t, t + 200_000, x => ({ health: healthy, liveFrameAt: x }));
    const live = seen.find(s => s.to === STATES.LIVE);
    admissions.push(live.at - t);
    t = live.at + 1000;
    m.update(t, { health: healthy, hardFailure: "page-crashed" });
    t += 1000;
  }
  assert.deepEqual(admissions.slice(0, 1), [15_000]);
  assert.ok(admissions[2] > admissions[1], `admission should grow: ${admissions}`);
  assert.ok(admissions.every(a => a <= 120_000 + 1000));
});

test("a late evaluation (our own stall) restarts the debounce instead of failing live", () => {
  const m = new BroadcastState(0);
  goLive(m);
  // Our loop sleeps 30 s; every signal looks stale on wake.
  assert.equal(m.update(51_000, { health: bad("renderer", "frame-stale"), liveFrameAt: 20_000 }), null);
  assert.equal(m.update(52_000, { health: healthy, liveFrameAt: 52_000 }), null);
  assert.equal(m.state, STATES.LIVE);
});

test("a stall during admission restarts the window", () => {
  const m = new BroadcastState(0);
  run(m, 0, 10_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(m.update(30_000, { health: healthy, liveFrameAt: 30_000 }), null);
  run(m, 31_000, 44_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(m.state, STATES.STARTING);
  run(m, 45_000, 46_000, t => ({ health: healthy, liveFrameAt: t }));
  assert.equal(m.state, STATES.LIVE);
});

test("wall-clock jumps cannot move the machine: it only reads the time it is given", () => {
  const realNow = Date.now;
  try {
    Date.now = () => 9e15;
    const m = new BroadcastState(0);
    run(m, 0, 10_000, t => ({ health: healthy, liveFrameAt: t }));
    Date.now = () => 0;
    run(m, 11_000, 14_000, t => ({ health: healthy, liveFrameAt: t }));
    assert.equal(m.state, STATES.STARTING);
    m.update(15_000, { health: healthy, liveFrameAt: 15_000 });
    assert.equal(m.state, STATES.LIVE);
  } finally { Date.now = realNow; }
});

test("ten failure/recovery cycles leave no growing state", () => {
  const m = new BroadcastState(0);
  let t = 0;
  for (let i = 0; i < 10; i++) {
    run(m, t, t + 130_000, x => ({ health: healthy, liveFrameAt: x }));
    assert.equal(m.state, STATES.LIVE);
    t += 131_000;
    m.update(t, { health: healthy, hardFailure: "page-crashed" });
    t += 1000;
  }
  run(m, t, t + 700_000, { health: bad("bot", "bot-disconnected") });
  m.admitWindow(t + 700_000);
  assert.ok(m.liveExits.length <= 1, `liveExits=${m.liveExits.length}`);
});

const offlineScene = { bot: { ok: false, reason: "bot-disconnected" }, viewer: { ok: false, reason: "viewer-offline-scene" }, renderer: ok };

test("Bob disconnected with the bot up and the page's offline scene showing counts as presentable", () => {
  assert.deepEqual(withOfflineScene(offlineScene), { bot: { ok: true, reason: "offline-scene" }, viewer: { ok: true, reason: "offline-scene" }, renderer: ok });
  // Any other failure keeps its holding card: the bot down, dead or stale, an older page, a sick renderer.
  for (const health of [
    { ...offlineScene, bot: { ok: false, reason: "bot-unreachable" } },
    { ...offlineScene, bot: { ok: false, reason: "bot-unknown" } },
    { ...offlineScene, bot: { ok: false, reason: "bot-dead" } },
    { ...offlineScene, bot: { ok: false, reason: "bot-stale" } },
    { ...offlineScene, viewer: { ok: false, reason: "viewer-offline" } },
    { ...offlineScene, viewer: { ok: false, reason: "viewer-not-connected" } },
    { ...offlineScene, renderer: { ok: false, reason: "frame-stale" } },
    { ...offlineScene, renderer: { ok: false, reason: "renderer-unresponsive" } },
    { ...offlineScene, renderer: undefined },
    { ...healthy, viewer: { ok: false, reason: "viewer-offline-scene" } },
    healthy, {},
  ]) assert.equal(withOfflineScene(health), health, JSON.stringify(health));
});

test("a disconnect with the offline scene up stays live; losing the bot, the page or the renderer still holds", () => {
  const m = new BroadcastState(0);
  goLive(m);
  // The page needs a poll or two to notice: shorter than the debounce, so no flap.
  run(m, 21_000, 23_000, { health: { ...offlineScene, viewer: { ok: false, reason: "viewer-not-connected" } } });
  run(m, 24_000, 120_000, t => ({ health: withOfflineScene(offlineScene), liveFrameAt: t }));
  assert.equal(m.state, STATES.LIVE);
  // The bot process goes away: the fixed card, after the debounce.
  const seen = run(m, 121_000, 130_000, { health: withOfflineScene({ ...offlineScene, bot: { ok: false, reason: "bot-unreachable" } }) });
  assert.deepEqual(seen.map(tr => [tr.to, tr.reason]), [[STATES.RECOVERING, "bot-unreachable"]]);
  // A renderer crash is still immediate, offline scene or not.
  const n = new BroadcastState(0);
  goLive(n);
  assert.equal(n.update(21_000, { health: withOfflineScene(offlineScene), hardFailure: "page-crashed" })?.to, STATES.RECOVERING);
});

test("the streamer starting while Bob is offline admits the offline scene after the usual window", () => {
  const m = new BroadcastState(0);
  run(m, 0, 14_000, t => ({ health: withOfflineScene(offlineScene), liveFrameAt: t }));
  assert.equal(m.state, STATES.STARTING);
  run(m, 15_000, 16_000, t => ({ health: withOfflineScene(offlineScene), liveFrameAt: t }));
  assert.equal(m.state, STATES.LIVE);
});
