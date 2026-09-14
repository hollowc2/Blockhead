import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { DeathEventsRepository } from "../memory/deaths.js";
import { inspectArea } from "../skills/utility.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 13 utility tools (spec 14.7): `sleep`, `eat`, `equip_best`,
 * `replace_equipment`, `recover_death_items`, and the synchronous
 * `inspect_area` readout. Death recovery is normally automatic (the death
 * manager enqueues EMERGENCY recovery on respawn); the tool exists so the
 * owner can request a sweep for an unrecovered death explicitly, and it runs
 * through the exact same deterministic recovery runner.
 */
export function registerUtilityTools(
  registry: ToolRegistry,
  scheduler: Scheduler,
  deaths: DeathEventsRepository,
): void {
  const tools: ToolDefinition[] = [
    {
      name: "sleep",
      description: "Sleep in the home bed until morning. Reports why sleep is impossible when it is daytime or no bed exists.",
      args: {},
      handler: (_args, _ctx): string => {
        scheduler.enqueue({
          type: "sleep",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Sleep until morning.",
          parameters: {},
        });
        scheduler.claim();
        return "Going to sleep.";
      },
    },
    {
      name: "eat",
      description: "Eat some carried food now (auto-eat already covers hunger automatically).",
      args: {},
      handler: (_args, _ctx): string => {
        scheduler.enqueue({
          type: "eat",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Eat food.",
          parameters: {},
        });
        scheduler.claim();
        return "Eating.";
      },
    },
    {
      name: "equip_best",
      description: "Equip the best carried tool of each family (highest tier, usable durability) and the best carried armor.",
      args: {},
      handler: (_args, _ctx): string => {
        scheduler.enqueue({
          type: "equip_best",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Equip best tools and armor.",
          parameters: {},
        });
        scheduler.claim();
        return "Equipping best gear.";
      },
    },
    {
      name: "replace_equipment",
      description:
        "Replace broken carried tools with fresh copies from the home chest. Nothing is dropped; if no replacement is stocked the report says so (use ensure_item to craft one).",
      args: {},
      handler: (_args, _ctx): string => {
        scheduler.enqueue({
          type: "replace_equipment",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Replace broken equipment.",
          parameters: {},
        });
        scheduler.claim();
        return "Replacing broken equipment.";
      },
    },
    {
      name: "recover_death_items",
      description:
        "Recover the items from the most recent unrecovered death site (value-ordered sweep, exactly like automatic death recovery). Reports when nothing is left to recover.",
      args: {},
      handler: (_args, ctx): string => {
        const worldId = ctx.state.worldId;
        if (worldId === null) return "No world identity yet.";
        const latest = deaths.latest(worldId);
        if (latest === null) return "No deaths on record.";
        if (latest.recovered || latest.recoverySkippedReason !== null) {
          return latest.recoverySkippedReason === null ? "That death is already recovered." : "That death had nothing worth recovering.";
        }
        scheduler.enqueue({
          type: "recover_death_items",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Recover items from the last death site.",
          parameters: {
            deathId: latest.id,
            dimension: latest.dimension,
            x: latest.x,
            y: latest.y,
            z: latest.z,
          },
        });
        scheduler.claim();
        return "Heading to the death site.";
      },
    },
    {
      name: "inspect_area",
      description:
        "Read what is around the bot right now: position, time of day, health, hostiles and players in view, and nearby landmarks (trees, ore, water, table, furnace, bed, chest). Reports one short summary.",
      args: {},
      handler: (_args, ctx): string => {
        return inspectArea(ctx.bot, ctx.state);
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}