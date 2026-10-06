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
