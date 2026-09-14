import { z } from "zod";
import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 13 combat tools (spec 14.6). Self-defense and defending the owner
 * clear nearby hostiles; player-versus-player combat is hard-forbidden by the
 * schema (no player targets exist), the dispatcher's selection (only non-
 * player entities are candidates), and the kill-time policy guard
 * (PVP_FORBIDDEN).
 */
export function registerCombatTools(registry: ToolRegistry, scheduler: Scheduler): void {
  const tools: ToolDefinition[] = [
    {
      name: "defend_self",
      description:
        "Defend against nearby hostile mobs (zombies, skeletons, ...): approach and fight them until the area is clear, up to a few kills per request. Never attacks players. Refuses to start at/below the health retreat threshold.",
      args: {},
      handler: (_args, _ctx): string => {
        scheduler.enqueue({
          type: "defend_self",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Defend against nearby hostiles.",
          parameters: {},
        });
        scheduler.claim();
        return "Defending.";
      },
    },
    {
      name: "defend_player",
      description:
        "Defend the named player: clear hostile mobs near them. The defended player is never a target; only mobs around them are fought.",
      args: {
        player: { type: "string", description: "Player name to defend." },
      },
      argsSchema: z.object({ player: z.string().min(1) }),
      handler: (args, _ctx): string => {
        const player = String(args.player);
        scheduler.enqueue({
          type: "defend_player",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: `Defend ${player}.`,
          parameters: { player },
        });
        scheduler.claim();
        return `Defending ${player}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}