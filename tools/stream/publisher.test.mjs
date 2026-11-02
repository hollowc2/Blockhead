import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FramePublisher } from "./publisher.mjs";

class Sink extends EventEmitter {
  constructor() { super(); this.frames = []; this.accept = true; }
  write(buf) { this.frames.push(buf); return this.accept; }
}

const clock = () => { let t = 0; const now = () => t; now.advance = ms => { t += ms; }; return now; };
const HOLD = Buffer.from("hold"), LIVE1 = Buffer.from("live-1"), LIVE2 = Buffer.from("live-2");

test("holding frames flow at the frame rate before any live frame exists", () => {
  const now = clock(), p = new FramePublisher({ fps: 30, now }), sink = new Sink();
  p.attach(sink); p.select("holding", HOLD);
  for (let i = 0; i < 3000; i += 5) { p.tick(); now.advance(5); }
  assert.ok(Math.abs(sink.frames.length - 90) <= 1, `wrote ${sink.frames.length}`);
  assert.ok(sink.frames.every(f => f === HOLD));
});

test("only the latest live frame is kept; obsolete generations are rejected", () => {
  const now = clock(), p = new FramePublisher({ fps: 30, now }), sink = new Sink();
  p.attach(sink); p.select("live", HOLD);
  assert.equal(p.offerLive(LIVE1, 0), true);
  assert.equal(p.offerLive(LIVE2, 0), true);
  p.tick();
  assert.equal(sink.frames.at(-1), LIVE2);
  p.setGeneration(1);
  assert.equal(p.liveFrameAt(), null, "a new generation forgets the old frame");
  assert.equal(p.offerLive(LIVE1, 0), false);
  assert.equal(p.stats.stale, 1);
  now.advance(34); p.tick();
  assert.equal(sink.frames.at(-1), HOLD, "no stale live frame is shown while the new renderer starts");
});

test("holding frames never refresh live-frame freshness", () => {
  const now = clock(), p = new FramePublisher({ fps: 30, now }), sink = new Sink();
  p.attach(sink); p.select("holding", HOLD);
  p.offerLive(LIVE1, 0);
  const at = p.liveFrameAt();
  for (let i = 0; i < 100; i++) { now.advance(34); p.tick(); }
  assert.equal(p.liveFrameAt(), at);
});

test("backpressure drops frames until drain instead of queueing them", () => {
  const now = clock(), p = new FramePublisher({ fps: 30, now }), sink = new Sink();
  p.attach(sink); p.select("holding", HOLD);
  sink.accept = false;
  p.tick();
  assert.equal(sink.frames.length, 1);
  for (let i = 0; i < 30; i++) { now.advance(34); p.tick(); }
  assert.equal(sink.frames.length, 1, "nothing written while blocked");
  assert.ok(p.stats.dropped >= 29);
  assert.ok(p.blockedFor() >= 1000);
  sink.accept = true; sink.emit("drain");
  assert.equal(p.blockedFor(), 0);
  now.advance(34); p.tick();
  assert.equal(sink.frames.length, 2);
});

test("a delayed callback catches up by at most one frame", () => {
  const now = clock(), p = new FramePublisher({ fps: 30, now }), sink = new Sink();
  p.attach(sink); p.select("holding", HOLD);
  p.tick();
  now.advance(2000); p.tick();
  assert.equal(sink.frames.length, 3);
  assert.ok(p.stats.skipped >= 55);
});

test("a drain from a replaced encoder does not unblock the new one", () => {
  const now = clock(), p = new FramePublisher({ fps: 30, now });
  const a = new Sink(), b = new Sink();
  p.attach(a); p.select("holding", HOLD);
  a.accept = false; p.tick();
  p.attach(b); b.accept = false; now.advance(34); p.tick();
  a.emit("drain");
  assert.ok(p.blockedFor() >= 0 && p.blockedSince !== null);
});
