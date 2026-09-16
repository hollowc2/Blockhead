import type { LlamaClient, LlmMessage } from "./client.js";
import { buildStateSnapshot, type DecisionInput, type StateSnapshot } from "./context.js";
import { buildDirectorMessages, buildGoalDecisionMessages, buildMessages, fewShotsFromSkills } from "./prompt.js";
import { AgentDecisionSchema, NextGoalActionSchema, NextTaskSchema, type AgentDecision, type NextGoalActionDecision, type NextTaskDecision } from "./schemas.js";
import type { DebugLog } from "./debug-log.js";
import type { SkillsRepository } from "../memory/skills.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

export interface DecisionMakerOptions { client: LlamaClient; registry: ToolRegistry; debugLog: DebugLog; maxRetries: number; skills?: SkillsRepository; }
export type LlmRuntimeState = "READY" | "PAUSED" | "DEGRADED";
const FEW_SHOT_FETCH = 8;
export interface LlmActivity { thinking: boolean; callType: "owner_instruction" | "background_director" | "goal_decision" | null; startedAt: string | null; }
export interface LlmCallRecord { at: number; latencyMs: number; tool: string; rationale: string | null; success: boolean; error: string | null; }

type ParsedResult<T> = { decision: T; raw: string; startedAt: number };

export class DecisionMaker {
  private readonly client: LlamaClient;
  private readonly registry: ToolRegistry;
  private readonly debugLog: DebugLog;
  private readonly maxRetries: number;
  private readonly skills?: SkillsRepository;
  private lastCallRecord: LlmCallRecord | null = null;
  private readonly activeCalls = new Map<number, { callType: NonNullable<LlmActivity["callType"]>; startedAt: number }>();
  private nextActivityId = 0;
  private runtime: LlmRuntimeState = "READY";
  private lastDecisionKey: string | null = null;
  private repeatedDecisions = 0;
  constructor(options: DecisionMakerOptions) { this.client = options.client; this.registry = options.registry; this.debugLog = options.debugLog; this.maxRetries = options.maxRetries; this.skills = options.skills; }
  get lastCall(): LlmCallRecord | null { return this.lastCallRecord; }
  get activity(): LlmActivity {
    const active = [...this.activeCalls.entries()].at(-1)?.[1];
    return active === undefined
      ? { thinking: false, callType: null, startedAt: null }
      : { thinking: true, callType: active.callType, startedAt: new Date(active.startedAt).toISOString() };
  }
  get runtimeState(): LlmRuntimeState { return this.runtime; }
  resume(): void { this.runtime = "READY"; this.repeatedDecisions = 0; this.lastDecisionKey = null; }

  async decide(input: DecisionInput, ctx: ToolContext): Promise<AgentDecision> {
    return this.withActivity("owner_instruction", async (startedAt) => {
      const snapshot = buildStateSnapshot(ctx, input); this.logRequest(snapshot);
      const shots = this.skills ? fewShotsFromSkills(this.skills.recent({ limit: FEW_SHOT_FETCH })) : [];
      const result = await this.completeWithRepair(AgentDecisionSchema, buildMessages(snapshot, this.registry.describe(), shots), "agent_decision");
      const decision = result.decision as AgentDecision;
      this.noteDecision(decision);
      this.logResult(decision, result.raw, Date.now() - startedAt);
      this.recordLastCall({ at: startedAt, latencyMs: Date.now() - startedAt, tool: decision.decision.type === "tool" ? decision.decision.tool : "respond", rationale: concise(decision.rationale), success: true, error: null });
      return decision;
    });
  }

  async decideNextTask(input: DecisionInput, ctx: ToolContext, situation: string): Promise<NextTaskDecision> {
    return this.withActivity("background_director", async (startedAt) => {
      const snapshot = buildStateSnapshot(ctx, input); this.logRequest(snapshot, { event: "director_decision", situation });
      const result = await this.completeWithRepair(NextTaskSchema, buildDirectorMessages(snapshot, situation), "director_decision");
      const decision = result.decision as NextTaskDecision;
      this.noteDecision(decision);
      this.logResult(decision, result.raw, Date.now() - startedAt);
      this.recordLastCall({ at: startedAt, latencyMs: Date.now() - startedAt, tool: decision.task.type, rationale: concise(decision.rationale), success: true, error: null });
      return decision;
    });
  }

  async decideGoalAction(input: DecisionInput, ctx: ToolContext, context: string): Promise<NextGoalActionDecision> {
    return this.withActivity("goal_decision", async (startedAt) => {
      const snapshot = buildStateSnapshot(ctx, input); this.logRequest(snapshot, { event: "goal_decision", goal_context: context });
      const result = await this.completeWithRepair(NextGoalActionSchema, buildGoalDecisionMessages(snapshot, context), "goal_decision");
      const decision = result.decision as NextGoalActionDecision;
      this.noteDecision(decision);
      this.logResult(decision, result.raw, Date.now() - startedAt);
      this.recordLastCall({ at: startedAt, latencyMs: Date.now() - startedAt, tool: decision.action.type === "complete" ? "complete_goal" : decision.action.type === "abandon" ? "abandon_goal" : decision.action.type, rationale: concise(decision.rationale), success: true, error: null });
      return decision;
    });
  }

  private async withActivity<T>(callType: NonNullable<LlmActivity["callType"]>, action: (startedAt: number) => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const id = this.nextActivityId++;
    this.activeCalls.set(id, { callType, startedAt });
    try { return await action(startedAt); }
    catch (error) {
      this.recordLastCall({ at: startedAt, latencyMs: Date.now() - startedAt, tool: "unknown", rationale: null, success: false, error: conciseError(error) });
      throw error;
    } finally { this.activeCalls.delete(id); }
  }

  private async completeWithRepair<T extends object>(schema: { parse(input: unknown): T }, initial: LlmMessage[], eventPrefix: string): Promise<ParsedResult<T>> {
    let messages = initial;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      let raw: string;
      try {
        raw = await this.client.complete(messages);
      } catch (error) {
        this.runtime = "DEGRADED";
        throw error;
      }
      let parsed: unknown;
      try { parsed = extractJson(raw); }
      catch (err) {
        lastError = err;
        this.debugLog.write({ event: `${eventPrefix}_parse_error`, attempt: attempt + 1, raw_response: raw, error: String(err) });
        if (attempt < this.maxRetries) messages = repairMessages(messages, raw, String(err), "valid JSON");
        continue;
      }
      try {
        const decision = schema.parse(parsed);
        if (attempt > 0) this.debugLog.write({ event: `${eventPrefix}_corrected_retry_success`, attempt: attempt + 1 });
        return { decision, raw, startedAt };
      } catch (err) {
        lastError = err;
        this.debugLog.write({ event: `${eventPrefix}_schema_validation_failure`, attempt: attempt + 1, raw_response: raw, error: String(err) });
        if (attempt < this.maxRetries) messages = repairMessages(messages, raw, String(err), "the expected JSON schema");
      }
    }
    this.runtime = "PAUSED";
    throw new Error(`model returned invalid output after ${this.maxRetries + 1} attempts: ${String(lastError)}`);
  }

  private noteDecision(decision: unknown): void {
    const key = JSON.stringify(decision);
    if (key === this.lastDecisionKey) this.repeatedDecisions++;
    else { this.lastDecisionKey = key; this.repeatedDecisions = 0; }
    if (this.repeatedDecisions >= 3) {
      this.runtime = "PAUSED";
      throw new Error("repeated identical model decisions exceeded retry budget");
    }
    this.runtime = "READY";
  }

  private logRequest(snapshot: StateSnapshot, extra: Record<string, unknown> = {}): void { this.debugLog.write({ event: "agent_decision", ...extra, from: snapshot.from, instruction: snapshot.instruction, state_snapshot: snapshot, tools: this.registry.names() }); }
  private logResult(decision: unknown, raw: string, durationMs: number): void { this.debugLog.write({ event: "agent_decision_result", llm_response: raw, decision, duration_ms: durationMs }); }
  private recordLastCall(record: LlmCallRecord): void { this.lastCallRecord = record; }
}

function concise(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function conciseError(error: unknown): string {
  const message = concise(error instanceof Error ? error.message : String(error)) ?? "unknown error";
  return message.replace(/\b(api[_ -]?key|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function repairMessages(messages: readonly LlmMessage[], raw: string, error: string, shape: string): LlmMessage[] {
  return [...messages, { role: "assistant", content: raw }, { role: "user", content: `Your previous response was invalid: ${error}. Return only ${shape}. Do not include markdown, prose, or any other structure.` }];
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{"); const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}
