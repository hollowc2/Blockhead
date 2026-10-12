import { equal } from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { workReadiness } from "./work-readiness.js";

function bot(names = ["stone_sword", "stone_axe", "stone_pickaxe"]): Bot {
  return { health: 20, entity: { position: new Vec3(0, 64, 0) }, entities: {}, inventory: { items: () => names.map(name => ({ name, count: 1 })) } } as unknown as Bot;
}
test("hurt and unequipped bots defer discretionary work; restored tools release the gate", () => {
  const b = bot();
  b.health = 9;
  equal(workReadiness(b)?.item, undefined);
  equal(workReadiness(b)?.reason.includes("heal"), true);
  b.health = 20;
  equal(workReadiness(b), null);
  equal(workReadiness(bot(["stone_sword", "stone_axe"]))?.item, "stone_pickaxe");
});
test("an exposed archer blocks work, but a mob behind solid cover does not", () => {
  const b = bot();
  b.entities[7] = { name: "skeleton", type: "hostile", position: new Vec3(12, 64, 0) } as never;
  equal(workReadiness(b)?.reason, "exposed to skeleton nearby");
  b.blockAt = (() => ({ name: "stone", boundingBox: "block" })) as never;
  equal(workReadiness(b), null);
});
test("low health without carried food requests bread instead of waiting without regeneration", () => {
  const b = bot(); b.health = 9; b.food = 17;
  equal(workReadiness(b)?.item, "bread");
});
