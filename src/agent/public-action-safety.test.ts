import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { bindPublicSafetyInterrupts, PublicSafetyObservations, safePublicThreatState } from "./public-action-safety.js";
import { EventBus } from "../events/bus.js";
import { nearestThreat } from "./self-defense.js";
import { PublicActionController } from "./public-actions.js";
import { WorldActionExecutor } from "./world-actions.js";

function mob(name = "zombie", x = 3, y = 64) {
  return { id: 7, name, type: "hostile", isValid: true, position: new Vec3(x, y, 0) };
}
function fixture(entities: unknown[] = []) {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0.2 },
    entities: Object.fromEntries(entities.map((e, i) => [i + 7, e])),
    blockAt: () => ({ boundingBox: "empty" }),
  }) as unknown as Bot;
}

test("distant loaded ordinary mobs are not threats; inclusive melee/ranged boundaries agree with reflex", () => {
  const distant = fixture(Array.from({ length: 83 }, () => mob("spider", 27)));
  assert.equal(safePublicThreatState(distant), true);
  for (const name of ["zombie", "zombie_villager", "husk", "creeper", "spider", "cave_spider", "skeleton", "stray", "pillager", "drowned"]) {
    const ranged = ["skeleton", "stray", "pillager", "drowned"].includes(name);
    const radius = ranged ? 16 : 6, height = ranged ? 12 : 3;
    for (const [x, y, safe] of [[radius, 64, false], [radius + 0.01, 64, true], [3, 64 + height, false], [3, 64 + height + 0.01, true], [3, 64 - height, false], [3, 64 - height - 0.01, true]] as const) {
      const bot = fixture([mob(name, x, y)]);
      assert.equal(nearestThreat(bot) === null, safe, `${name} reflex ${x}/${y}`);
      assert.equal(safePublicThreatState(bot), safe, `${name} public ${x}/${y}`);
    }
  }
});

test("solid cover separates a threat; missing, partial or throwing visibility never proves safety", () => {
  const bot = fixture([mob("skeleton", 12, 70)]);
  assert.equal(safePublicThreatState(bot), false);
  bot.blockAt = (() => ({ boundingBox: "block" })) as unknown as Bot["blockAt"];
  assert.equal(safePublicThreatState(bot), true);
  for (const block of [null, {}, { boundingBox: "unknown" }]) {
    bot.blockAt = (() => block) as Bot["blockAt"];
    assert.equal(safePublicThreatState(bot), false);
  }
  Object.assign(bot, { blockAt: undefined });
  assert.equal(safePublicThreatState(bot), false);
  bot.blockAt = () => { throw Error("world unavailable"); };
  assert.equal(safePublicThreatState(bot), false);
});

test("missing registry/positions and unknown threats fail closed; stale dead records do not obstruct", () => {
  assert.equal(safePublicThreatState(fixture()), true);
  for (const name of ["enderman", "piglin", "witch", "ghast", "blaze", "guardian", "shulker", "future_hostile"]) {
    assert.equal(safePublicThreatState(fixture([mob(name, 100)])), false, name);
  }
  for (const entity of [{ ...mob(), position: undefined }, { ...mob(), position: new Vec3(NaN, 64, 0) }, null]) {
    assert.equal(safePublicThreatState(fixture([entity])), false);
  }
  for (const patch of [{ entities: undefined }, { entity: undefined }, { entity: { id: 1, position: { x: 0, y: Infinity, z: 0 } } }]) {
    assert.equal(safePublicThreatState(Object.assign(fixture(), patch)), false);
  }
  assert.equal(safePublicThreatState(fixture([{ ...mob(), isValid: false }, { ...mob(), health: 0 }])), true);
  assert.equal(safePublicThreatState(fixture([{ ...mob("minecraft:SKELETON", 12), type: "mob" }])), false);
  assert.equal(safePublicThreatState(fixture([{ ...mob("zombie", 3), name: undefined, mobType: "zombie", type: "mob" }])), false);
});

test("server and physics observations must both be recent, session scoped and invalidated on lifecycle events", () => {
  let now = 0;
  const bot = fixture(), emit = bot as unknown as EventEmitter;
  const observations = new PublicSafetyObservations(bot, () => now);
  assert.equal(observations.fresh(), false);
  observations.attach(); observations.attach();
  emit.emit("physicsTick"); assert.equal(observations.fresh(), false);
  emit.emit("time"); assert.equal(observations.fresh(), true);
  now = 251; assert.equal(observations.fresh(), false);
  emit.emit("physicsTick"); assert.equal(observations.fresh(), true);
  now = 2501; emit.emit("physicsTick"); assert.equal(observations.fresh(), false, "local physics cannot refresh a stalled server");
  for (const event of ["death", "respawn", "end"]) {
    emit.emit("time"); emit.emit("physicsTick"); assert.equal(observations.fresh(), true);
    emit.emit(event); assert.equal(observations.fresh(), false);
  }
  emit.emit("time"); emit.emit("physicsTick");
  assert.equal(new PublicSafetyObservations(bot, () => now).fresh(), false, "new session starts unknown");
  observations.detach(); emit.emit("time"); emit.emit("physicsTick"); assert.equal(observations.fresh(), false);
  assert.equal(emit.listenerCount("time"), 0); assert.equal(emit.listenerCount("physicsTick"), 0);
});

test("threat movement and stale observations between reservation and execution prevent every gesture", async () => {
  for (const action of ["hello", "wave", "look_left", "look_right"] as const) {
    for (const interrupt of ["nearby", "ranged", "stale", "owner", "survival", "night"] as const) {
      let now = 0;
      const bot = fixture(), emit = bot as unknown as EventEmitter, effects: string[] = [];
      Object.assign(bot, { chat: () => effects.push("chat"), swingArm: () => effects.push("swing"), look: async () => { effects.push("look"); } });
      const observations = new PublicSafetyObservations(bot, () => now);
      observations.attach(); emit.emit("time"); emit.emit("physicsTick");
      const executor = new WorldActionExecutor();
      const controller = new PublicActionController({ session: () => bot,
        safe: () => observations.fresh() && safePublicThreatState(bot),
        tryRun: (signal, run) => executor.tryRun("public", signal, async lease => { await Promise.resolve(); return run(lease); }),
      });
      const abort = new AbortController();
      const bus = new EventBus();
      bindPublicSafetyInterrupts(bus, () => { controller.invalidate(); abort.abort(); });
      const result = controller.execute(action, abort.signal);
      if (interrupt === "nearby") bot.entities[7] = mob() as never;
      if (interrupt === "ranged") bot.entities[7] = mob("skeleton", 16, 76) as never;
      if (interrupt === "stale") now = 3000;
      if (interrupt === "owner") bus.emit("chat.command", { from: "owner", command: "wait here" });
      if (interrupt === "survival") bus.emit("hunger.low", { food: 8 });
      if (interrupt === "night") bus.emit("time.night", { time: "night" });
      assert.equal(await result, "refused", `${action}/${interrupt}`);
      assert.deepEqual(effects, []); assert.equal(executor.pendingCount, 0); assert.equal(executor.activeOwner, null);
      observations.detach();
    }
  }
});
