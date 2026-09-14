import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 13 delivery tools (spec 14.4): `give_item`, `store_items`, and
 * `retrieve_items`. The LLM only names player/items/filters; walking, tossing,
 * chest opening, and slot moves are deterministic delivery code.
 */
export function registerDeliveryTools(registry: ToolRegistry, scheduler: Scheduler): void {
  const tools: ToolDefinition[] = [
    {
      name: "give_item",
      description:
        'Walk to the named player and toss `quantity` of `item` (e.g. "iron_ingot") to them. Fails cleanly when the player is not visible or the item is not carried.',
      args: {
        player: { type: "string", description: "Player name to hand items to." },
        item: { type: "string", description: "Carried item to give." },
        quantity: { type: "integer", description: "How many to give." },
      },
      argsSchema: z.object({
        player: z.string().min(1),
        item: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(1024),
      }),
      handler: (args, _ctx): string => {
        const player = String(args.player);
        const item = String(args.item);
        const quantity = Number(args.quantity);
        scheduler.enqueue({
          type: "give_item",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Give ${quantity} ${item} to ${player}.`,
          parameters: { player, item, quantity },
        });
        scheduler.claim();
        return `Giving ${quantity} ${item} to ${player}.`;
      },
    },
    {
      name: "store_items",
      description:
        "Deposit carried items into the home chest. `filter` narrows the deposit: an exact item name, a storage category (food, wood, stone, ores, valuables, equipment, mob_drops, misc), or a material word (wood, iron, ...). Omitting it stores everything carried.",
      args: {
        filter: { type: "string", description: "Optional item name / category / material word to match." },
        location: { type: "string", description: "Destination; only the home chest is supported." },
      },
      argsSchema: z.object({
        filter: z.string().min(1).max(64).optional(),
        location: z.string().min(1).max(64).optional(),
      }),
      handler: (args, _ctx): string => {
        const filter = args.filter === undefined ? null : String(args.filter);
        const location = args.location === undefined ? null : String(args.location);
        scheduler.enqueue({
          type: "store_items",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: filter === null ? "Store carried items." : `Store ${filter} items.`,
          parameters: { filter, location },
        });
        scheduler.claim();
        return "Storing items.";
      },
    },
    {
      name: "retrieve_items",
      description:
        "Withdraw items from the home chest into the inventory. `items` is a list of {item, quantity} (e.g. [{\"item\": \"iron_ingot\", \"quantity\": 4}]).",
      args: {
        items: {
          type: "array",
          description: "Items to retrieve from the home chest.",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              quantity: { type: "integer" },
            },
            required: ["item"],
          },
        },
        location: { type: "string", description: "Source; only the home chest is supported." },
      },
      argsSchema: z.object({
        items: z.array(
          z.object({
            item: z.string().min(1).max(64),
            quantity: z.number().int().positive().optional(),
          }),
        ).min(1).max(32),
        location: z.string().min(1).max(64).optional(),
      }),
      handler: (args, _ctx): string => {
        const items = (args.items as { item: string; quantity?: number }[]).map((entry) => ({
          item: entry.item,
          quantity: entry.quantity ?? 1,
        }));
        const location = args.location === undefined ? null : String(args.location);
        scheduler.enqueue({
          type: "retrieve_items",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Retrieve items from the home chest.",
          parameters: { items, location },
        });
        scheduler.claim();
        return "Retrieving items.";
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}