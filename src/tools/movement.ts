import { z } from "zod";
import {
  comeToPlayer,
  followPlayer,
  goHome,
  stopFollowing,
  waitHere,
  type MovementResult,
} from "../minecraft/movement.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

function movementReply(action: "come" | "follow" | "home" | "stop" | "wait", result: MovementResult): string {
  if (!result.ok) {
    return result.status === "player_not_found" ? "Can't see you." : "Can't do that.";
  }
  switch (action) {
    case "come":
      return result.status === "already_there" ? "Already here." : "On my way.";
    case "follow":
      return "Following.";
    case "home":
      return result.status === "already_there" ? "Already home." : "Heading home.";
    case "stop":
      return "Stopped.";
    case "wait":
      return "Staying put.";
  }
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
      handler: (args, ctx) => movementReply("come", comeToPlayer(ctx.bot, String(args.player))),
    },
    {
      name: "follow_player",
      description: "Keep following the named player as they move.",
      args: { player: playerArg },
      argsSchema: z.object({ player: z.string().min(1) }),
      handler: (args, ctx) => movementReply("follow", followPlayer(ctx.bot, String(args.player))),
    },
    {
      name: "wait_here",
      description: "Stop in place and cancel any current movement or follow.",
      args: {},
      handler: (_args, ctx) => movementReply("wait", waitHere(ctx.bot)),
    },
    {
      name: "go_home",
      description: "Navigate to the configured home location.",
      args: {},
      handler: (_args, ctx) => {
        const home = ctx.state.home;
        return home ? movementReply("home", goHome(ctx.bot, home)) : "No home set.";
      },
    },
    {
      name: "stop",
      description: "Immediately cancel any movement or follow and stay put; also cancels the active task (hard interrupt).",
      args: {},
      handler: (_args, ctx) => {
        const reply = movementReply("stop", stopFollowing(ctx.bot));
        ctx.scheduler.requestCancel();
        return reply;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}
