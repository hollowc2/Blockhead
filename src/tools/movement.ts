import { z } from "zod";
import { TaskPriority } from "../agent/task.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

function enqueueInterrupt(
  scheduler: import("../agent/scheduler.js").Scheduler,
  tool: "come_to_player" | "follow_player" | "wait_here",
  player?: string,
): void {
  scheduler.enqueue({
    type: "interrupt",
    priority: TaskPriority.INTERRUPT,
    source: "user",
    objective: tool,
    parameters: player === undefined ? { tool } : { tool, player },
  });
  scheduler.claim();
}

/** Register the deterministic movement tools (Phase 2 mechanics, exposed as tools). */
export function registerMovementTools(registry: ToolRegistry): void {
  const playerArg = {
    type: "string",
    description: "Player name to move toward or follow.",
  } as const;

  const tools: ToolDefinition[] = [
    {
      name: "come_to_player",
      description: "Walk to the named player's current position and stop.",
      args: { player: playerArg },
      argsSchema: z.object({ player: z.string().min(1) }),
      handler: (args, ctx) => {
        enqueueInterrupt(ctx.scheduler, "come_to_player", String(args.player));
        return "On my way.";
      },
    },
    {
      name: "follow_player",
      description: "Keep following the named player as they move.",
      args: { player: playerArg },
      argsSchema: z.object({ player: z.string().min(1) }),
      handler: (args, ctx) => {
        enqueueInterrupt(ctx.scheduler, "follow_player", String(args.player));
        return "Following.";
      },
    },
    {
      name: "wait_here",
      description: "Stop in place and cancel any current movement or follow.",
      args: {},
      handler: (_args, ctx) => {
        enqueueInterrupt(ctx.scheduler, "wait_here");
        return "Staying put.";
      },
    },
    {
      name: "go_home",
      description: "Navigate to the configured home location.",
      args: {},
      handler: (_args, ctx) => {
        if (ctx.state.home === null) return "No home set.";
        ctx.scheduler.enqueue({
          type: "go_home",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Go home.",
          parameters: {},
        });
        ctx.scheduler.claim();
        return "Heading home.";
      },
    },
    {
      name: "stop",
      description: "Immediately cancel any movement or follow and stay put; also cancels the active task (hard interrupt).",
      args: {},
      handler: (_args, ctx) => {
        ctx.scheduler.requestCancel();
        enqueueInterrupt(ctx.scheduler, "wait_here");
        return "Stopped.";
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}
