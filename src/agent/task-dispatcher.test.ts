import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { TaskDispatcher, type TaskDispatcherOptions } from "./task-dispatcher.js";
import { TaskPriority, TaskStatus, type Task } from "./task.js";

function dispatcher(): TaskDispatcher {
  return new TaskDispatcher({ bus: new EventBus(), scheduler: { signalsFor: () => ({ checkpoint: () => true, signal: new AbortController().signal, cancelled: false }) }, buildProjects: { getProject: () => null } } as unknown as TaskDispatcherOptions);
}

const task = (overrides: Partial<Task>): Task => ({
  id: "t1", type: "collect_resource", source: "goal", status: TaskStatus.ACTIVE, priority: TaskPriority.FOREGROUND,
  objective: "x", parameters: {}, createdAt: new Date().toISOString(), attempts: 5, ...overrides,
}) as Task;

test("a build slice that resumed once per material is not abandoned as an interrupted loop", async () => {
  // 16:55 (2026-10-05): the windmill slice resumed after each material it
  // fetched and was abandoned at the fourth hop, then parked by the watchdog.
  const run = (t: Task) => (dispatcher() as unknown as { runSkill(t: Task): Promise<{ message?: string }> }).runSkill(t);
  const slice = await run(task({ type: "build_project_slice", projectId: "windmill", projectPhaseId: "p1" }));
  assert.doesNotMatch(slice.message ?? "", /abandoned/);
  const other = await run(task({ type: "collect_resource", parameters: { resource: "oak_log", quantity: 1 } }));
  assert.match(other.message ?? "", /abandoned after 5 interrupted attempts/, "ordinary autonomous work still backs off");
});

test("land development is never abandoned for being preempted", async () => {
  const d = new TaskDispatcher({ bus: new EventBus(), scheduler: { signalsFor: () => ({ checkpoint: () => true, signal: new AbortController().signal, cancelled: false }) } } as unknown as TaskDispatcherOptions);
  const result = await (d as unknown as { runSkill(t: Task): Promise<{ message?: string }> }).runSkill(task({ type: "develop_land", source: "background", priority: TaskPriority.BACKGROUND }));
  assert.doesNotMatch(result.message ?? "", /abandoned/);
});

test("development dispatch preserves planned identity and cancels stale plans without changing watchdog history", async () => {
  let received: any;
  const charges: string[] = [];
  let cancellations = 0, settlements = 0;
  const d = new TaskDispatcher({
    bus: new EventBus(),
    scheduler: { signalsFor: () => ({ checkpoint: () => true, signal: new AbortController().signal, cancelled: false }), requestCancel: () => { cancellations++; }, settleInterrupted: () => { settlements++; } },
    developLand: { run: async (options: unknown) => { received = options; return { ok: false, status: "failed", errorCode: "DEVELOPMENT_PLAN_STALE", message: "plot unavailable" }; } },
    watchdog: { record: (...args: unknown[]) => { charges.push(String(args)); } },
  } as unknown as TaskDispatcherOptions);
  const planned = { kind: "tidy", plot: "48,32" };
  const t = task({ type: "develop_land", source: "background", parameters: planned });
  const internals = d as any;
  const result = await internals.runSkill(t);
  assert.deepEqual(received.planned, planned);
  internals.recordOutcome(t, result);
  internals.settleResult(t, result);
  assert.equal(charges.length, 0, "an obsolete plan neither succeeds nor fails a different action");
  assert.equal(cancellations, 1);
  assert.equal(settlements, 1);
  received = undefined;
  const legacy = await internals.runSkill(task({ type: "develop_land", source: "background", parameters: {} }));
  assert.equal(legacy.errorCode, "DEVELOPMENT_PLAN_STALE");
  assert.equal(received, undefined, "unidentified legacy task cannot mutate freshly selected work");
  d.dispose();
});
