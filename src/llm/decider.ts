import type { LlamaClient } from "./client.js";
import { buildStateSnapshot, type DecisionInput, type StateSnapshot } from "./context.js";
import { buildDirectorMessages, buildMessages, fewShotsFromSkills } from "./prompt.js";
import { AgentDecisionSchema, NextTaskSchema, type AgentDecision, type NextTaskDecision } from "./schemas.js";
import type { DebugLog } from "./debug-log.js";
import type { SkillsRepository } from "../memory/skills.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

export interface DecisionMakerOptions {
  client: LlamaClient;
  registry: ToolRegistry;
  debugLog: DebugLog;
  /** Retries on a model response that fails JSON extraction or zod validation. */
  maxRetries: number;
  /** Skill-success library (spec 20.2): recent runs seed the few-shots when available. */
  skills?: SkillsRepository;
}

/** How many recent runs to fetch for few-shot seeding (dedupe and the 4-example cap trim it). */
const FEW_SHOT_FETCH = 8;

/** Observability record of the most recent successful LLM call (Phase 12, spec 33's LLM panel). */
export interface LlmCallRecord {
  /** Date.now() when the successful completion started. */
  at: number;
  /** Wall-clock time of that completion's HTTP call. */
  latencyMs: number;
  /** The selected tool name, "respond", the director's task, or the idle goal. */
  tool: string;
  rationale: string | null;
}

/**
 * The LLM Tools -> Skills -> Primitives boundary head. Builds the exact state
 * snapshot, sends it with the structured prompts, and only yields a
 * zod-validated AgentDecision (spec section 16, 42). Invalid output is
 * retried a bounded number of times, never executed.
 */
export class DecisionMaker {
  private readonly client: LlamaClient;
  private readonly registry: ToolRegistry;
  private readonly debugLog: DebugLog;
  private readonly maxRetries: number;
  private readonly skills?: SkillsRepository;
  private lastCallRecord: LlmCallRecord | null = null;

  constructor(options: DecisionMakerOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.debugLog = options.debugLog;
    this.maxRetries = options.maxRetries;
    this.skills = options.skills;
  }

  /** The most recent successful LLM call, or null before the first call. */
  get lastCall(): LlmCallRecord | null {
    return this.lastCallRecord;
  }

  /** Decide the next action for a chat instruction. Throws if the model never returns valid output. */
  async decide(input: DecisionInput, ctx: ToolContext): Promise<AgentDecision> {
    const snapshot = buildStateSnapshot(ctx, input);
    this.logRequest(snapshot);

    // Spec 42: prefer skill-library retrieval when available, static fill otherwise.
    const libraryFewShots = this.skills ? fewShotsFromSkills(this.skills.recent({ limit: FEW_SHOT_FETCH })) : [];
    const messages = buildMessages(snapshot, this.registry.describe(), libraryFewShots);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      const raw = await this.client.complete(messages);
      let decision: AgentDecision;
      try {
        const parsed = extractJson(raw);
        decision = AgentDecisionSchema.parse(parsed);
      } catch (err) {
        lastError = err;
        this.debugLog.write({
          event: "agent_decision_invalid",
          attempt: attempt + 1,
          raw_response: raw,
          error: String(err),
        });
        continue;
      }
      this.logResult(decision, raw, Date.now() - startedAt);
      this.recordLastCall({
        at: startedAt,
        latencyMs: Date.now() - startedAt,
        tool: decision.decision.type === "tool" ? decision.decision.tool : "respond",
        rationale: decision.rationale ?? null,
      });
      return decision;
    }
    throw new Error(`model returned invalid output after ${this.maxRetries + 1} attempts: ${String(lastError)}`);
  }

  /**
   * Background director (spec 4.3): decide the next background task while
   * the bot is idle. Same retry-until-valid loop as a chat decision, but
   * against the director schema and the dispatcher-capable task vocabulary.
   * `situation` is the curated opportunity summary (stockpiles, shortages,
   * storage, recent failures) the background loop measured; the model only
   * ever hears that digest, never raw world dumps.
   */
  async decideNextTask(
    input: DecisionInput,
    ctx: ToolContext,
    situation: string,
  ): Promise<NextTaskDecision> {
    const snapshot = buildStateSnapshot(ctx, input);
    this.logRequest(snapshot, { event: "director_decision", situation });

    const messages = buildDirectorMessages(snapshot, situation);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      const raw = await this.client.complete(messages);
      try {
        const parsed = extractJson(raw);
        const decision = NextTaskSchema.parse(parsed);
        this.logResult(decision, raw, Date.now() - startedAt);
        this.recordLastCall({
          at: startedAt,
          latencyMs: Date.now() - startedAt,
          tool: decision.task.type,
          rationale: decision.rationale ?? null,
        });
        return decision;
      } catch (err) {
        lastError = err;
        this.debugLog.write({
          event: "director_decision_invalid",
          attempt: attempt + 1,
          raw_response: raw,
          error: String(err),
        });
      }
    }
    throw new Error(
      `model returned invalid next task after ${this.maxRetries + 1} attempts: ${String(lastError)}`,
    );
  }

  private logRequest(snapshot: StateSnapshot, extra: Record<string, unknown> = {}): void {
    this.debugLog.write({
      event: "agent_decision",
      ...extra,
      from: snapshot.from,
      instruction: snapshot.instruction,
      /** The exact state object that was sent to the LLM (spec 32.2). */
      state_snapshot: snapshot,
      tools: this.registry.names(),
    });
  }

  private logResult(decision: unknown, raw: string, durationMs: number): void {
    this.debugLog.write({
      event: "agent_decision_result",
      llm_response: raw,
      decision,
      duration_ms: durationMs,
    });
  }

  private recordLastCall(record: LlmCallRecord): void {
    this.lastCallRecord = record;
  }
}

/**
 * Extract the first JSON object from raw model output, tolerating markdown
 * fences and surrounding prose that small local models emit.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in model output: ${text}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
