import type { GoalManager } from "../agent/goals.js";
import { StartGoalArgsSchema } from "../llm/schemas.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Goal tools: establish and cancel the single autonomous goal. Short,
 * synchronous manager actions — no scheduler task, no movement.
 *
 * `start_goal` turns an owner instruction that names a multi-step objective
 * ("prepare for a mining expedition") into the persistent goal the background
 * driver then pursues across many deterministic skill runs. The success
 * criteria are optional, closed-shape thresholds the driver can evaluate;
 * free-form conditions simply stay in the description for the LLM to judge.
 */
export function registerGoalTools(registry: ToolRegistry, goals: GoalManager): void {
  const tools: ToolDefinition[] = [
    {
      name: "start_goal",
      description:
        'Begin a persistent autonomous goal (a multi-step objective that is pursued across several actions until its success criteria are met, it becomes impossible, or the owner cancels it). Use this for instructions like "prepare for a mining expedition", "stock up for a long journey", or "build up supplies", where one single action will not finish the job. Provide a short description of the objective; optionally list success criteria that are measurable from stockpile levels (kind "stockpile" with wood/food/fuel/torches) or carried items (kind "inventory" with an item name), each with a minimum count. Setting a new goal replaces (cancels) any current goal.',
      args: {
        description: {
          type: "string",
          description: "The objective, e.g. \"Prepare for a mining expedition\".",
        },
        successCriteria: {
          type: "array",
          description:
            'Optional readiness conditions, each either {kind:"stockpile", stockpile:"wood|food|fuel|torches", min} or {kind:"inventory", item, min}.',
        },
      },
      argsSchema: StartGoalArgsSchema,
      handler: (args, ctx): ToolResult => {
        if (ctx.goals === undefined) return "No goal manager is wired.";
        const { description, successCriteria } = args as {
          description: string;
          successCriteria?: { kind: "stockpile"; stockpile: "wood" | "food" | "fuel" | "torches"; min: number }[] |
            { kind: "inventory"; item: string; min: number }[];
        };
        ctx.goals.start({ description, source: "owner", successCriteria: successCriteria ?? [] });
        return `Goal set: ${description}.`;
      },
    },
    {
      name: "cancel_goal",
      description:
        'Cancel the current autonomous goal. The owner said to stop pursuing the objective ("forget the expedition"), or the objective no longer applies.',
      args: {},
      handler: (_args, ctx): ToolResult => {
        if (ctx.goals === undefined) return "No goal manager is wired.";
        const goal = ctx.goals.active();
        if (goal === null) return "No active goal.";
        ctx.goals.cancel("cancelled by the owner");
        return `Cancelled goal: ${goal.description}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}