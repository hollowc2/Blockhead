import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armObserver, observerStatus } from "./gesture-collector.js";

const RUN = "6f1c2a7e-3b9d-4c1e-8f2a-1d2e3f4a5b6c";
const status = { v: 1, run: RUN, seq: 0, tick: 1, ms: 1, type: "status", agent: "1", mc: "1.21.4", supported: true, complete: true, unhooked: false, failure: null, hooks: {} };
const line = (r: object) => JSON.stringify(r) + "\n";
/** Fake agent socket: replies to STATUS/ARM like tools/gesture-observer and records what the client sent. */
async function fakeAgent(onArm: (socket: Socket) => void) {
  const dir = mkdtempSync(join(tmpdir(), "observer-")), path = join(dir, "observer.sock");
  const received: string[] = [];
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
        const command = buffer.slice(0, i); received.push(command);
        if (command === "STATUS") socket.end(line(status));
        else if (command.startsWith("ARM ")) { socket.write(line(status)); onArm(socket); }
        else if (command === "DISARM") socket.end(line({ v: 1, run: RUN, seq: 99, tick: 9, ms: 9, type: "end", reason: "client", dropped: 0, faults: 0, hookCalls: 0, hookNanos: 0 }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { path, received, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("collector arms, parses typed records, disarms and reports a clean end", async () => {
  const agent = await fakeAgent(socket => socket.write(line({ v: 1, run: RUN, seq: 1, tick: 2, ms: 2, type: "tick", bob: null })));
  try {
    assert.equal((await observerStatus(agent.path)).complete, true);
    const capture = armObserver(agent.path, 30);
    assert.equal((await capture.ready).type, "status");
    while (capture.records.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    const integrity = await capture.stop();
    assert.deepEqual(integrity, { invalidLines: 0, truncated: false, closedEarly: false });
    assert.deepEqual(capture.records.map(r => r.type), ["status", "tick", "end"]);
    assert.deepEqual(agent.received, ["STATUS", "ARM 30", "DISARM"]);
  } finally { agent.close(); }
});

test("invalid, oversized and excess lines are counted and bounded; an early close is visible", async () => {
  const agent = await fakeAgent(socket => {
    socket.write("{not json}\n" + line({ v: 1, run: RUN, seq: 1, tick: 2, ms: 2, type: "effect", effect: "chat", text: "Hello" }));
    for (let i = 2; i < 10; i++) socket.write(line({ v: 1, run: RUN, seq: i, tick: i, ms: i, type: "tick", bob: null }));
    socket.end("x".repeat(5000));
  });
  try {
    const capture = armObserver(agent.path, 5, { maxLineBytes: 2048, maxRecords: 5 });
    await capture.ready;
    const integrity = await capture.closed;
    assert.equal(integrity.invalidLines >= 2, true);
    assert.equal(integrity.truncated, true); assert.equal(integrity.closedEarly, true);
    assert.equal(capture.records.length, 5);
  } finally { agent.close(); }
  assert.throws(() => armObserver("/nonexistent", 301), RangeError);
  await assert.rejects(armObserver("/nonexistent/observer.sock", 5).ready);
});
