import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import { STORAGE_CATEGORIES, type StorageRepository } from "../memory/storage.js";
import { isChestBlock } from "../minecraft/containers.js";
import { findBlocksNear } from "../minecraft/world.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Scan radius for a chest the register_storage tool may claim. */
const REGISTER_SCAN_RADIUS = 12;

/**
 * Register the Phase 11 storage tools (spec 14.4). The LLM only picks the
 * tool and (for `create_storage` / `register_storage`) a category; every
 * craft, placement, registration, measurement, and item move is
 * deterministic skill code (three-layer design, spec sections 14.4 and 22).
 *
 * The handlers enqueue scheduler tasks exactly like the Phase 6 resource
 * tools: execution and settling belong to the TaskDispatcher, so a user
 * request while background work runs pauses that work and runs the storage
 * pass; a later higher-priority request pauses it resumably in turn.
 */
export function registerStorageTools(
  registry: ToolRegistry,
  scheduler: Scheduler,
  storage: StorageRepository,
): void {
  const categoryArg = {
    type: "string",
    description: `Storage category: ${STORAGE_CATEGORIES.join(", ")}.`,
  } as const;
  const categorySchema = z.object({ category: z.enum(STORAGE_CATEGORIES) });

  /** True when a storage task is already queued or active (no stacking). */
  const storageTaskActive = (): boolean => {
    if (scheduler.active?.type === "organize_storage" || scheduler.active?.type === "create_storage") {
      return true;
    }
    return scheduler.queued.some((task) => task.type === "organize_storage" || task.type === "create_storage");
  };

  const tools: ToolDefinition[] = [
    {
      name: "organize_storage",
      description:
        "Sort the items in every home chest into the chest of their category, create a chest for a category that accumulated enough items, and create a new chest when storage is full. Everything runs by itself at home; nothing is ever thrown away.",
      args: {},
      handler: (_args, _ctx): ToolResult => {
        if (storageTaskActive()) return "Already organizing storage.";
        scheduler.enqueue({
          type: "organize_storage",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Organize home storage by category, expanding when full.",
          parameters: {},
        });
        scheduler.claim();
        return "Organizing storage.";
      },
    },
    {
      name: "create_storage",
      description:
        "Craft (or use a carried) chest, place it at home, and register it as storage of the given category. Use when a specific kind of storage is needed; organize_storage creates chests on its own when full.",
      args: { category: categoryArg },
      argsSchema: categorySchema,
      handler: (args, _ctx): ToolResult => {
        const category = String(args.category);
        if (storageTaskActive()) return "Already creating storage.";
        scheduler.enqueue({
          type: "create_storage",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Create ${category} storage at home.`,
          parameters: { category },
        });
        scheduler.claim();
        return `Creating ${category} storage.`;
      },
    },
    {
      name: "register_storage",
      description:
        "Register the nearest unregistered chest near the bot as home storage of the given category, so it becomes a delivery/organization target. No chest is moved or built; the category is all that changes.",
      args: { category: categoryArg },
      argsSchema: categorySchema,
      handler: (args, ctx): ToolResult => {
        const category = String(args.category);
        const worldId = ctx.state.worldId;
        const home = ctx.state.home;
        if (worldId === null || home === null) return "No home configured yet.";
        const registered = new Set(
          storage.list(worldId).map((location) => `${location.x},${location.y},${location.z}`),
        );
        const positions = findBlocksNear(ctx.bot, isChestBlock, REGISTER_SCAN_RADIUS, 8);
        const position = positions.find(
          (position) => !registered.has(`${position.x},${position.y},${position.z}`),
        );
        if (position === undefined) return "No unregistered chest near me.";
        storage.register(worldId, {
          dimension: home.dimension,
          category,
          x: position.x,
          y: position.y,
          z: position.z,
        });
        return `Registered the chest here as ${category} storage.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}