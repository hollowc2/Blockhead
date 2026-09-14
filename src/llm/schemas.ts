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
 * Background director contract: the LLM picks the next background task from
 * the dispatcher-capable vocabulary. Strict by construction — a task outside
 * this list can never be enqueued, and malformed parameters fail validation
 * before anything executes. `collect_resource`'s quantity cap bounds the
 * damage a confused model can do with one decision.
 */
export const NextTaskSchema = z.object({
  task: z.discriminatedUnion("type", [
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
    z.object({ type: z.literal("go_home") }),
    z.object({ type: z.literal("wait") }),
  ]),
  rationale: z.string().max(300).optional(),
});

export type NextTaskDecision = z.infer<typeof NextTaskSchema>;

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
