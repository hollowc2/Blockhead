import { BootstrapStage } from "../agent/bootstrap.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Human label for the stage the runner will execute next. */
function stageLabel(runner: BootstrapRunner): string {
  const completed = runner.completedStage;
  if (runner.currentStage === null) return completed === BootstrapStage.NORMAL_OPERATION ? "complete" : "paused";
  return runner.currentStage;
}

/**
 * Register the LLM tools that expose bootstrap mode. The LLM may only start
 * or query it; every craft, placement, and step is deterministic (spec 7).
 *
 * The registration is process-lifetime: the handlers resolve the current
 * bootstrap runner through the tool context at call time, so a reconnect
 * (which builds a fresh runner) needs no re-registration.
 */
export function registerBootstrapTools(registry: ToolRegistry): void {
  const tools: ToolDefinition[] = [
    {
      name: "run_bootstrap",
      description:
        "Start or resume CobbleBob's bootstrap: reach home, gather wood, place a crafting table, craft wooden tools, gather cobblestone, upgrade to stone tools, hunt food, find sheep for wool, craft and place a bed and a chest, place a furnace, gather coal or produce charcoal, stock torches at home, then gather exposed iron and upgrade to iron tools when available. Safe to call again.",
      args: {},
      handler: (_args, ctx): ToolResult => {
        const current = ctx.bootstrap;
        if (!current) return "Bootstrap is not available.";
        if (current.isRunning) return "Bootstrap is already running.";
        if (current.currentStage === null) return "Bootstrap is already complete.";
        void current.run();
        return `Starting bootstrap (next: ${stageLabel(current)}).`;
      },
    },
    {
      name: "bootstrap_status",
      description: "Report where CobbleBob is in the bootstrap state machine.",
      args: {},
      handler: (_args, ctx): ToolResult => {
        const current = ctx.bootstrap;
        if (!current) return "Bootstrap is not available.";
        const stage = current.currentStage;
        if (stage === null) return "Bootstrap is complete.";
        return `Bootstrap: next stage ${stage}, ${current.isRunning ? "running now" : "started up"}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}