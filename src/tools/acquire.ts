import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import { resourceLabel } from "../skills/skill-library.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 13 crafting/equipment tools (spec 14.3). `ensure_item` is the
 * powerful one: the runner discovers a deterministic production chain (mine,
 * hunt, smelt, craft), satisfies every prerequisite, and delivers. The LLM
 * only names the item and quantity; every decision is deterministic skill
 * code. All handlers enqueue FOREGROUND user tasks, so a user request
 * preempts background work and resumes it afterwards (Phase 8).
 */
export function registerAcquisitionTools(registry: ToolRegistry, scheduler: Scheduler): void {
  const enqueueItemTask = (type: string, item: string, quantity: number): string => {
    const label = resourceLabel(item);
    scheduler.enqueue({
      type,
      priority: TaskPriority.FOREGROUND,
      source: "user",
      objective: `${type === "ensure_item" ? "Ensure" : type === "craft_item" ? "Craft" : "Smelt"} ${quantity} ${label}.`,
      parameters: { item, quantity },
    });
    scheduler.claim();
    return type === "ensure_item" ? `Working on ${quantity} ${label}.` : type === "craft_item" ? `Crafting ${quantity} ${label}.` : `Smelting ${quantity} ${label}.`;
  };

  const quantityArg = {
    type: "integer",
    description: "How many of the item to produce.",
  } as const;
  const itemArg = {
    type: "string",
    description: 'Item to produce, e.g. "iron_pickaxe", "oak_log", "cooked_beef".',
  } as const;

  const tools: ToolDefinition[] = [
    {
      name: "ensure_item",
      description:
        'Produce `quantity` of `item` no matter what it takes: mine the ore, hunt the animal, smelt metal, and craft prerequisites along the way, then deliver the result (equipment stays carried). Example: ensure_item("iron_pickaxe", 1).',
      args: { item: itemArg, quantity: quantityArg },
      argsSchema: z.object({
        item: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(1024),
      }),
      handler: (args, _ctx): string => {
        const item = String(args.item);
        const quantity = Number(args.quantity);
        return enqueueItemTask("ensure_item", item, quantity);
      },
    },
    {
      name: "craft_item",
      description:
        "Craft `quantity` of `item` from carried inventory and home-chest stock. No mining or hunting happens; missing materials fail with a clear message.",
      args: { item: itemArg, quantity: quantityArg },
      argsSchema: z.object({
        item: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(1024),
      }),
      handler: (args, _ctx): string => {
        return enqueueItemTask("craft_item", String(args.item), Number(args.quantity));
      },
    },
    {
      name: "smelt_item",
      description:
        "Smelt `quantity` of `item` (e.g. iron_ingot, cooked_beef, charcoal) in the home furnace. Input and fuel must already be in stock.",
      args: { item: itemArg, quantity: quantityArg },
      argsSchema: z.object({
        item: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(1024),
      }),
      handler: (args, _ctx): string => {
        return enqueueItemTask("smelt_item", String(args.item), Number(args.quantity));
      },
    },
    {
      name: "upgrade_equipment",
      description:
        "Upgrade the carried tool set (wooden -> stone -> iron) whenever the resources allow it, crafting (and mining/smelting) what is missing. No permission needed; resources permitting, this just happens.",
      args: {},
      handler: (_args, _ctx): string => {
        scheduler.enqueue({
          type: "upgrade_equipment",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Upgrade tools when resources allow.",
          parameters: {},
        });
        scheduler.claim();
        return "Upgrading equipment.";
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}