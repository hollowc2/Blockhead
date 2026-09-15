import { z } from "zod";

/**
 * Agent decision contract (spec section 16). Every model response must pass
 * through this schema before it is acted on; invalid tool calls never execute.
 */
export const AgentDecisionSchema = z.object({
  message: z.string().optional(),
  decision: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("tool"),
      tool: z.string(),
      arguments: z.record(z.unknown()),
    }),
    z.object({
      type: z.literal("respond"),
      response: z.string(),
    }),
  ]),
  rationale: z.string().max(500).optional(),
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/**
 * The dispatcher-capable background task vocabulary, shared by the director
 * (`NextTaskSchema`) and the goal driver (`NextGoalActionSchema`). Keep this
 * list in sync with the TaskDispatcher's `runSkill` switch — a task outside
 * it (or the goal's extra production actions below) can never be enqueued,
 * and malformed parameters fail validation before anything executes.
 */
const DIRECTOR_TASK_DEFS = [
  z.object({
    type: z.literal("collect_resource"),
    resource: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(1024),
  }),
  z.object({
    type: z.literal("stockpile_maintenance"),
    kind: z.enum(["wood", "food", "fuel", "torches"]),
  }),
  z.object({ type: z.literal("organize_storage") }),
  z.object({ type: z.literal("build_base") }),
  z.object({ type: z.literal("go_home") }),
  z.object({ type: z.literal("wait") }),
] as const;

/**
 * Background director contract: the LLM picks the next background task from
 * the dispatcher-capable vocabulary. Strict by construction — a task outside
 * this list can never be enqueued, and malformed parameters fail validation
 * before anything executes. `collect_resource`'s quantity cap bounds the
 * damage a confused model can do with one decision.
 */
export const NextTaskSchema = z.object({
  task: z.discriminatedUnion("type", [...DIRECTOR_TASK_DEFS]),
  rationale: z.string().max(300).optional(),
});

export type NextTaskDecision = z.infer<typeof NextTaskSchema>;

/**
 * Goal-driver contract: with one active autonomous goal, the LLM picks ONE
 * next action that progresses it. The director vocabulary plus the
 * production actions the expedition goal needs (crafting a pickaxe /
 * upgrading tools), plus the two terminal verdicts — `complete` declares the
 * success criteria satisfied by the current state; `abandon` gives up. Every
 * action still runs through the TaskDispatcher's closed `runSkill` switch;
 * the LLM cannot execute Minecraft code.
 */
export const NextGoalActionSchema = z.object({
  action: z.discriminatedUnion("type", [
    ...DIRECTOR_TASK_DEFS,
    z.object({
      type: z.literal("ensure_item"),
      item: z.string().min(1).max(64),
      quantity: z.number().int().min(1).max(1024),
    }),
    z.object({ type: z.literal("upgrade_equipment") }),
    z.object({ type: z.literal("complete") }),
    z.object({ type: z.literal("abandon") }),
  ]),
  rationale: z.string().max(300).optional(),
});

export type NextGoalActionDecision = z.infer<typeof NextGoalActionSchema>;

/**
 * Deterministic, evaluable success criteria a goal may carry. A closed shape
 * so the driver can measure them against stockpile levels and carried
 * equipment counts without any free-form evaluation.
 */
export const SuccessCriterionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stockpile"),
    stockpile: z.enum(["wood", "food", "fuel", "torches"]),
    min: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("inventory"),
    item: z.string().min(1).max(64),
    min: z.number().int().min(1),
  }),
]);

export type SuccessCriterionValue = z.infer<typeof SuccessCriterionSchema>;

/** `start_goal` tool arguments: an objective description plus optional criteria. */
export const StartGoalArgsSchema = z.object({
  description: z.string().min(1).max(240),
  successCriteria: z.array(SuccessCriterionSchema).max(6).optional(),
});

/** Minimal validation of a llama.cpp `/v1/chat/completions` response. */
export const ChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});
