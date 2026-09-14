import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import { ANIMAL_MOB_NAMES, HOSTILE_MOB_NAMES } from "../policy/combat.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/** Mob names a hunt tool may target; "player" can never pass this schema. */
const ANIMAL_ENUM = z.enum([...ANIMAL_MOB_NAMES] as [string, ...string[]]);
const TARGET_ENUM = z.enum([...new Set([...ANIMAL_MOB_NAMES, ...HOSTILE_MOB_NAMES])] as [string, ...string[]]);

/**
 * Phase 13 food/hunt tools (spec 14.2). `gather_food` hunts passive animals
 * for the food stockpile; `hunt` targets a specific animal; `hunt_target`
 * targets an animal *or* a hostile mob. The schema itself rejects human
 * players, the combat policy re-checks at kill time, and `hunt_target` never
 * leaves the entity enum — free-form target strings are refused by Zod.
 */
export function registerFoodTools(registry: ToolRegistry, scheduler: Scheduler): void {
  const animalArg = {
    type: "string",
    description: `Passive animal to hunt: ${[...ANIMAL_MOB_NAMES].join(", ")}.`,
  } as const;
  const quantityArg = {
    type: "integer",
    description: "Food items to gather (kills produce several).",
  } as const;

  const tools: ToolDefinition[] = [
    {
      name: "gather_food",
      description:
        "Hunt passive animals (cow, pig, sheep, chicken) until `quantity` food items are carried, then deposit them in the home chest. Breaks off (and waits for regen) when health runs low, and comes home with partials on a miss.",
      args: { quantity: quantityArg },
      argsSchema: z.object({ quantity: z.number().int().positive().max(1024) }),
      handler: (args, _ctx): string => {
        const quantity = Number(args.quantity);
        scheduler.enqueue({
          type: "gather_food",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Gather ${quantity} food.`,
          parameters: { quantity },
        });
        scheduler.claim();
        return `Hunting for ${quantity} food.`;
      },
    },
    {
      name: "hunt",
      description:
        `Hunt \`quantity\` of a specific passive animal (${[...ANIMAL_MOB_NAMES].join(", ")}) and bring the meat home. Safe at low health: passives cannot fight back, and eating the meat restores health.`,
      args: { entity_type: animalArg, quantity: quantityArg },
      argsSchema: z.object({
        entity_type: ANIMAL_ENUM,
        quantity: z.number().int().positive().max(1024),
      }),
      handler: (args, _ctx): string => {
        const entityType = String(args.entity_type);
        const quantity = Number(args.quantity);
        scheduler.enqueue({
          type: "hunt",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Hunt ${quantity} food from ${entityType}.`,
          parameters: { entity_type: entityType, quantity },
        });
        scheduler.claim();
        return `Hunting ${entityType} for ${quantity} food.`;
      },
    },
    {
      name: "hunt_target",
      description:
        `Hunt a specific mob (${[...new Set([...ANIMAL_MOB_NAMES, ...HOSTILE_MOB_NAMES])].join(", ")}) for food and drops. Hostile targets are only engaged above the health retreat threshold. Human players are always rejected.`,
      args: { entity_type: { type: "string", description: "Mob to hunt (animal or hostile)." } },
      argsSchema: z.object({ entity_type: TARGET_ENUM }),
      handler: (args, _ctx): string => {
        const entityType = String(args.entity_type);
        scheduler.enqueue({
          type: "hunt",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Hunt ${entityType}.`,
          parameters: { entity_type: entityType, quantity: 4 },
        });
        scheduler.claim();
        return `Hunting ${entityType}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}