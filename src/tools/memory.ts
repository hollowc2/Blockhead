import { z } from "zod";
import type { LocationsRepository } from "../memory/locations.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 13 world/memory tools (spec 14.5): remember/forget/find named
 * locations. Short, synchronous repository actions — no scheduler task, no
 * movement. `travel_to` (navigation.ts) consumes the remembered names.
 */
export function registerMemoryTools(registry: ToolRegistry, locations: LocationsRepository): void {
  const nameArg = {
    type: "string",
    description: "Name for the location (e.g. \"mine\", \"sheep pasture\").",
  } as const;
  const nameSchema = z.object({ name: z.string().min(1).max(64) });

  const tools: ToolDefinition[] = [
    {
      name: "remember_location",
      description: "Remember the current position under `name` so it can be found or travelled to later.",
      args: { name: nameArg },
      argsSchema: nameSchema,
      handler: (args, ctx): string => {
        const name = String(args.name);
        const worldId = ctx.state.worldId;
        const self = ctx.state.self;
        if (worldId === null) return "No world identity yet.";
        if (self.position === null) return "Not spawned yet.";
        locations.saveNamedLocation(worldId, {
          dimension: self.dimension ?? "overworld",
          name,
          x: Math.floor(self.position.x),
          y: Math.floor(self.position.y),
          z: Math.floor(self.position.z),
        });
        return `Remembered "${name}".`;
      },
    },
    {
      name: "forget_location",
      description: "Forget the named location.",
      args: { name: nameArg },
      argsSchema: nameSchema,
      handler: (args, ctx): string => {
        const name = String(args.name);
        const worldId = ctx.state.worldId;
        if (worldId === null) return "No world identity yet.";
        return locations.deleteNamedLocation(worldId, name)
          ? `Forgot "${name}".`
          : `I don't remember "${name}".`;
      },
    },
    {
      name: "find_location",
      description: 'Report the coordinates of a remembered location (or "home").',
      args: { name: nameArg },
      argsSchema: nameSchema,
      handler: (args, ctx): string => {
        const name = String(args.name);
        const worldId = ctx.state.worldId;
        if (worldId === null) return "No world identity yet.";
        const home = ctx.state.home;
        if ((name === "home" || name === "home base") && home !== null) {
          return `"${name}" is at ${Math.round(home.x)}, ${Math.round(home.y)}, ${Math.round(home.z)} (${home.dimension}).`;
        }
        const found = locations.getNamedLocation(worldId, name);
        return found === null
          ? `I don't remember "${name}".`
          : `"${name}" is at ${Math.round(found.x)}, ${Math.round(found.y)}, ${Math.round(found.z)} (${found.dimension}).`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}