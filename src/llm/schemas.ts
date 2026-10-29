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
      arguments: z.record(z.string(), z.unknown()),
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
    // Delivery into the goal's own chest (a chest_contains criterion): walk
    // there, deposit up to `quantity` carried, and read the chest back.
    z.object({
      type: z.literal("deliver_items"),
      item: z.string().min(1).max(64),
      quantity: z.number().int().min(1).max(1024),
    }),
    // Reopen and schedule the goal's build project (building_verified).
    z.object({ type: z.literal("resume_build") }),
    // Start (or resume) the terrain clear for the goal's area_cleared box.
    z.object({ type: z.literal("clear_area") }),
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

/**
 * The criteria an owner instruction may name, before the tool freezes them
 * against the world: the measurable kinds above, plus
 *  - building_verified: the home base shed, or a build project (optionally
 *    matched by name) that passes its final verification;
 *  - chest_contains: an item count in one chest — "home", the chest by the
 *    owner ("owner", i.e. "this chest"), by the bot ("bot"), or a registered
 *    storage label/category — resolved to coordinates at goal creation;
 *  - area_cleared: a clear_area-shaped box resolved from its anchor at goal
 *    creation ("this area" in front of the owner by default).
 */
export const SuccessCriterionInputSchema = z.union([
  SuccessCriterionSchema,
  z.object({
    kind: z.literal("building_verified"),
    target: z.enum(["base", "project"]).default("project"),
    project: z.string().min(1).max(64).optional(),
  }),
  z.object({
    kind: z.literal("chest_contains"),
    item: z.string().min(1).max(64),
    min: z.number().int().min(1).max(100_000),
    chest: z.string().min(1).max(64).default("home"),
  }),
  z.object({
    kind: z.literal("area_cleared"),
    width: z.number().int().min(1).max(32),
    length: z.number().int().min(1).max(32),
    height: z.number().int().min(1).max(16).default(4),
    anchor: z.enum(["owner", "owner_front", "current", "home"]).default("owner_front"),
  }),
]);

export type SuccessCriterionInput = z.infer<typeof SuccessCriterionInputSchema>;

const GoalSpecSchema = z.object({
  description: z.string().min(1).max(240),
  successCriteria: z.array(SuccessCriterionInputSchema).max(6).optional(),
});

/**
 * `start_goal` tool arguments: an objective description plus optional
 * criteria, optional follow-up goals to run in order after it (`then`), and
 * `append` to add the whole sequence behind the current plan instead of
 * replacing it.
 */
export const StartGoalArgsSchema = GoalSpecSchema.extend({
  then: z.array(GoalSpecSchema).max(8).optional(),
  append: z.boolean().optional(),
});

/** `cancel_goal` tool arguments: `all` also drops every queued goal. */
export const CancelGoalArgsSchema = z.object({
  all: z.boolean().optional(),
});

export const ResolveBlockerArgsSchema = z.object({
  choice: z.enum(["proceed", "change_plan"]),
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
