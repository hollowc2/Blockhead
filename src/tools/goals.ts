import type { NewGoal } from "../agent/goal.js";
import type { GoalManager } from "../agent/goals.js";
import { CancelGoalArgsSchema, StartGoalArgsSchema } from "../llm/schemas.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

type GoalSpec = { description: string; successCriteria?: NewGoal["successCriteria"] };

/**
 * Goal tools: establish, queue, and cancel autonomous goals. Short,
 * synchronous manager actions — no scheduler task, no movement.
 *
 * `start_goal` turns an owner instruction that names a multi-step objective
 * ("prepare for a mining expedition") into the persistent goal the background
 * driver then pursues across many deterministic skill runs. The success
 * criteria are optional, closed-shape thresholds the driver can evaluate;
 * free-form conditions simply stay in the description for the LLM to judge.
 * A sequence ("finish the house, then gather iron, then stock the chest")
 * arrives in one call as the first goal plus `then`, and the goal queue runs
 * them in order; `append` adds to the current plan instead of replacing it.
 */
export function registerGoalTools(registry: ToolRegistry, goals: GoalManager): void {
  const tools: ToolDefinition[] = [
    {
      name: "start_goal",
      description:
        'Begin a persistent autonomous goal (a multi-step objective that is pursued across several actions until its success criteria are met, it becomes impossible, or the owner cancels it). Use this for instructions like "prepare for a mining expedition", "stock up for a long journey", or "build up supplies", where one single action will not finish the job. Provide a short description of the objective; optionally list success criteria that are measurable from stockpile levels (kind "stockpile" with wood/food/fuel/torches) or carried items (kind "inventory" with an item name), each with a minimum count. When the owner lists several objectives in order ("do X, then Y, then Z"), put the first in description/successCriteria and the rest, in order, in "then"; each runs after the previous one settles. By default this replaces (cancels) the current goal and any queued goals; set "append": true when the owner says to do it after the current work ("after that", "next", "also", "queue").',
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
        then: {
          type: "array",
          description:
            'Optional follow-up goals to run in order after this one, each {description, successCriteria?}.',
        },
        append: {
          type: "boolean",
          description: "true to queue behind the current goal(s) instead of replacing them.",
        },
      },
      argsSchema: StartGoalArgsSchema,
      handler: (args, ctx): ToolResult => {
        if (ctx.goals === undefined) return "No goal manager is wired.";
        const { then, append, ...first } = args as GoalSpec & { then?: GoalSpec[]; append?: boolean };
        const sequence = [first, ...(then ?? [])].map((spec): NewGoal => ({
          description: spec.description,
          source: "owner",
          successCriteria: spec.successCriteria ?? [],
        }));
        const [head, ...rest] = sequence as [NewGoal, ...NewGoal[]];
        if (append === true) ctx.goals.enqueue(head);
        else ctx.goals.start(head);
        for (const goal of rest) ctx.goals.enqueue(goal);
        const active = ctx.goals.active();
        const queued = ctx.goals.queued();
        if (queued.length === 0) return `Goal set: ${head.description}.`;
        const now = active === null ? "" : `Now: ${active.description}. `;
        return `${now}Queued: ${queued.map((goal) => goal.description).join(", then ")}.`;
      },
    },
    {
      name: "cancel_goal",
      description:
        'Cancel the current autonomous goal. The owner said to stop pursuing the objective ("forget the expedition"), or the objective no longer applies. The next queued goal then starts; set "all": true to also drop every queued goal ("cancel all goals", "clear the plan").',
      args: {
        all: {
          type: "boolean",
          description: "true to also cancel every queued goal.",
        },
      },
      argsSchema: CancelGoalArgsSchema,
      handler: (args, ctx): ToolResult => {
        if (ctx.goals === undefined) return "No goal manager is wired.";
        const { all } = args as { all?: boolean };
        const goal = ctx.goals.active();
        if (goal === null) return "No active goal.";
        if (all === true) {
          ctx.goals.cancelAll("cancelled by the owner");
          return `Cancelled goal: ${goal.description}, and the queue.`;
        }
        ctx.goals.cancel("cancelled by the owner");
        const next = ctx.goals.active();
        return next === null
          ? `Cancelled goal: ${goal.description}.`
          : `Cancelled goal: ${goal.description}. Next: ${next.description}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}
