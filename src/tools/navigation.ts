import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { LocationsRepository } from "../memory/locations.js";
import type { AgentState } from "../agent/state.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 13 navigation tools (spec 14.1): `travel_to` (a named memory location
 * or explicit coordinates) and the bounded `explore`. The handler resolves
 * names against the location memory, then enqueues a FOREGROUND task; every
 * pathfinding tick is deterministic movement code.
 */
export function registerNavigationTools(
  registry: ToolRegistry,
  scheduler: Scheduler,
  locations: LocationsRepository,
): void {
  const tools: ToolDefinition[] = [
    {
      name: "travel_to",
      description:
        'Walk to a destination: a named location from memory (e.g. "mine") or explicit coordinates {x, y, z}. Only reaches the current dimension; unauthorised dimensions and lava destinations are refused.',
      args: {
        location: {
          type: "string|object",
          description: 'Named location from memory, or an object like {"x": 10, "y": 40, "z": -20}.',
        },
      },
      argsSchema: z.object({
        location: z.union([
          z.string().min(1).max(64),
          z.object({ x: z.number(), y: z.number(), z: z.number() }),
        ]),
      }),
      handler: (args, ctx): string => {
        const raw = args.location;
        let destination: { x: number; y: number; z: number; dimension: string };
        if (typeof raw === "string") {
          const found = resolveNamedLocation(locations, ctx.state, raw);
          if (found === null) return `I don't remember a place called "${raw}".`;
          destination = found;
        } else {
          const coords = raw as { x: number; y: number; z: number };
          destination = {
            x: Math.floor(coords.x),
            y: Math.floor(coords.y),
            z: Math.floor(coords.z),
            dimension: ctx.state.self.dimension ?? "overworld",
          };
        }
        scheduler.enqueue({
          type: "travel_to",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Travel to ${typeof raw === "string" ? `"${raw}"` : `(${destination.x}, ${destination.y}, ${destination.z})`}.`,
          parameters: destination,
        });
        scheduler.claim();
        return `Heading to ${typeof raw === "string" ? `"${raw}"` : `(${destination.x}, ${destination.y}, ${destination.z})`}.`;
      },
    },
    {
      name: "explore",
      description:
        "Walk out along a compass heading (degrees; default rotates so repeated explores fan out) to a bounded distance (8-255 blocks, never beyond the expedition threshold), then walk home. No night patrols below the health retreat threshold.",
      args: {
        direction: {
          type: "integer",
          description: "Optional compass heading in degrees (0 = +z, 90 = +x, 180 = -z, 270 = -x).",
        },
        distance: {
          type: "integer",
          description: "Optional radius in blocks (default 128, max 255).",
        },
      },
      argsSchema: z.object({
        direction: z.number().int().min(0).max(359).optional(),
        distance: z.number().int().min(1).max(255).optional(),
      }),
      handler: (args, _ctx): string => {
        const direction = args.direction === undefined ? undefined : Number(args.direction);
        const distance = args.distance === undefined ? undefined : Number(args.distance);
        scheduler.enqueue({
          type: "explore",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Explore and return home.",
          parameters: {
            heading: direction,
            distance,
          },
        });
        scheduler.claim();
        return distance === undefined ? "Exploring nearby." : `Exploring up to ${distance} blocks.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}

/** Resolve a named location to coordinates; null when unknown. */
export function resolveNamedLocation(
  locations: LocationsRepository,
  state: AgentState,
  name: string,
): { x: number; y: number; z: number; dimension: string } | null {
  const worldId = state.worldId;
  if (worldId === null) return null;
  if (name === "home" || name === "home base") {
    const home = state.home;
    return home === null ? null : { x: home.x, y: home.y, z: home.z, dimension: home.dimension };
  }
  const found = locations.getNamedLocation(worldId, name);
  return found === null
    ? null
    : { x: found.x, y: found.y, z: found.z, dimension: found.dimension };
}