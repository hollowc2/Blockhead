import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { canonicalMobName, HOSTILE_MOB_NAMES } from "../policy/combat.js";
import { reflexThreatRange } from "./self-defense.js";
import type { EventBus } from "../events/bus.js";
import { HUNGER_EMERGENCY_FOOD } from "./hunger-watch.js";
import { assessPublicAdmission } from "./public-action-admission.js";

/** Process-lifetime priority boundary, shared by the live wiring and tests. */
export function bindPublicSafetyInterrupts(bus: EventBus, cancel: () => void): void {
  for (const event of ["chat.command", "damage.received", "hunger.low", "time.night", "hostile.detected", "task.created", "task.activated", "death.recorded"] as const) {
    bus.on(event, cancel);
  }
}
/** Fresh Mineflayer facts only. Missing safety observations refuse admission. */
export function safePublicPhysicalState(bot: Bot, retreat: number): boolean {
  try { return assessPublicPhysicalState(bot, retreat).safe; } catch { return false; }
}
export function assessPublicPhysicalState(bot: Bot, retreat: number, collectAll = false): { safe: boolean; checks: Partial<Record<string, "pass" | "blocked" | "unknown">> } {
  try {
    const entity = bot.entity as typeof bot.entity & { isInWater?: boolean; isInLava?: boolean };
    return assessPublicAdmission([
      ["entity", () => entity != null],
      ["grounded", () => entity.onGround === true],
      ["dry", () => entity.isInWater === false && entity.isInLava === false],
      ["orientation", () => Number.isFinite(entity.yaw) && Number.isFinite(entity.pitch)],
      ["stationary", () => Math.hypot(entity.velocity?.x, entity.velocity?.z) < 0.01 && Math.abs(entity.velocity?.y) < 0.1],
      ["health", () => Number.isFinite(bot.health) && Number.isFinite(retreat) && bot.health > retreat],
      ["hunger", () => Number.isFinite(bot.food) && bot.food > HUNGER_EMERGENCY_FOOD],
      ["awake", () => bot.isSleeping === false],
      ["unmounted", () => !entity.vehicle],
      ["item_use", () => bot.usingHeldItem === false],
      ["eating", () => bot.autoEat?.isEating === false],
      ["digging", () => bot.targetDigBlock == null],
      ["window", () => bot.currentWindow == null],
      ["combat_target", () => bot.pvp?.target == null],
      ["controls", () => bot.controlState != null && Object.values(bot.controlState).every(value => value === false)],
      ["path_moving", () => bot.pathfinder?.isMoving() === false],
      ["path_mining", () => bot.pathfinder?.isMining() === false],
      ["path_building", () => bot.pathfinder?.isBuilding() === false],
      ["path_goal", () => bot.pathfinder.goal == null],
    ], collectAll);
  } catch { return { safe: false, checks: { observation: "unknown" as const } }; }
}

// Only these ordinary mobs have reviewed reflex geometry. In particular,
// turning can provoke an enderman, and exotic ranged/flying mobs need their
// own policy. Their presence refuses public gestures at any loaded distance.
const REVIEWED_THREAT_NAMES = new Set([
  "zombie", "zombie_villager", "husk", "creeper", "spider", "cave_spider",
  "skeleton", "stray", "pillager", "drowned",
]);
function finitePosition(value: { x: number; y: number; z: number } | null | undefined): boolean {
  return value != null && [value.x, value.y, value.z].every(Number.isFinite);
}

/** Live registry scan, never the spawn counter or cached dashboard danger. */
export function safePublicThreatState(bot: Bot): boolean {
  return assessPublicThreatState(bot).safe;
}
export type PublicThreatAssessment = { safe: boolean; reason: "clear" | "missing_state" | "unknown_entity" | "unreviewed_mob" | "missing_position" | "unknown_visibility" | "exposed_threat" | "observation_error"; mob?: string };
export function assessPublicThreatState(bot: Bot): PublicThreatAssessment {
  try { return scanPublicThreatState(bot); } catch { return { safe: false, reason: "observation_error" }; }
}
function scanPublicThreatState(bot: Bot): PublicThreatAssessment {
  const self = bot.entity?.position;
  if (!finitePosition(self) || bot.entities == null || typeof bot.blockAt !== "function") return { safe: false, reason: "missing_state" };
  for (const entity of Object.values(bot.entities)) {
    if (entity == null) return { safe: false, reason: "unknown_entity" };
    if (entity.id === bot.entity.id || entity.isValid === false) continue;
    const mob = entity as typeof entity & { health?: number };
    if (typeof mob.health === "number" && Number.isFinite(mob.health) && mob.health <= 0) continue;
    const name = canonicalMobName(entity);
    if (entity.type !== "hostile" && !HOSTILE_MOB_NAMES.has(name)) continue;
    if (!REVIEWED_THREAT_NAMES.has(name)) return { safe: false, reason: "unreviewed_mob", mob: name.slice(0, 64) };
    if (!finitePosition(entity.position)) return { safe: false, reason: "missing_position", mob: name };
    const range = reflexThreatRange(name);
    if (Math.abs(entity.position.y - self.y) > range.height
      || Math.hypot(entity.position.x - self.x, entity.position.z - self.z) > range.radius) continue;
    // Same eye-to-body ray and solid-cover rule as self-defense, except an
    // unloaded/unknown sample refuses admission instead of implying cover.
    const start = new Vec3(self.x, self.y + 1.5, self.z);
    const end = new Vec3(entity.position.x, entity.position.y + 1.2, entity.position.z);
    const steps = Math.ceil(start.distanceTo(end) * 2);
    let covered = false;
    for (let i = 1; i < steps; i++) {
      const block = bot.blockAt(start.plus(end.minus(start).scaled(i / steps)));
      if (block == null) return { safe: false, reason: "unknown_visibility", mob: name };
      if (block.boundingBox === "block") { covered = true; break; }
      if (block.boundingBox !== "empty") return { safe: false, reason: "unknown_visibility", mob: name };
    }
    if (!covered) return { safe: false, reason: "exposed_threat", mob: name };
  }
  return { safe: true, reason: "clear" };
}

/** Session-scoped freshness. Local physics alone cannot prove server liveness. */
export class PublicSafetyObservations {
  private serverAt: number | null = null;
  private physicsAt: number | null = null;
  private attached = false;
  constructor(private readonly bot: Bot, private readonly now: () => number = () => performance.now()) {}
  private readonly onTime = (): void => { this.serverAt = this.now(); };
  private readonly onPhysics = (): void => { this.physicsAt = this.now(); };
  private readonly invalidate = (): void => { this.serverAt = null; this.physicsAt = null; };
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.bot.on("time", this.onTime);
    this.bot.on("physicsTick", this.onPhysics);
    this.bot.on("death", this.invalidate);
    this.bot.on("respawn", this.invalidate);
    this.bot.on("end", this.invalidate);
  }
  fresh(): boolean {
    return this.diagnostics().fresh;
  }
  diagnostics(): { attached: boolean; serverAgeMs: number | null; physicsAgeMs: number | null; fresh: boolean } {
    const now = this.now();
    const age = (at: number | null): number | null => at !== null && now >= at ? now - at : null;
    const serverAgeMs = age(this.serverAt), physicsAgeMs = age(this.physicsAt);
    return { attached: this.attached, serverAgeMs, physicsAgeMs,
      fresh: this.attached && serverAgeMs !== null && serverAgeMs <= 2_500
        && physicsAgeMs !== null && physicsAgeMs <= 250 };
  }
  detach(): void {
    this.attached = false;
    this.invalidate();
    this.bot.off("time", this.onTime);
    this.bot.off("physicsTick", this.onPhysics);
    this.bot.off("death", this.invalidate);
    this.bot.off("respawn", this.invalidate);
    this.bot.off("end", this.invalidate);
  }
}
