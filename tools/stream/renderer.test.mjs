import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Renderer } from "./renderer.mjs";

/** Just enough of playwright-core's chromium for one generation; records what the renderer asks of it. */
function fakeChromium({ probe }) {
  const calls = { launch: [], contexts: [], initScripts: 0, goto: [], waited: [], styleTags: 0, keys: [], cdp: [] };
  const cdp = Object.assign(new EventEmitter(), { send: async (method, params) => { calls.cdp.push([method, params]); return {}; } });
  const page = Object.assign(new EventEmitter(), {
    goto: async (url) => { calls.goto.push(url); },
    locator: (selector) => ({ waitFor: async () => { calls.waited.push(selector); }, getAttribute: async () => null }),
    addStyleTag: async () => { calls.styleTags++; },
    keyboard: { press: async (key) => { calls.keys.push(key); } },
    evaluate: async () => probe(),
    screenshot: async () => Buffer.from("still"),
  });
  const context = { addInitScript: async () => { calls.initScripts++; }, newPage: async () => page, newCDPSession: async () => cdp };
  const browser = Object.assign(new EventEmitter(), { newContext: async (options) => { calls.contexts.push(options); return context; }, close: async () => {} });
  return { calls, cdp, chromium: { launch: async (options) => { calls.launch.push(options); return browser; } } };
}

function renderer(chromium, clock) {
  const frames = [];
  const r = new Renderer({ chromium, pageUrl: "http://127.0.0.1:3003/broadcast", width: 1280, height: 720, log: () => {}, now: () => clock.t, onFrame: (frame) => frames.push(frame), onGeneration: () => {} });
  return { r, frames };
}

test("the broadcast page opens under its own CSP and is never restyled or typed into", async () => {
  const fake = fakeChromium({ probe: () => ({ state: "connected", raf: 1, gl: true }) });
  const clock = { t: 0 };
  const { r } = renderer(fake.chromium, clock);
  await r.launch();
  try {
    assert.equal(r.open, true);
    assert.deepEqual(fake.calls.goto, ["http://127.0.0.1:3003/broadcast"]);
    assert.equal(fake.calls.contexts.length, 1);
    assert.equal("bypassCSP" in fake.calls.contexts[0], false, "the real CSP applies");
    assert.deepEqual(fake.calls.contexts[0].viewport, { width: 1280, height: 720 });
    assert.equal(fake.calls.initScripts, 1, "the rAF probe is installed in every frame");
    assert.equal(fake.calls.styleTags, 0);
    assert.deepEqual(fake.calls.keys, [], "the page applies the follow camera itself");
    assert.deepEqual(fake.calls.waited, [".stage iframe"]);
    assert.deepEqual(fake.calls.cdp.map(([method]) => method), ["Page.startScreencast"]);
    assert.equal(fake.calls.cdp[0][1].maxWidth, 1280);
  } finally { await r.stop(); }
});

test("the probe reads #viewerStatus and the 3D frame's rAF counter; a frozen counter is unhealthy", async () => {
  let raf = 1;
  const fake = fakeChromium({ probe: () => ({ state: "connected", raf, gl: true }) });
  const clock = { t: 0 };
  const { r, frames } = renderer(fake.chromium, clock);
  await r.launch();
  try {
    fake.cdp.emit("Page.screencastFrame", { data: Buffer.from("live").toString("base64"), sessionId: 1 });
    assert.equal(frames.length, 1);
    await r.check();
    assert.deepEqual(r.health(), { ok: true });
    assert.deepEqual(r.viewerHealthSignal(), { ok: true });
    // The page keeps answering, but the 3D frame's render loop stops.
    for (clock.t = 2_000; clock.t <= 12_000; clock.t += 2_000) { fake.cdp.emit("Page.screencastFrame", { data: "", sessionId: 2 }); await r.check(); }
    assert.deepEqual(r.viewerHealthSignal(), { ok: false, reason: "viewer-frozen" });
    raf = 2; await r.check();
    assert.deepEqual(r.viewerHealthSignal(), { ok: true });
  } finally { await r.stop(); }
});

test("each new event banner on the page is reported once, by kind only", async () => {
  let banner = null;
  const fake = fakeChromium({ probe: () => ({ state: "connected", raf: 1, gl: true, banner }) });
  const clock = { t: 0 };
  const kinds = [];
  const r = new Renderer({ chromium: fake.chromium, pageUrl: "http://127.0.0.1:3003/broadcast", width: 1280, height: 720, log: () => {}, now: () => clock.t, onFrame: () => {}, onGeneration: () => {}, onBanner: kind => kinds.push(kind) });
  await r.launch();
  try {
    fake.cdp.emit("Page.screencastFrame", { data: "", sessionId: 1 });
    await r.check();
    banner = "death|Fell from a high place"; await r.check(); await r.check(); await r.check();
    banner = "tier|Iron Pickaxe"; await r.check();      // the next banner straight after
    banner = null; await r.check();
    banner = "mile<stone>|x"; await r.check();      // only [a-z] of the kind survives
    assert.deepEqual(kinds, ["death", "tier", "milestone"]);
  } finally { await r.stop(); }
});
