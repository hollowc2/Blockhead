import assert from "node:assert/strict";
import { test } from "node:test";
import { ShutdownCoordinator, withTimeout, type ShutdownStep } from "./shutdown.js";

interface Harness {
  coordinator: ShutdownCoordinator;
  exits: number[];
  warnings: string[];
  stderr: string[];
  clock: { now: number };
}

function harness(steps: ShutdownStep[], options: { hardTimeoutMs?: number } = {}): Harness {
  const exits: number[] = [];
  const warnings: string[] = [];
  const stderr: string[] = [];
  const clock = { now: 0 };
  const coordinator = new ShutdownCoordinator({
    steps: () => steps,
    hardTimeoutMs: options.hardTimeoutMs ?? 5000,
    logger: { info: () => undefined, warn: (fields) => warnings.push((fields as { step: string }).step) },
    exit: (code) => exits.push(code),
    stderr: (line) => stderr.push(line),
    now: () => clock.now,
  });
  return { coordinator, exits, warnings, stderr, clock };
}

const never = (): Promise<void> => new Promise(() => undefined);

test("withTimeout reports settled work and elapsed bounds", async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 50), "done");
  assert.equal(await withTimeout(Promise.reject(new Error("x")), 50), "done");
  assert.equal(await withTimeout(never(), 10), "timeout");
});

test("a task that ignores its abort signal cannot block the remaining steps", async () => {
  const ran: string[] = [];
  const h = harness([
    { name: "abort active task", timeoutMs: 20, run: never },
    { name: "close database", run: () => { ran.push("db"); } },
    { name: "close logs", run: () => { ran.push("logs"); } },
  ]);
  const started = Date.now();
  await h.coordinator.run(0, "SIGTERM");
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(ran, ["db", "logs"]);
  assert.deepEqual(h.warnings, ["abort active task"]);
  assert.deepEqual(h.exits, [0]);
});

test("a throwing step is logged and later steps still run", async () => {
  const ran: string[] = [];
  const h = harness([
    { name: "disconnect bot", run: () => { throw new Error("socket gone"); } },
    { name: "close database", run: async () => { ran.push("db"); } },
  ]);
  await h.coordinator.run(0, "SIGTERM");
  assert.deepEqual(ran, ["db"]);
  assert.deepEqual(h.warnings, ["disconnect bot"]);
  assert.deepEqual(h.exits, [0]);
});

test("the last step reports through stderr because it closes the logger", async () => {
  const h = harness([{ name: "close logs", timeoutMs: 10, run: never }]);
  await h.coordinator.run(0, "SIGTERM");
  assert.deepEqual(h.warnings, []);
  assert.match(h.stderr[0] ?? "", /close logs.*timed out/);
  assert.deepEqual(h.exits, [0]);
});

test("the hard timer forces exit(1) when the steps overrun the ceiling", async () => {
  const h = harness([{ name: "abort active task", timeoutMs: 200, run: never }], { hardTimeoutMs: 20 });
  void h.coordinator.run(0, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.exits, [1]);
  assert.match(h.stderr[0] ?? "", /did not finish within 20ms/);
});

test("steps run once however many signals arrive", async () => {
  let runs = 0;
  const h = harness([{ name: "close database", run: () => { runs += 1; } }]);
  h.coordinator.handleSignal("SIGTERM");
  // systemd's control-group kill and tsx's relay deliver SIGTERM twice.
  h.coordinator.handleSignal("SIGTERM");
  await h.coordinator.run(0, "SIGTERM");
  assert.equal(runs, 1);
  assert.deepEqual(h.exits, [0]);
});

test("a repeated signal well after the first forces an immediate exit", () => {
  const h = harness([{ name: "abort active task", timeoutMs: 200, run: never }]);
  h.coordinator.handleSignal("SIGINT");
  assert.equal(h.coordinator.inProgress, true);
  h.clock.now = 2000;
  h.coordinator.handleSignal("SIGINT");
  assert.deepEqual(h.exits, [1]);
});
