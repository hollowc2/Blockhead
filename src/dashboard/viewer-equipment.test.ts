import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import test from "node:test";
import { createViewerEquipment } from "../../scripts/viewer-equipment.mjs";

const require = createRequire(import.meta.url);
const viewerRequire = createRequire(require.resolve("prismarine-viewer/package.json"));
const THREE = viewerRequire("three");

test("gear renders on the player, replaces worn pieces and inherits camera visibility", () => {
  const paths: string[] = [];
  const renderer = createViewerEquipment({ ...THREE, TextureLoader: class {
    load(path: string) { paths.push(path); return new THREE.Texture(); }
  } });
  const model = new THREE.Group();
  // The server sends equipment before the first position creates the model.
  renderer.update({ head: "iron_helmet", torso: "iron_chestplate", legs: "iron_leggings", feet: "iron_boots", hand: "iron_sword", "off-hand": "shield" });
  renderer.attach(model);
  const slot = (name: string) => model.getObjectByName(`equipment:${name}`);
  assert.equal(slot("head").children.length, 1);
  assert.equal(slot("torso").children.length, 3);
  assert.equal(slot("legs").children.length, 3);
  assert.equal(slot("feet").children.length, 2);
  assert.equal(slot("hand").children.length, 1);
  assert.equal(slot("off-hand").children.length, 3);
  assert(paths.includes("textures/1.21.4/entity/equipment/humanoid/iron.png"));
  assert(paths.includes("textures/1.21.4/entity/equipment/humanoid_leggings/iron.png"));
  assert(paths.includes("textures/1.21.4/items/iron_sword.png"));
  for (const path of paths) assert(existsSync(viewerRequire.resolve(`./public/${path}`)));
  const original = slot("head");
  renderer.update({ head: "iron_helmet", hand: "iron_pickaxe" });
  assert.equal(slot("head"), original, "unchanged gear reuses geometry");
  assert.equal(slot("torso").children.length, 0, "unequipped armor disappears");
  assert.equal(slot("off-hand").children.length, 0, "unequipped shield disappears");
  let disposed = false;
  original.children[0].geometry.addEventListener("dispose", () => { disposed = true; });
  renderer.update({ head: "diamond_helmet" });
  assert(disposed, "replaced gear releases geometry");
  assert.equal(original.parent, null);
  model.visible = false;
  assert.equal(slot("head").parent.visible, false, "eyes mode hides the complete equipped model");
  const replacement = new THREE.Group();
  renderer.attach(replacement);
  assert.equal(model.children.length, 0);
  assert.equal(replacement.getObjectByName("equipment:head").children.length, 1);
  renderer.update(null);
  assert.equal(replacement.getObjectByName("equipment:head").children.length, 0);
});
