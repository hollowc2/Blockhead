import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { canonicalMobName, HOSTILE_MOB_NAMES } from "../policy/combat.js";
import { reflexThreatRange } from "./self-defense.js";
import type { EventBus } from "../events/bus.js";
import { HUNGER_EMERGENCY_FOOD } from "./hunger-watch.js";

/** Process-lifetime priority boundary, shared by the live wiring and tests. */
export function bindPublicSafetyInterrupts(bus: EventBus, cancel: () => void): void {
  for (const event of ["chat.command", "damage.received", "hunger.low", "time.night", "hostile.detected", "task.created", "task.activated", "death.recorded"] as const) {
    bus.on(event, cancel);
  }
}
/** Fresh Mineflayer facts only. Missing safety observations refuse admission. */
export function safePublicPhysicalState(bot: Bot, retreat: number): boolean {
  try {
    const entity = bot.entity as typeof bot.entity & { isInWater?: boolean; isInLava?: boolean };
    return entity != null && entity.onGround === true && entity.isInWater === false && entity.isInLava === false
      && Number.isFinite(entity.yaw) && Number.isFinite(entity.pitch)
      && Math.hypot(entity.velocity?.x, entity.velocity?.z) < 0.01 && Math.abs(entity.velocity?.y) < 0.1
      && Number.isFinite(bot.health) && Number.isFinite(bot.food) && Number.isFinite(retreat)
      && bot.health > retreat && bot.food > HUNGER_EMERGENCY_FOOD && bot.isSleeping === false && !entity.vehicle
      && bot.usingHeldItem === false && bot.autoEat?.isEating === false && bot.targetDigBlock == null
      && bot.currentWindow == null && bot.pvp?.target == null
      && bot.controlState != null && Object.values(bot.controlState).every(value => value === false)
      && bot.pathfinder?.isMoving() === false && bot.pathfinder?.isMining() === false && bot.pathfinder?.isBuilding() === false
      && bot.pathfinder.goal == null;
  } catch { return false; }
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
  try { return assessPublicThreatState(bot); } catch { return false; }
}
function assessPublicThreatState(bot: Bot): boolean {
  const self = bot.entity?.position;
  if (!finitePosition(self) || bot.entities == null || typeof bot.blockAt !== "function") return false;
  for (const entity of Object.values(bot.entities)) {
    if (entity == null) return false;
    if (entity.id === bot.entity.id || entity.isValid === false) continue;
    const mob = entity as typeof entity & { health?: number };
    if (typeof mob.health === "number" && Number.isFinite(mob.health) && mob.health <= 0) continue;
    const name = canonicalMobName(entity);
    if (entity.type !== "hostile" && !HOSTILE_MOB_NAMES.has(name)) continue;
    if (!REVIEWED_THREAT_NAMES.has(name) || !finitePosition(entity.position)) return false;
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
      if (block == null) return false;
      if (block.boundingBox === "block") { covered = true; break; }
      if (block.boundingBox !== "empty") return false;
    }
    if (!covered) return false;
  }
  return true;
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
    const now = this.now();
    return this.attached && this.serverAt !== null && this.physicsAt !== null
      && now >= this.serverAt && now - this.serverAt <= 2_500
      && now >= this.physicsAt && now - this.physicsAt <= 250;
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
