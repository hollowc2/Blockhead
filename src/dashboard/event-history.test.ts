import { deepStrictEqual, equal, ok } from "node:assert/strict";
import test from "node:test";
import { EventBus } from "../events/bus.js";
import { TaskPriority, TaskStatus } from "../agent/task.js";
import { BootstrapStage } from "../agent/bootstrap.js";
import { EventHistory } from "./event-history.js";

const now = () => Date.parse("2026-09-16T12:00:00.000Z");

function task(objective = "Collect oak", status: TaskStatus = TaskStatus.FAILED) {
  return {
    id: "task-1",
    type: "collect_resource",
    priority: TaskPriority.FOREGROUND,
    source: "user" as const,
    objective,
    parameters: {},
    status,
    createdAt: "2026-09-16T11:00:00.000Z",
    lastError: "no path",
  };
}

test("evicts the oldest events from the ring buffer", () => {
  const bus = new EventBus();
  const history = new EventHistory({ bus, maxEntries: 2, now });

  bus.emit("director.decided", { task: "one", rationale: null });
  bus.emit("director.decided", { task: "two", rationale: null });
  bus.emit("director.decided", { task: "three", rationale: null });

  deepStrictEqual(history.events().map((event) => event.message), ["Director chose two", "Director chose three"]);
  history.dispose();
});

test("maps event categories and severities", () => {
  const bus = new EventBus();
  const history = new EventHistory({ bus, now });

  bus.emit("task.completed", { task: task("Build shelter", TaskStatus.COMPLETED) });
  bus.emit("bootstrap.failed", { stage: BootstrapStage.WOOD, reason: "night fell" });
  bus.emit("hostile.detected", { type: "zombie", distance: null });

  deepStrictEqual(history.events().map(({ category, severity }) => ({ category, severity })), [
    { category: "task", severity: "success" },
    { category: "bootstrap", severity: "error" },
    { category: "hostile", severity: "warning" },
  ]);
  history.dispose();
});

test("failed tasks appear in bounded recentFailures", () => {
  const bus = new EventBus();
  const history = new EventHistory({ bus, maxRecentFailures: 1, now });

  bus.emit("task.failed", { task: task("First failure") });
  bus.emit("task.failed", { task: task("Second failure") });

  equal(history.recentFailures().length, 1);
  ok(history.recentFailures()[0]?.message.includes("Second failure"));
  history.dispose();
});

test("owner chat commands appear in bounded recentChat", () => {
  const bus = new EventBus();
  const history = new EventHistory({ bus, maxRecentChat: 2, now });

  bus.emit("chat.command", { from: "Corey", command: "go home" });
  deepStrictEqual(history.recentChat().map((event) => event.message), ["Command from Corey: go home"]);
  equal(history.recentChat()[0]?.category, "chat");
  history.dispose();
});

test("cleanup unsubscribes and is safe to call twice", () => {
  const bus = new EventBus();
  const history = new EventHistory({ bus, now });

  equal(bus.listenerCount("chat.command"), 1);
  history.cleanup();
  history.dispose();
  equal(bus.listenerCount("chat.command"), 0);
  bus.emit("chat.command", { from: "Corey", command: "ignored" });
  equal(history.events().length, 0);
});

test("event and projection limits are independently bounded", () => {
  const bus = new EventBus();
  const history = new EventHistory({ bus, maxEntries: 3, maxRecentFailures: 2, maxRecentChat: 1, now });

  bus.emit("chat.command", { from: "Corey", command: "one" });
  bus.emit("chat.command", { from: "Corey", command: "two" });
  bus.emit("task.failed", { task: task("failure one") });
  bus.emit("task.failed", { task: task("failure two") });
  bus.emit("task.failed", { task: task("failure three") });

  equal(history.events().length, 3);
  equal(history.recentFailures().length, 2);
  equal(history.recentChat().length, 1);
  ok(history.events()[0]?.message.includes("failure one"));
  ok(history.recentChat()[0]?.message.includes("two"));
  history.dispose();
});
