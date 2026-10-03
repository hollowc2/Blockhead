import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import pino from "pino";
import type { AgentState } from "../agent/state.js";
import type { MinecraftConfig } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { SkillsRepository } from "../memory/skills.js";
import type { TravelWaitOptions, TravelWaitResult } from "../minecraft/movement.js";
import { deathSiteDanger } from "./death-recovery.js";
import { DefenseRunner, retreatTarget, type DefenseActions } from "./defense.js";

type Point = { x: number; y: number; z: number };
type Mob = { id: number; type: string; name: string; position: Point; health?: number };

const HOME: Point = { x: 0, y: 64, z: 0 };

function harness(options: { health?: number; self?: Point } = {}) {
  const self = { id: 1, type: "player", name: "CobbleBob", position: { ...(options.self ?? { x: 20, y: 64, z: 0 }) } };
  const entities: Record<number, Mob> = {};
  const bot = Object.assign(new EventEmitter(), {
    entity: self,
    health: options.health ?? 20,
    entities,
    players: {},
    time: { isDay: true },
    inventory: { items: () => [] },
    chat: () => undefined,
  }) as unknown as Bot;
  const travels: Array<{ to: Point; options: TravelWaitOptions }> = [];
  const attacked: string[] = [];
  // Per-test hooks; defaults: every trip arrives, every attack kills.
  const hooks = {
    travel: (_to: Point, _options: TravelWaitOptions): TravelWaitResult => ({ status: "arrived" }),
    attack: (target: Mob): Promise<void> => {
      target.health = 0;
      return Promise.resolve();
    },
  };
  let stopFight: (() => void) | null = null;
  const actions: DefenseActions = {
    travel: async (_bot, to, travelOptions = {}) => {
      travels.push({ to: { x: to.x, y: to.y, z: to.z }, options: travelOptions });
      return hooks.travel(to, travelOptions);
    },
    attack: async (_bot, target) => {
      attacked.push(target.name ?? "?");
      await new Promise<void>((resolve, reject) => {
        stopFight = resolve;
        hooks.attack(target as unknown as Mob).then(resolve, reject);
      });
    },
    stop: async () => { stopFight?.(); },
    equip: async () => undefined,
  };
  const runner = new DefenseRunner({
    bot,
    state: { worldId: null } as unknown as AgentState,
    config: { home: HOME, behavior: { allow_pvp: false } } as unknown as MinecraftConfig,
    bus: new EventBus(),
    skills: { record: () => undefined } as unknown as SkillsRepository,
    logger: pino({ level: "silent" }),
    actions,
  });
  const add = (mob: Mob): Mob => { entities[mob.id] = mob; return mob; };
  return { bot, self, entities, travels, attacked, hooks, runner, add };
}

const mob = (id: number, name: string, position: Point): Mob => ({ id, type: "hostile", name, position });
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z);

test("an unreachable archer makes the reflex retreat instead of reporting 'no hostiles nearby'", async () => {
  const h = harness();
  const skeleton = h.add(mob(7, "skeleton", { x: 30, y: 72, z: 0 }));
  h.hooks.travel = (to) => (distance(to, skeleton.position) < 1 ? { status: "timed_out" } : { status: "arrived" });

  const result = await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.data?.retreated, true);
  assert.match(result.message ?? "", /^retreated: could not approach the skeleton/);
  assert.deepEqual(h.attacked, [], "never swung at a mob it could not reach");
  const retreat = h.travels.at(-1)!.to;
  assert.ok(distance(retreat, skeleton.position) > distance(h.self.position, skeleton.position), "ran away from the skeleton");
});

test("a mob in melee range is fought before a farther one", async () => {
  const h = harness();
  h.add(mob(7, "skeleton", { x: 32, y: 64, z: 0 }));
  h.add(mob(8, "spider", { x: 22, y: 64, z: 0 }));
  h.hooks.travel = (to) => (to.x === 32 ? { status: "timed_out" } : { status: "arrived" });

  const result = await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.equal(h.attacked[0], "spider");
  assert.equal(result.data?.kills, 1);
  assert.equal(result.data?.retreated, true, "then ran from the archer it could not reach");
});

test("the approach breaks off when another hostile closes to melee range", async () => {
  const h = harness();
  const skeleton = h.add(mob(7, "skeleton", { x: 32, y: 64, z: 0 }));
  const spider = h.add(mob(8, "spider", { x: 40, y: 64, z: 0 }));
  h.hooks.travel = (to, options) => {
    if (distance(to, skeleton.position) >= 1) return { status: "arrived" };
    // The spider jumps the bot on the way to the skeleton.
    spider.position = { x: 21, y: 64, z: 0 };
    if (options.shouldAbort?.() === true) return { status: "aborted" };
    return { status: "arrived" };
  };
  h.hooks.attack = async (target) => {
    if (target.name === "spider") target.health = 0;
    else skeleton.health = 0;
  };

  const result = await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.equal(h.attacked[0], "spider", "turned on the spider instead of finishing the walk");
  assert.equal(result.data?.kills, 2);
});

test("the fight stops when a different mob starts landing hits", async () => {
  const h = harness();
  const zombie = h.add(mob(7, "zombie", { x: 23, y: 64, z: 0 }));
  const spider = h.add(mob(8, "spider", { x: 40, y: 64, z: 0 }));
  let round = 0;
  h.hooks.attack = (target) => {
    round += 1;
    if (round === 1) {
      // The zombie backs off out of reach; the spider closes in. Only the
      // fight watcher's stop can end this attack.
      zombie.position = { x: 25, y: 64, z: 0 };
      spider.position = { x: 21, y: 64, z: 0 };
      return new Promise<void>(() => undefined);
    }
    target.health = 0;
    if (target.name === "spider") zombie.health = 0;
    return Promise.resolve();
  };

  const result = await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.deepEqual(h.attacked.slice(0, 2), ["zombie", "spider"]);
  assert.equal(result.data?.kills, 1);
});

test("a hurt reflex runs from a mob that is not yet in melee range", async () => {
  const h = harness({ health: 5 });
  h.add(mob(7, "zombie", { x: 28, y: 64, z: 0 }));

  const result = await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.deepEqual(h.attacked, []);
  assert.equal(result.data?.retreated, true);
  assert.match(result.message ?? "", /retreat threshold/);
});

test("a hurt reflex still fights a mob already in melee range", async () => {
  const h = harness({ health: 5 });
  h.add(mob(7, "zombie", { x: 22, y: 64, z: 0 }));

  const result = await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.deepEqual(h.attacked, ["zombie"]);
  assert.equal(result.data?.kills, 1);
});

test("an owner-ordered defense at low health is still refused", async () => {
  const h = harness({ health: 5 });
  h.add(mob(7, "zombie", { x: 22, y: 64, z: 0 }));

  const result = await h.runner.defendSelf({ radius: 24 });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "DANGER_TOO_HIGH");
});

test("a creeper is still evaded, never meleed", async () => {
  const h = harness();
  h.add(mob(7, "creeper", { x: 23, y: 64, z: 0 }));

  await h.runner.defendSelf({ reflex: true, radius: 24 });

  assert.deepEqual(h.attacked, []);
  assert.ok(h.travels.at(-1)!.to.x < 20, "backed away from the creeper");
});

test("retreatTarget runs away from the threats and bends toward home", () => {
  const self = { x: 20, y: 64, z: 0 };
  const straight = retreatTarget(self, [{ x: 20, y: 64, z: 10 }], null);
  assert.ok(Math.abs(straight.x - 20) < 1e-9 && straight.z < -15, "directly away from the threat");

  const homeward = retreatTarget(self, [{ x: 20, y: 64, z: 10 }], HOME);
  assert.ok(homeward.z < 0, "still away from the threat");
  assert.ok(homeward.x < 20, "leaning toward home");

  const homeBehindThreat = retreatTarget(self, [{ x: 10, y: 64, z: 0 }], HOME);
  assert.ok(homeBehindThreat.x > 20, "never runs through the threat to reach home");

  const noThreats = retreatTarget(self, [], HOME);
  assert.ok(noThreats.x < 20, "with nothing to run from, heads home");
});

test("deathSiteDanger flags an archer covering the site or a hurt bot", () => {
  const site = { x: 0, y: 64, z: 0 };
  assert.equal(deathSiteDanger(20, site, []), null);
  assert.equal(deathSiteDanger(20, site, [{ type: "hostile", name: "zombie", position: { x: 2, y: 64, z: 0 } }]), null, "melee mobs are the site scan's job");
  assert.match(deathSiteDanger(20, site, [{ type: "hostile", name: "skeleton", position: { x: 10, y: 70, z: 0 } }]) ?? "", /skeleton/);
  assert.equal(deathSiteDanger(20, site, [{ type: "hostile", name: "skeleton", position: { x: 40, y: 64, z: 0 } }]), null, "too far to cover the site");
  assert.match(deathSiteDanger(5, site, []) ?? "", /health 5/);
});
