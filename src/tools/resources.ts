import { z } from "zod";
import { resourceLabel } from "../skills/skill-library.js";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Register the Phase 6 resource tools. The LLM only chooses `collect_resource`
 * with a resource name and a quantity; every search, tool decision, gather,
 * return trip, deposit, and success record is deterministic skill code
 * (three-layer design).
 *
 * Phase 8: the handler no longer runs the gather inline — it enqueues a
 * FOREGROUND user task and claims the scheduler slot. Preemption, execution,
 * and settling all belong to the TaskDispatcher, so a user request while
 * background work runs pauses that work and runs the gather; a later
 * higher-priority request (maintenance crisis, another instruction) pauses
 * the gather and resumes it with its progress intact.
 */
export function registerResourceTools(registry: ToolRegistry, scheduler: Scheduler): void {
  const tools: ToolDefinition[] = [
    {
      name: "collect_resource",
      description:
        'Gather `quantity` of a resource (e.g. "oak_log", "stone", "coal_ore", "iron_ore") and deliver it to the home chest. Searches with an expanding radius, uses the best available tool (replacing broken ones), returns home, and deposits the items when finished.',
      args: {
        resource: {
          type: "string",
          description: 'Item/block name to gather, e.g. "oak_log" or "iron_ore".',
        },
        quantity: {
          type: "integer",
          description: "How many of the resource to gather and deposit.",
        },
      },
      argsSchema: z.object({
        resource: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
      handler: (args, _ctx): string => {
        const resource = String(args.resource);
        const quantity = Number(args.quantity);
        const label = resourceLabel(resource);
        scheduler.enqueue({
          type: "collect_resource",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Gather ${quantity} ${label}.`,
          parameters: { resource, quantity },
        });
        scheduler.claim();
        return `Gathering ${quantity} ${label}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}