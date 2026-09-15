import type { Bot } from "mineflayer";
import type { z } from "zod";
import type { MinecraftConfig } from "../config/schema.js";
import type { AgentState } from "../agent/state.js";
import type { Scheduler } from "../agent/scheduler.js";
import type { StockpileManager } from "../agent/maintenance.js";
import type { TasksRepository } from "../memory/tasks.js";
import type { StorageRepository } from "../memory/storage.js";
import type { EventBus } from "../events/bus.js";
import type { BootstrapRunner } from "../skills/bootstrap-survival.js";

/** Deterministic environment a tool handler may act on. */
export interface ToolContext {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  scheduler: Scheduler;
  /** Present when the bootstrap state machine is wired (Phase 5). */
  bootstrap?: BootstrapRunner;
  /**
   * Session-scoped stockpile manager. The LLM context builder reads its last
   * measured snapshot (carried + home-chest stock); never used by tools and
   * never triggers a measurement.
   */
  maintenance?: StockpileManager;
  /** Process-lifetime home-storage registry (registered chest locations). */
  storage?: StorageRepository;
  /** Process-lifetime task store (recent settled outcomes for the LLM digest). */
  tasks?: TasksRepository;
}

/** Tool handlers return a short player-facing reply, or nothing to stay silent. */
export type ToolResult = string | void;
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => ToolResult | Promise<ToolResult>;

/**
 * A registered high-level tool the model may invoke. The LLM only selects these
 * by name; execution is deterministic code (three-layer design).
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON shape shown to the model as argument guidance. */
  args: Record<string, unknown>;
  /** Optional zod schema that every invocation is validated against. */
  argsSchema?: z.ZodTypeAny;
  handler: ToolHandler;
}
