import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Logger } from "pino";
import { Vec3 } from "vec3";
import type { AgentState } from "../agent/state.js";
import type { TaskSignals } from "../agent/scheduler.js";
import type { MinecraftConfig } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import type { StorageRepository } from "../memory/storage.js";
import type { ResourceSitesRepository } from "../memory/resource-sites.js";
import type { SkillsRepository } from "../memory/skills.js";
import { bareName, countItem, countLogs, countPlanks, itemsSummary } from "../minecraft/inventory.js";
import { craftItem, craftPlanks, craftSticks } from "../minecraft/crafting.js";
import { deliverCarried } from "../minecraft/containers.js";
import { travelAndWait } from "../minecraft/movement.js";
import { collectBlocks, findBlockNear, findBlocksNear, findBlocksNearPoint, isRawLog } from "../minecraft/world.js";
import { normalizeDimension, regionContains } from "../minecraft/protection.js";
import { checkLavaEntry, isStraightDownTarget, lavaAvoidanceRadius } from "../policy/safety.js";
import { classifyBlock } from "../policy/protection.js";
import { cancelCollection } from "../minecraft/primitives.js";
import {
  ChatThrottle,
  expansionMessage,
  gameChatBudgetAllows,
  resourceLabel,
  resourceStem,
  SEARCH_RADIUS_SEQUENCE,
  withTimeout,
  type SkillErrorCode,
  type SkillResult,
} from "./skill-library.js";
import {
  distanceFromHome,
  expeditionThreshold,
  ExpeditionTracker,
  tierForDistance,
  TOOL_FAMILIES,
  toolFamilyFor,
} from "./expedition.js";

/**
 * Phase 6: resource gathering (spec sections 12.2, 23, 27).
 *
 * `collect_resource(resource, quantity)` deterministically finds, gathers,
 * and delivers `quantity` of a resource to the home chest, speaking only on
 * task acceptance (reply), search expansion (spec 12.2 contract), tool
 * replacement, and completion. The LLM never steers the mechanics; it only
 * invokes the registered `collect_resource` tool.
 *
 * Internal stages (spec 27):
 *   1. quantity already carried -> remaining target
 *   3. known resource sites (spec 21.8), then
 *   4-7. expanding search around the run's start position with the uniform
 *        radius contract, selecting reachable candidates
 *   6. equipment ensured before the first pass (tool replacement mid-run)
 *   7-9. travel, gather (mineflayer-collectblock + mineflayer-tool), recalc
 *   10-12. full inventory / equipment failure / danger aborts
 *   13. loop until the target is met or every radius is exhausted
 *   then: return home, deposit into the home chest (spec 23), announce
 *         completion, return a structured SkillResult, and on full success
 *         record a SkillSuccess (spec 20.2).
 */

// --- deterministic policy constants ---

/** Wall-clock budget for one home/site trip. */
const TRAVEL_TIMEOUT_MS = 120_000;
/** Wall-clock budget for one block-collection pass. */
const COLLECT_TIMEOUT_MS = 240_000;
/** Blocks scanned around the bot when working one site. */
const GATHER_RADIUS = 48;
/** Nearest blocks handed to collectBlock in one pass. */
const GATHER_BLOCKS_PER_PASS = 12;
/** Max passes worked from one position before declaring the site exhausted. */
const MAX_PASSES_PER_SITE = 6;
/** Candidate blocks returned per search radius. */
const SITE_CANDIDATES_PER_RADIUS = 24;
/** Scan radius for the home crafting table when a tool must be crafted. */
const TABLE_SCAN_RADIUS = 12;

/**
 * Blocks whose mined drop has a different item name than the block itself.
 * Ores drop their raw material ("coal_ore" -> coal, "iron_ore" -> raw_iron)
 * and plain stone drops cobblestone; everything else drops an item of the
 * same name, so the map degrades to identity.
 */
const DROPPED_ITEM_BY_BLOCK: Record<string, string> = {
  stone: "cobblestone",
  coal_ore: "coal",
  deepslate_coal_ore: "coal",
  iron_ore: "raw_iron",
  deepslate_iron_ore: "raw_iron",
  copper_ore: "raw_copper",
  deepslate_copper_ore: "raw_copper",
  gold_ore: "raw_gold",
  deepslate_gold_ore: "raw_gold",
  diamond_ore: "diamond",
  deepslate_diamond_ore: "diamond",
  emerald_ore: "emerald",
  deepslate_emerald_ore: "emerald",
  lapis_ore: "lapis_lazuli",
  deepslate_lapis_ore: "lapis_lazuli",
  redstone_ore: "redstone",
  deepslate_redstone_ore: "redstone",
};

/**
 * The carried item a `collect_resource` run accounts for and delivers. The
 * run counts *drops* ("coal" after mining "coal_ore"), never the requested
 * block name, so the quantity math sees real progress. Exported so the
 * combine skills (ensure_item) can count the same way.
 */
export function carriedItemName(resource: string): string {
  return DROPPED_ITEM_BY_BLOCK[bareName(resource)] ?? bareName(resource);
}

/** True when at least one member of the family is carried. */
function hasFamilyTool(bot: Bot, family: "axe" | "pickaxe"): boolean {
  return TOOL_FAMILIES[family].some((name) => countItem(bot, name) > 0);
}

/** True when a block yields the requested resource when broken. */
function blockMatchesResource(block: Block, resource: string): boolean {
  if (block.name === resource) return true;
  // Coal/iron/copper/... ores have deepslate variants dropping the same item.
  return resource.endsWith("_ore") && block.name === `deepslate_${resource}`;
}

/** True when the requested resource is a block CobbleBob can find in the world. */
function isGatherableBlock(bot: Bot, resource: string): boolean {
  return bot.registry.blocksByName[resource] !== undefined;
}

/** Result of the equipment stage. */
interface ToolCheck {
  ok: true;
  /** Bare hands are a slow-but-working fallback for axe-family resources. */
  fallback: boolean;
}

export interface CollectResourceOptions {
  bot: Bot;
  state: AgentState;
  config: MinecraftConfig;
  bus: EventBus;
  /** Home storage registration (spec 22): the chest gathered items land in. */
  storage: StorageRepository;
  /** Known resource sites (spec 21.8), consulted first and recorded after gains. */
  sites: ResourceSitesRepository;
  /** Skill success records (spec 20.2). */
  skills: SkillsRepository;
  logger: Logger;
}

export interface CollectResourceData {
  resource: string;
  quantity: number;
  /** Carried when the run started (before tooling). */
  carriedAtStart: number;
  /** Net gained this run: carried at return minus carriedAtStart. */
  gathered: number;
  /** Carried of the resource when arriving home. */
  carried: number;
  /** Amount deposited into the home chest. */
  delivered: number;
  sitesVisited: number;
  expansionCount: number;
  /** True when the run operated under expedition policy (Phase 9). */
  expedition: boolean;
  /** Times this task was cooperatively interrupted (Phase 8, persisted across resumes). */
  interruptions: number;
}

/**
 * Progress persisted as the task's resume state (Phase 8, spec 5.3). A
 * paused run resumes with the same resource/quantity, skipping every site it
 * already attempted, and carrying the accumulated interruption count so the
 * final SkillSuccess record is honest.
 */
export interface CollectResumeState {
  resource: string;
  quantity: number;
  attemptedSites: string[];
  interruptions: number;
}

export interface CollectRunOptions {
  /** Cooperative signals from the owning scheduler task; null for unbound runs. */
  signals?: TaskSignals;
  /** Resume state from a paused run of the same task. */
  resumeState?: CollectResumeState;
  /**
   * True when the owner explicitly requested this gather (spec 8.2: structural
   * blocks inside the protected home region need an explicit request before
   * they may be broken). Background maintenance never passes this, so it can
   * never touch the protected region's structures.
   */
  userRequested?: boolean;
}

/** Abort reasons the outer loop breaks on (spec 27 stages 10, 11, and 12). */
interface Abort {
  errorCode: Extract<SkillErrorCode, "INVENTORY_FULL" | "DANGER_TOO_HIGH" | "TOOL_REQUIRED" | "EXPEDITION_BLOCKED" | "PROTECTED_REGION">;
  reason: string;
}

/**
 * Deterministic `collect_resource` skill. One run at a time; the tool handler
 * refuses to stack a second request (`isRunning`).
 */
export class CollectResourceRunner {
  private running = false;
  private startedAt: number | null = null;

  /** Cooperative signals for the current run; null when unbound. */
  private signals: TaskSignals | null = null;
  /** Sites already attempted by a paused run of this task, resumed from. */
  private resumeAttempted: readonly string[] = [];
  /** Sites attempted this run (and any paused predecessor). */
  private attempted: Set<string> = new Set();
  /** True once a pause/cancel was observed; helpers stop volunteering work. */
  private stopRequested = false;
  /** Accumulated interrupts across pause/resume cycles of this task. */
  private interruptions = 0;
  private currentResource = "";
  private currentQuantity = 0;
  /** Whether the current run was explicitly requested by the owner (policy). */
  private userRequested = false;

  /** Phase 9: expedition lifecycle for the current run (spec 12). */
  private readonly expedition: ExpeditionTracker;

  /** Identical game-chat lines repeat at most once per window (spam-kick guard). */
  private readonly chatThrottle: ChatThrottle;

  constructor(private readonly opts: CollectResourceOptions) {
    this.expedition = new ExpeditionTracker(opts.bus, opts.logger);
    const throttleSeconds = opts.config.background?.announce_throttle_seconds ?? 30;
    this.chatThrottle = new ChatThrottle(throttleSeconds * 1000);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start gathering `quantity` of `resource`, resolving when the run ends. */
  async run(resource: string, quantity: number, options: CollectRunOptions = {}): Promise<SkillResult<CollectResourceData>> {
    if (this.running) {
      return {
        ok: false,
        status: "blocked",
        errorCode: "ALREADY_RUNNING",
        message: `already gathering ${resourceLabel(resource)}`,
      };
    }
    this.running = true;
    this.startedAt = Date.now();
    this.signals = options.signals ?? null;
    this.resumeAttempted = options.resumeState?.attemptedSites ?? [];
    this.interruptions = options.resumeState?.interruptions ?? 0;
    this.stopRequested = false;
    this.expedition.reset();
    this.currentResource = bareName(resource);
    this.currentQuantity = quantity;
    this.userRequested = options.userRequested === true;
    try {
      return await this.execute(resource, quantity);
    } finally {
      this.running = false;
      this.signals = null;
      this.resumeAttempted = [];
      this.attempted = new Set();
    }
  }

  private async execute(resource: string, quantity: number): Promise<SkillResult<CollectResourceData>> {
    const bot = this.opts.bot;
    const startedAt = Date.now();
    const baseline = itemsSummary(bot);
    const bare = bareName(resource);
    const stem = resourceStem(bare);
    const label = resourceLabel(bare);
    const carriedName = carriedItemName(bare);
    const data: CollectResourceData = {
      resource: bare,
      quantity,
      carriedAtStart: countItem(bot, carriedName),
      gathered: 0,
      carried: 0,
      delivered: 0,
      sitesVisited: 0,
      expansionCount: 0,
      expedition: false,
      interruptions: this.interruptions,
    };

    if (bot.entity === null) {
      return this.fail(data, "NOT_READY", "bot is not spawned");
    }
    if (!isGatherableBlock(bot, bare)) {
      return this.fail(data, "INVALID_RESOURCE", `'${resource}' is not a mineable block`);
    }

    this.opts.bus.emit("resource.gather.started", { resource: bare, quantity });

    const self = bot.entity;
    const anchor = self.position.floored();
    let carried = countItem(bot, carriedName);
    let remaining = Math.max(0, quantity - carried);
    if (remaining === 0) {
      this.opts.logger.info({ resource: bare, quantity }, "already carrying the requested quantity; going straight to delivery");
    }

    // Stage 6: ensure equipment before the first gather pass.
    if (remaining > 0) {
      const tool = await this.ensureTool(bare);
      if (this.stopRequested) return this.interrupted(data);
      if (!tool.ok) {
        return this.fail(data, "TOOL_REQUIRED", tool.reason);
      }
      carried = countItem(bot, carriedName);
      remaining = Math.max(0, quantity - carried);
    }

    // Stages 3-13: known sites, then the expanding search. A resumed run
    // skips every site its paused predecessor already attempted.
    let abort: Abort | null = null;
    const attempted = new Set<string>(this.resumeAttempted);
    this.attempted = attempted;

    if (remaining > 0) {
      abort = await this.gatherFromKnownSites(carriedName, bare, quantity, attempted, data);
    }
    if (this.stopRequested) return this.interrupted(data);
    if (remaining > 0 && abort === null) {
      abort = await this.gatherFromSearch(anchor, carriedName, bare, quantity, attempted, data);
    }
    if (this.stopRequested) return this.interrupted(data);

    carried = countItem(bot, carriedName);
    data.carried = carried;
    data.gathered = Math.max(0, carried - data.carriedAtStart);

    // Return home, then deposit (spec 23). Always attempted on every run that
    // could pick anything up, so partial results still deliver. An interrupted
    // (paused) run skips the deposit: carrying the partials lets the resume
    // finish the target and deliver once, and a cancel keeps them in inventory
    // exactly as the player asked.
    const home = this.opts.state.home;
    const sameDimension = home !== null && normalizeDimension(bot.game.dimension ?? "") === home.dimension;
    if (sameDimension) {
      const returned = await this.returnHome();
      if (this.stopRequested) return this.interrupted(data);
      if (returned.status !== "arrived" && returned.status !== "already_there") {
        // Travel failure: log, keep items, report delivery as impossible.
        this.opts.logger.warn({ status: returned.status }, "could not return home to deliver");
      } else if (carried > 0 || data.carriedAtStart > 0) {
        const delivered = await deliverCarried(bot, this.opts.state, this.opts.storage, carriedName, this.opts.logger);
        if (delivered.delivered > 0) data.delivered = delivered.delivered;
      }
      // Phase 9: the run is home — end expedition mode with its status message
      // (no-op when the run never left the threshold, or when home is unreachable).
      this.expedition.leave(bot, this.opts.state.home, expeditionThreshold(this.opts.config));
    }
    if (this.stopRequested) return this.interrupted(data);

    const targetMet = carried >= quantity;
    const deliveredAll = data.delivered === Math.max(carried, data.carriedAtStart) && data.delivered > 0;
    const summary: SkillResult<CollectResourceData> = {
      ok: targetMet && deliveredAll,
      status: targetMet && deliveredAll ? "completed" : "partial",
      data,
      errorCode: undefined,
      message: undefined,
      retryable: !targetMet || !deliveredAll,
    };

    if (targetMet && deliveredAll) {
      this.announce(`Done. ${carried} ${label} in the chest.`);
      this.recordSuccess(bare, quantity, startedAt, baseline, data);
      this.opts.bus.emit("resource.gather.complete", {
        resource: bare,
        quantity,
        gathered: data.gathered,
        delivered: data.delivered,
        status: "completed",
      });
      return summary;
    }

    // Terminal message depends on what actually went wrong.
    if (targetMet) {
      const reason = !sameDimension
        ? `home is in another dimension`
        : data.delivered === 0
          ? "no chest at home to deposit into"
          : "could not deposit everything into the home chest";
      summary.status = "partial";
      summary.errorCode = "STORAGE_NOT_FOUND";
      summary.message = reason;
      this.announce(`Done. ${carried} ${label} gathered, but ${reason}.`);
    } else if (abort !== null) {
      summary.status = carried > 0 ? "partial" : "failed";
      summary.errorCode = abort.errorCode;
      summary.message = abort.reason;
      this.announce(carried > 0 ? `Got ${carried}/${quantity} ${label}. ${abortReason(abort, this.expedition.isActive)}` : `Stuck: ${abort.reason}.`);
    } else {
      summary.status = carried > 0 ? "partial" : "failed";
      summary.errorCode = "RESOURCE_NOT_FOUND";
      summary.message = `only ${carried}/${quantity} ${label} found nearby`;
      this.announce(
        carried > 0
          ? `Got ${carried}/${quantity} ${label}. No more ${stem} nearby.`
          : `No ${stem} within ${SEARCH_RADIUS_SEQUENCE[SEARCH_RADIUS_SEQUENCE.length - 1]} blocks.`,
      );
    }

    this.opts.bus.emit(
      summary.status === "failed" ? "resource.gather.failed" : "resource.gather.complete",
      summary.status === "failed"
        ? { resource: bare, quantity, reason: summary.message ?? "unknown" }
        : { resource: bare, quantity, gathered: data.gathered, delivered: data.delivered, status: summary.status },
    );
    return summary;
  }

  // --- Phase 8 cooperative interrupt plumbing ---

  /**
   * Poll the task signals once and remember the result. Safe to call from
   * any loop iteration; after the first stop request every later call is a
   * no-op, so helpers bail at their next natural boundary.
   */
  private checkInterrupt(): void {
    if (this.stopRequested || this.signals === null) return;
    const payload: CollectResumeState = {
      resource: this.currentResource,
      quantity: this.currentQuantity,
      attemptedSites: [...this.attempted],
      interruptions: this.interruptions + 1,
    };
    if (!this.signals.checkpoint(payload)) {
      this.stopRequested = true;
      this.interruptions += 1;
    }
  }

  /** Abort probe for travel waits: polls the signals while the bot walks. */
  private travelAbort = (): boolean => {
    this.checkInterrupt();
    return this.stopRequested;
  };

  /** Terminal result for a paused/cancelled run. Partials stay carried. */
  private interrupted(data: CollectResourceData): SkillResult<CollectResourceData> {
    data.carried = countItem(this.opts.bot, carriedItemName(data.resource));
    data.gathered = Math.max(0, data.carried - data.carriedAtStart);
    data.interruptions = this.interruptions;
    this.opts.logger.info({ resource: data.resource }, "collect_resource interrupted");
    this.opts.bus.emit("resource.gather.complete", {
      resource: data.resource,
      quantity: data.quantity,
      gathered: data.gathered,
      delivered: data.delivered,
      status: "interrupted",
    });
    return { ok: false, status: "interrupted", retryable: true, data, message: "interrupted" };
  }

  // --- stages 3-13: the gather loop ---

  /** Stage 3: try known, non-depleted sites before searching fresh terrain. */
  private async gatherFromKnownSites(
    carriedName: string,
    bare: string,
    quantity: number,
    attempted: Set<string>,
    data: CollectResourceData,
  ): Promise<Abort | null> {
    const worldId = this.opts.state.worldId;
    const dimension = normalizeDimension(this.opts.bot.game.dimension ?? "");
    if (worldId === null) return null;

    let carried = countItem(this.opts.bot, carriedName);
    for (const site of this.opts.sites.listByResource(worldId, dimension, bare)) {
      this.checkInterrupt();
      if (this.stopRequested) return null;
      if (carried >= quantity) return null;
      const key = `${site.x},${site.y},${site.z}`;
      if (attempted.has(key)) continue;
      attempted.add(key);

      // Spec 8.2: structural blocks inside the protected home region need an
      // explicit request. Background maintenance (and a director without one)
      // never gathers them there; the run logs and moves on.
      const protectedPoint = this.opts.state.protectedRegion;
      if (protectedPoint !== null && regionContains(protectedPoint, { x: site.x, y: site.y, z: site.z })) {
        if (classifyBlock(bare) !== "terrain" && !this.userRequested) {
          this.opts.logger.info({ resource: bare, site: key }, "skipping a protected-region structural site without an explicit request");
          continue;
        }
      }

      data.sitesVisited += 1;
      const visit = await this.gatherAtSite(new Vec3(site.x, site.y, site.z), bare, carriedName);
      carried = countItem(this.opts.bot, carriedName);
      if (visit.gained > 0) {
        this.recordSite(site.x, site.y, site.z, bare, dimension);
      } else {
        this.opts.sites.markDepleted(worldId, site.id);
        this.opts.logger.info({ site: site.id, resource: bare }, "known site yielded nothing; marked depleted");
      }
      if (visit.abort !== null) return visit.abort;
    }
    return null;
  }

  /**
   * Stages 4-7 + 13: expand the search through the uniform radius sequence
   * anchored at the run's start position (spec 12.2). Each radius that finds
   * nothing (or gains nothing) announces the contract's expansion message
   * exactly once.
   */
  private async gatherFromSearch(
    anchor: Vec3,
    carriedName: string,
    bare: string,
    quantity: number,
    attempted: Set<string>,
    data: CollectResourceData,
  ): Promise<Abort | null> {
    const bot = this.opts.bot;
    const region = this.opts.state.protectedRegion;
    const stem = resourceStem(bare);

    let carried = countItem(bot, carriedName);
    const threshold = expeditionThreshold(this.opts.config);
    const family = toolFamilyFor(bare);
    for (const radius of SEARCH_RADIUS_SEQUENCE) {
      this.checkInterrupt();
      if (this.stopRequested) return null;
      if (carried >= quantity) return null;
      const abort = await this.checkAbort();
      if (abort !== null) return abort;

      // Phase 9 (spec 12): a radius beyond the expedition threshold first runs
      // the supply check. Refusal stops the expansion cold — the run returns
      // home with what it has instead of wandering out unprepared.
      if (radius > threshold) {
        const entered = this.expedition.enter({ bot, home: this.opts.state.home, threshold, toolFamily: family });
        if (!entered.ok) {
          this.announce(`Not traveling beyond ${threshold} blocks from home: ${entered.failures[0]}.`);
          return {
            errorCode: "EXPEDITION_BLOCKED",
            reason: `supplies insufficient to search beyond ${threshold} blocks from home: ${entered.failures[0]}`,
          };
        }
        data.expedition = true;
      }

      const found = findBlocksNearPoint(bot, anchor, (block) => blockMatchesResource(block, bare), radius, SITE_CANDIDATES_PER_RADIUS)
        .filter((position) => !attempted.has(`${position.x},${position.y},${position.z}`));
      const outside = region ? found.filter((v) => !regionContains(region, { x: v.x, y: v.y, z: v.z })) : found;
      let candidates = outside.length > 0 ? outside : found;
      // Spec 8.2 policy: structural blocks inside the protected home region are
      // only gathered with an explicit owner request. Natural terrain (trees,
      // stone, ores) stays available to the bot's own rails.
      if (outside.length === 0 && found.length > 0 && classifyBlock(bare) !== "terrain" && !this.userRequested) {
        // The only matches are protected structures: refuse with a structured
        // veto the model sees on the next decision instead of "not found".
        this.announce(`Not touching ${resourceLabel(bare)} inside the protected home region: PROTECTED_REGION.`);
        return {
          errorCode: "PROTECTED_REGION",
          reason: `${resourceLabel(bare)} was only found inside the protected home region`,
        };
      }
      if (candidates.length === 0) {
        this.announce(expansionMessage(stem, radius));
        data.expansionCount += 1;
        continue;
      }

      let gainedThisRadius = 0;
      for (const position of candidates) {
        this.checkInterrupt();
        if (this.stopRequested) return null;
        if (carried >= quantity) return null;
        const key = `${position.x},${position.y},${position.z}`;
        if (attempted.has(key)) continue;
        attempted.add(key);

        data.sitesVisited += 1;
        const visit = await this.gatherAtSite(position, bare, carriedName);
        gainedThisRadius += visit.gained;
        carried = countItem(bot, carriedName);
        if (visit.gained > 0) {
          const dimension = normalizeDimension(bot.game.dimension ?? "");
          this.recordSite(position.x, position.y, position.z, bare, dimension);
        }
        if (visit.abort !== null) return visit.abort;
      }

      if (carried < quantity && gainedThisRadius === 0) {
        this.announce(expansionMessage(stem, radius));
        data.expansionCount += 1;
      }
    }
    return null;
  }

  /**
   * Stage 7-9: travel to one candidate and work it until no progress.
   * A zero-gain pass with a missing pickaxe-family tool means it broke: the
   * replacement is announced (spec 3) and re-crafted before retrying.
   */
  private async gatherAtSite(
    position: Vec3,
    bare: string,
    carriedName: string,
  ): Promise<{ gained: number; abort: Abort | null }> {
    const bot = this.opts.bot;
    const family = toolFamilyFor(bare);

    // Spec 34: never intentionally enter known lava. A candidate standing in
    // (or right beside) lava is skipped, not worked around.
    if (!checkLavaEntry(bot, position, lavaAvoidanceRadius(this.opts.config)).allowed) {
      this.opts.logger.info(
        { at: [position.x, position.y, position.z], resource: bare },
        "skipping a candidate beside lava",
      );
      return { gained: 0, abort: null };
    }

    const travel = await travelAndWait(bot, position, {
      timeoutMs: TRAVEL_TIMEOUT_MS,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return { gained: 0, abort: null };
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      this.opts.logger.debug({ status: travel.status }, "skipping an unreachable candidate");
      return { gained: 0, abort: null };
    }

    let gained = 0;
    for (let pass = 0; pass < MAX_PASSES_PER_SITE; pass++) {
      this.checkInterrupt();
      if (this.stopRequested) return { gained, abort: null };
      const abort = await this.checkAbort();
      if (abort !== null) return { gained, abort };

      const self = bot.entity;
      const targets = findBlocksNear(bot, (block) => blockMatchesResource(block, bare), GATHER_RADIUS, GATHER_BLOCKS_PER_PASS)
        .map((v) => bot.blockAt(v))
        .filter((block) => block !== null)
        // Spec 34: never dig straight down blindly — a target directly beneath
        // the feet is skipped; the bot digs sideways instead.
        .filter((block) => self === null || !isStraightDownTarget(block.position, self.position));
      if (targets.length === 0) return { gained, abort: null };

      const before = countItem(bot, carriedName);
      try {
        await withTimeout(COLLECT_TIMEOUT_MS, bot.collectBlock.collect(targets, { ignoreNoPath: true }), async () => {
          await cancelCollection(bot);
        }, this.signals?.signal);
      } catch (err) {
        this.opts.logger.warn({ err: String(err), resource: bare }, "collect pass failed");
        if (family === "pickaxe" && !hasFamilyTool(bot, family)) {
          const replaced = await this.replaceTool(family);
          if (!replaced.ok) return { gained, abort: { errorCode: "TOOL_REQUIRED", reason: replaced.reason } };
          continue;
        }
        return { gained, abort: null };
      }

      const after = countItem(bot, carriedName);
      const delta = Math.max(0, after - before);
      gained += delta;
      if (delta === 0) {
        // No progress: an absent pickaxe-family tool is a breakage to fix;
        // anything else means the site around us is exhausted.
        if (family === "pickaxe" && !hasFamilyTool(bot, family)) {
          const replaced = await this.replaceTool(family);
          if (!replaced.ok) return { gained, abort: { errorCode: "TOOL_REQUIRED", reason: replaced.reason } };
          continue;
        }
        return { gained, abort: null };
      }
    }
    return { gained, abort: null };
  }

  /**
   * Stages 10 and 12: inventory and health guards before each pass. Phase 9:
   * the floors come from the distance-aware risk tier, so the farther the bot
   * is from home, the healthier it must stay and the more inventory headroom
   * it must keep — the return trip is longer with every block.
   */
  private async checkAbort(): Promise<Abort | null> {
    const bot = this.opts.bot;
    const threshold = expeditionThreshold(this.opts.config);
    const distance = distanceFromHome(bot, this.opts.state.home);
    const tier = tierForDistance(distance, threshold);
    if (bot.health <= tier.minHealth) {
      return {
        errorCode: "DANGER_TOO_HIGH",
        reason: `health ${bot.health} is at or below the ${tier.name}-range floor ${tier.minHealth}`,
      };
    }
    if (bot.inventory.emptySlotCount() < tier.minFreeSlots) {
      return {
        errorCode: "INVENTORY_FULL",
        reason: `free slots are below the ${tier.name}-range floor (need ${tier.minFreeSlots})`,
      };
    }
    return null;
  }

  // --- stages 6 and 11: equipment ---

  /**
   * Stage 6: make sure an appropriate tool is carried before gathering.
   * Axe-family resources fall back to bare hands (slow but functional) when a
   * tool cannot be crafted; pickaxe-family resources never progress by hand,
   * so a missing pickaxe blocks with TOOL_REQUIRED.
   */
  private async ensureTool(bare: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const family = toolFamilyFor(bare);
    if (family === null || hasFamilyTool(this.opts.bot, family)) return { ok: true };
    return this.craftWoodenTool(family);
  }

  /** Stage 11: announce and re-craft a tool that broke mid-run. */
  private async replaceTool(family: "axe" | "pickaxe"): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.announce(`${family[0]?.toUpperCase()}${family.slice(1)} broke. Replacing it.`);
    return this.craftWoodenTool(family);
  }

  /** Craft a wooden tool of `family` at the home crafting table. */
  private async craftWoodenTool(family: "axe" | "pickaxe"): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    const home = this.opts.state.home;
    if (home === null) return { ok: false, reason: "no home to craft a tool at" };

    const travel = await travelAndWait(bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (travel.status !== "arrived" && travel.status !== "already_there") {
      return { ok: false, reason: `could not reach home to craft a ${family}: ${travel.status}` };
    }

    const table = findBlockNear(bot, "crafting_table", TABLE_SCAN_RADIUS);
    if (table === null) return { ok: false, reason: "no crafting table at home" };
    const tableTravel = await travelAndWait(bot, table.position, {
      timeoutMs: TRAVEL_TIMEOUT_MS,
      range: 1,
      shouldAbort: this.travelAbort,
      signal: this.signals?.signal,
    });
    if (this.stopRequested) return { ok: false, reason: "interrupted" };
    if (tableTravel.status !== "arrived" && tableTravel.status !== "already_there") {
      return { ok: false, reason: "could not reach the crafting table" };
    }

    // A wooden tool needs 3 planks + 2 sticks (another 2 planks); when no
    // logs or planks survive (a wiped inventory, a tool that broke in the
    // field), gather logs for them first — otherwise the craft dies here
    // and the run aborts before its search ever starts.
    const logsNeeded = Math.max(0, Math.ceil((3 + 2 - countPlanks(bot)) / 4) - countLogs(bot));
    if (logsNeeded > 0) {
      const gathered = await this.gatherLogsForTool(logsNeeded);
      if (!gathered.ok) return { ok: false, reason: gathered.reason };
    }
    const planks = await craftPlanks(bot, countPlanks(bot) + 3);
    if (!planks.ok) return { ok: false, reason: planks.reason };
    const sticks = await craftSticks(bot, countItem(bot, "stick") + 2);
    if (!sticks.ok) return { ok: false, reason: sticks.reason };

    const made = await craftItem(bot, `wooden_${family}`, { craftingTable: table });
    if (!made.ok) return { ok: false, reason: made.reason };
    return { ok: true };
  }

  /**
   * Gather raw logs until at least `targetTotal` are carried — the
   * tool-craft fallback when the bot reaches the table with no planks or
   * logs. Same expanding search-and-collect mechanics as the bootstrap WOOD
   * stage; per-block collection skips sites the pathfinder cannot reach
   * instead of failing the pass.
   */
  private async gatherLogsForTool(targetTotal: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bot = this.opts.bot;
    let have = countLogs(bot);
    for (const radius of SEARCH_RADIUS_SEQUENCE) {
      this.checkInterrupt();
      if (this.stopRequested) return { ok: false, reason: "interrupted" };
      const positions = findBlocksNear(bot, isRawLog, radius, 24);
      const targets = positions.map((position) => bot.blockAt(position)).filter((block) => block !== null);
      if (targets.length === 0) continue;

      const before = have;
      await collectBlocks(
        bot,
        targets,
        () => countLogs(bot),
        targetTotal,
        (msg) => this.announce(msg),
        COLLECT_TIMEOUT_MS,
        (block, err) => this.opts.logger.warn({ at: block.position, err: String(err) }, "skipping unreachable log"),
      );
      have = countLogs(bot);
      if (have <= before) continue;
    }
    have = countLogs(bot);
    if (have < targetTotal) return { ok: false, reason: `only ${have}/${targetTotal} logs found nearby` };
    return { ok: true };
  }

  // --- delivery (spec 23) ---

  /** Walk home; used by every run that gathered anything. */
  private async returnHome(): Promise<{ status: string }> {
    const home = this.opts.state.home;
    if (home === null) return { status: "no_home" };
    return travelAndWait(this.opts.bot, home, {
      dimension: home.dimension,
      timeoutMs: TRAVEL_TIMEOUT_MS,
      shouldAbort: this.travelAbort,
    });
  }

  // --- memory and reporting ---

  private recordSite(x: number, y: number, z: number, bare: string, dimension: string): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    this.opts.sites.register(worldId, { dimension, resource: bare, x, y, z });
  }

  /**
   * Stage 15: persist one SkillSuccess for a fully completed gather (spec
   * 20.2). The inventory delta is measured against the run's own baseline
   * (the delivered items leave the carried inventory, so the record is small
   * but honest).
   */
  private recordSuccess(
    bare: string,
    quantity: number,
    startedAt: number,
    baseline: Record<string, number>,
    data: CollectResourceData,
  ): void {
    const worldId = this.opts.state.worldId;
    if (worldId === null) return;
    const home = this.opts.state.home;
    const self = this.opts.bot.entity;
    const summary = itemsSummary(this.opts.bot);
    const delta: Record<string, number> = {};
    for (const [name, count] of Object.entries(summary)) {
      const before = baseline[name] ?? 0;
      if (count !== before) delta[name] = count - before;
    }
    const distance =
      self !== null && home !== null
        ? Math.round(Math.hypot(self.position.x - home.x, self.position.y - home.y, self.position.z - home.z))
        : -1;
    this.opts.skills.record({
      skillName: "collect_resource",
      parameters: { resource: bare, quantity },
      startingConditions: {
        inventorySummary: baseline,
        homeDistance: distance,
        timeOfDay: this.opts.bot.time && this.opts.bot.time.isDay ? "day" : "night",
      },
      outcome: {
        durationMs: Math.max(0, Date.now() - startedAt),
        interruptions: data.interruptions,
        finalInventoryDelta: delta,
      },
      description: `Collected ${data.carried} ${resourceLabel(bare)} and delivered them to the home chest.`,
    });
  }

  private fail(
    data: CollectResourceData,
    errorCode: Extract<SkillErrorCode, "NOT_READY" | "INVALID_RESOURCE" | "TOOL_REQUIRED">,
    reason: string,
  ): SkillResult<CollectResourceData> {
    this.opts.bus.emit("resource.gather.failed", { resource: data.resource, quantity: data.quantity, reason });
    this.announce(`Stuck: ${reason}.`);
    return { ok: false, status: "failed", errorCode, message: reason, retryable: true, data };
  }

  private announce(message: string): void {
    this.opts.logger.info({ message }, "resource gather status");
    if (this.opts.bot.entity === null) return;
    if (!this.chatThrottle.allow(message)) return;
    if (!gameChatBudgetAllows()) return;
    try {
      this.opts.bot.chat(message);
    } catch (err) {
      this.opts.logger.warn({ err: String(err) }, "resource gather chat failed");
    }
  }
}

/**
 * Short player-facing phrasing for the abort reasons. Expedition aborts name
 * the safe return explicitly: the run breaks off and walks home.
 */
function abortReason(abort: Abort, expedition: boolean): string {
  switch (abort.errorCode) {
    case "INVENTORY_FULL":
      return expedition ? `Inventory too tight for the trip home. Returning.` : "Inventory full — deposited what I had.";
    case "DANGER_TOO_HIGH":
      return `Health too low: ${abort.reason}.${expedition ? " Returning home." : ""}`;
    case "TOOL_REQUIRED":
      return `Tools unavailable: ${abort.reason}.`;
    case "EXPEDITION_BLOCKED":
      return abort.reason;
    case "PROTECTED_REGION":
      return abort.reason;
    default:
      return abort.reason;
  }
}
