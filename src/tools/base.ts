import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Register the centralized-stockpile tool (spec 4.3 "improve basic
 * infrastructure"). `build_base` builds (or repairs) the plank shed at home —
 * walls, roof, and door — so the chest row and stations stockpile at one
 * centralized location instead of a scatter pile. The handler enqueues a
 * scheduler task exactly like the storage tools: deterministic skill code
 * behind one user-picked tool name.
 */
export function registerBaseTools(registry: ToolRegistry, scheduler: Scheduler): void {
  /** True when a base-build task is already queued or active (no stacking). */
  const baseTaskActive = (): boolean => {
    if (scheduler.active?.type === "build_base") return true;
    return scheduler.queued.some((task) => task.type === "build_base");
  };

  const tools: ToolDefinition[] = [
    {
      name: "build_base",
      description:
        "Build (or repair) the stockpile shed at home: plank walls, a flat roof, and an oak door. The chest row, crafting table, and furnace each have a fixed slot inside, so storage and stations stay at one centralized location. Uses planks from gathered logs; a partially built shed is finished, never rebuilt.",
      args: {},
      handler: (_args, _ctx): ToolResult => {
        if (baseTaskActive()) return "Already building the base.";
        scheduler.enqueue({
          type: "build_base",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Build the base structure at home.",
          parameters: {},
        });
        scheduler.claim();
        return "Building the base.";
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}