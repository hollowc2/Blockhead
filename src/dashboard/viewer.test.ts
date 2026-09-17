import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { ViewerManager, type ViewerAdapter, type ViewerHandle } from "./viewer.js";

type FakeBot = EventEmitter & Bot;
function bot(): FakeBot { return new EventEmitter() as unknown as FakeBot; }

function harness(adapter: ViewerAdapter, enabled = true): ViewerManager {
  return new ViewerManager({ enabled, port: 3001, distance: 6, dashboardPort: 3002, adapter });
}

test("starts once for a spawned session and closes only for that session", async () => {
  const first = bot();
  const second = bot();
  const handles: Array<ViewerHandle & { closeCalls: number }> = [];
  const manager = harness({ start: (boundBot, options) => {
    assert.equal(boundBot, first);
    assert.deepEqual(options, { port: 3001, viewDistance: 6, dashboardPort: 3002 });
    const handle = { closeCalls: 0, close() { this.closeCalls += 1; } };
    handles.push(handle);
    return handle;
  }});

  await manager.startFor(first);
  await manager.startFor(first);
  assert.equal(manager.telemetry().status, "running");
  assert.equal(handles.length, 1);
  manager.stopFor(second);
  assert.equal(handles[0]!.closeCalls, 0);
  first.emit("end");
  assert.equal(handles[0]!.closeCalls, 1);
  assert.equal(manager.telemetry().status, "stopped");
});

test("starts a new viewer for a new session", async () => {
  const bots = [bot(), bot()];
  let starts = 0;
  const manager = harness({ start: (boundBot) => {
    assert.equal(boundBot, bots[starts]);
    starts += 1;
    return { close() {} };
  }});
  await manager.startFor(bots[0]!);
  bots[0]!.emit("end");
  await manager.startFor(bots[1]!);
  assert.equal(starts, 2);
  assert.equal(manager.telemetry().status, "running");
});

test("disabled mode does not call the adapter", async () => {
  let starts = 0;
  const manager = harness({ start: () => { starts += 1; return { close() {} }; } }, false);
  await manager.startFor(bot());
  assert.equal(starts, 0);
  assert.deepEqual(manager.telemetry(), { enabled: false, status: "stopped", port: 3001, distance: 6, failure: null });
});

test("contains startup failures such as port conflicts", async () => {
  const manager = harness({ start: () => { throw new Error("EADDRINUSE: port already in use"); } });
  const session = bot();
  await manager.startFor(session);
  assert.equal(manager.telemetry().status, "failed");
  assert.equal(manager.telemetry().failure, "EADDRINUSE: port already in use");
  session.emit("end");
  assert.equal(manager.telemetry().status, "stopped");
});

test("process cleanup closes the active viewer", async () => {
  let closes = 0;
  const manager = harness({ start: () => ({ close: () => { closes += 1; } }) });
  await manager.startFor(bot());
  manager.stop();
  manager.stop();
  assert.equal(closes, 1);
  assert.equal(manager.telemetry().status, "stopped");
});
