import { z } from "zod";
import { Vec3 } from "vec3";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import { STORAGE_CATEGORIES, type StorageRepository } from "../memory/storage.js";
import type { LocationsRepository } from "../memory/locations.js";
import { isChestBlock } from "../minecraft/containers.js";
import { findBlocksNear } from "../minecraft/world.js";
import type { AgentState } from "../agent/state.js";
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
  locations?: LocationsRepository,
): void {
  const categoryArg = {
    type: "string",
    description: `Storage category: ${STORAGE_CATEGORIES.join(", ")}.`,
  } as const;
  const categorySchema = z.object({
    category: z.enum(STORAGE_CATEGORIES),
    location: z
      .union([
        z.string().min(1).max(64),
        z.object({ x: z.number(), y: z.number(), z: z.number() }),
      ])
      .optional(),
  });

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
        "Register a chest as home storage of the given category, so it becomes a delivery/organization target. `location` optionally names the chest: a named location from memory, explicit {x, y, z}, or omitted to take the nearest unregistered chest. No chest is moved or built.",
      args: {
        category: categoryArg,
        location: {
          type: "string|object",
          description: 'Optional: a named location from memory or {"x": .., "y": .., "z": ..}.',
        },
      },
      argsSchema: categorySchema,
      handler: (args, ctx): ToolResult => {
        const category = String(args.category);
        const worldId = ctx.state.worldId;
        const home = ctx.state.home;
        if (worldId === null || home === null) return "No home configured yet.";
        const registered = new Set(
          storage.list(worldId).map((location) => `${location.x},${location.y},${location.z}`),
        );

        const direct = args.location;
        if (typeof direct === "string") {
          const found = locations === undefined ? null : resolveNamed(direct, ctx.state, locations);
          if (found === null) return `I don't remember a place called "${direct}".`;
          const block = ctx.bot.blockAt(new Vec3(found.x, found.y, found.z));
          if (block === null || !isChestBlock(block)) return "No chest at that location.";
          if (registered.has(`${found.x},${found.y},${found.z}`)) return "That chest is already registered.";
          storage.register(worldId, {
            dimension: found.dimension,
            category,
            x: found.x,
            y: found.y,
            z: found.z,
          });
          return `Registered the chest at "${direct}" as ${category} storage.`;
        }
        if (direct !== undefined) {
          const position = direct as { x: number; y: number; z: number };
          const point = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
          const block = ctx.bot.blockAt(new Vec3(point.x, point.y, point.z));
          if (block === null || !isChestBlock(block)) return "No chest at those coordinates.";
          if (registered.has(`${point.x},${point.y},${point.z}`)) return "That chest is already registered.";
          storage.register(worldId, {
            dimension: home.dimension,
            category,
            x: point.x,
            y: point.y,
            z: point.z,
          });
          return `Registered the chest there as ${category} storage.`;
        }

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

/** Resolve a named memory location to coordinates for the register tool. */
function resolveNamed(
  name: string,
  state: AgentState,
  locations: LocationsRepository,
): { x: number; y: number; z: number; dimension: string } | null {
  const worldId = state.worldId;
  if (worldId === null) return null;
  const found = locations.getNamedLocation(worldId, name);
  return found === null
    ? null
    : { x: found.x, y: found.y, z: found.z, dimension: found.dimension };
}