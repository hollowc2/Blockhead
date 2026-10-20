import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { canonicalMobName } from "../policy/combat.js";

const MAX_TRACKED = 128;
const MAX_REPORTED = 32;
type ObservedBoolean = { value: boolean | null; receivedAgeMs: number | null };
type Field = { value: boolean | null; at: number };
type Flags = { creepy?: Field; staredAt?: Field };
const uuid = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("-", "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
};

/**
 * Incoming events only: never wraps write(), sends packets, or changes the bot.
 * This is evidence for an operator, never an input to public admission.
 */
export class PublicProtocolObservations {
  private attached = false;
  private since: number | null = null;
  private epoch = 0;
  private fields = new Map<number, Flags>();
  private incomplete = false;
  private helloEchoes = 0;
  private mainArmEchoes = 0;
  private corrections = 0;
  private lastHelloAt: number | null = null;
  constructor(private readonly bot: Bot, private readonly now: () => number = () => performance.now()) {}

  private supported(): boolean {
    const keys = this.bot.registry?.entitiesByName.enderman?.metadataKeys;
    return this.bot.version === "1.21.4" && keys?.[17] === "creepy" && keys?.[18] === "stared_at";
  }
  private readonly reset = (): void => {
    this.epoch++;
    this.since = this.attached ? this.now() : null;
    this.fields.clear(); this.incomplete = false;
    this.helloEchoes = 0; this.mainArmEchoes = 0; this.corrections = 0; this.lastHelloAt = null;
  };
  private readonly gone = (entity: Entity): void => { this.fields.delete(entity.id); };
  private readonly packet = (data: unknown, meta: { name?: string }): void => {
    try {
      if (!this.attached || !this.supported() || data === null || typeof data !== "object") return;
      const p = data as Record<string, unknown>;
      if (meta.name === "entity_metadata" && typeof p.entityId === "number") {
        const entity = this.bot.entities[p.entityId];
        if (!entity || entity.isValid === false || canonicalMobName(entity) !== "enderman") return;
        if (!Array.isArray(p.metadata)) { this.incomplete = true; return; }
        if (!this.fields.has(entity.id) && this.fields.size >= MAX_TRACKED) { this.incomplete = true; return; }
        const flags = this.fields.get(entity.id) ?? {};
        for (const raw of p.metadata) {
          if (raw === null || typeof raw !== "object") { this.incomplete = true; continue; }
          const { key, value } = raw as { key?: unknown; value?: unknown };
          const name = key === 17 ? "creepy" : key === 18 ? "staredAt" : null;
          if (name) {
            if (typeof value !== "boolean") this.incomplete = true;
            flags[name] = { value: typeof value === "boolean" ? value : null, at: this.now() };
          }
        }
        this.fields.set(entity.id, flags);
      } else if (meta.name === "player_chat") {
        const self = uuid(this.bot.player?.uuid);
        if (self !== null && uuid(p.senderUuid) === self && p.plainMessage === "Hello, everyone!") {
          this.helloEchoes++; this.lastHelloAt = this.now();
        }
      } else if (meta.name === "animation" && p.entityId === this.bot.entity?.id && p.animation === 0) {
        this.mainArmEchoes++;
      } else if (meta.name === "position") this.corrections++;
    } catch { this.incomplete = true; }
  };
  attach(): void {
    if (this.attached) return;
    this.attached = true; this.reset();
    this.bot._client.on("packet", this.packet);
    this.bot.on("entityGone", this.gone);
    this.bot.on("death", this.reset);
    this.bot.on("respawn", this.reset);
    this.bot.on("end", this.detach);
  }
  readonly detach = (): void => {
    if (!this.attached) return;
    this.attached = false; this.reset();
    this.bot._client.off("packet", this.packet);
    this.bot.off("entityGone", this.gone);
    this.bot.off("death", this.reset);
    this.bot.off("respawn", this.reset);
    this.bot.off("end", this.detach);
  };
  snapshot() {
    const now = this.now();
    const age = (at: number | null): number | null => at !== null && now >= at ? now - at : null;
    const flag = (value: unknown, observed: Field | undefined): ObservedBoolean => observed
      ? { value: observed.value, receivedAgeMs: age(observed.at) }
      : { value: typeof value === "boolean" ? value : null, receivedAgeMs: null };
    try {
      const supported = this.supported();
      const entities = this.attached ? Object.values(this.bot.entities).filter(e => e && e.isValid !== false && canonicalMobName(e) === "enderman") : [];
      return {
        attached: this.attached, supported, epoch: this.epoch, observationAgeMs: age(this.since),
        incomplete: this.incomplete, endermanCount: entities.length, truncated: entities.length > MAX_REPORTED,
        endermen: entities.slice(0, MAX_REPORTED).map(e => ({
          entityId: e.id,
          creepy: supported ? flag(e.metadata?.[17], this.fields.get(e.id)?.creepy) : flag(null, undefined),
          staredAt: supported ? flag(e.metadata?.[18], this.fields.get(e.id)?.staredAt) : flag(null, undefined),
        })),
        helloEchoes: this.helloEchoes, lastHelloEchoAgeMs: age(this.lastHelloAt),
        mainArmEchoes: this.mainArmEchoes, positionCorrections: this.corrections,
        canProveCalm: false, persistentAngerTarget: "not_transmitted", pendingTarget: "not_transmitted",
        outgoingAttackOrUse: "not_observed", normalSelfPoseAcknowledgement: "not_available",
        effectAcceptance: "not_established",
      };
    } catch {
      return { attached: this.attached, supported: false, incomplete: true, canProveCalm: false, effectAcceptance: "not_established" };
    }
  }
}
