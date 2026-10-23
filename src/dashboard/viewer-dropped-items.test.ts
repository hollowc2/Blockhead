import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { installViewerDroppedItems } from "../../scripts/viewer-dropped-items.mjs";

const require = createRequire(import.meta.url);
const viewerRequire = createRequire(require.resolve("prismarine-viewer/package.json"));
const THREE = viewerRequire("three");
const { Entities } = viewerRequire("./viewer/lib/entities.js");
const states = viewerRequire("./public/blocksStates/1.21.4.json");
const artwork = Object.fromEntries(viewerRequire("./public/textures/1.21.4/items_textures.json").map((item: { name: string; texture: string }) =>
  [item.name, item.texture.replace(/^minecraft:/, "").replace(/^block\//, "blocks/").replace(/^item\//, "items/") + ".png"]));

test("dropped blocks use real models/textures, late metadata replaces the pending mesh, and pickup frees geometry", async () => {
  const paths: string[] = [];
  const scene = new THREE.Scene();
  const entities = new Entities(scene);
  const ready = installViewerDroppedItems({ ...THREE, TextureLoader: class {
    load(path: string) { paths.push(path); return new THREE.Texture(); }
  } }, entities, artwork, async () => states);
  entities.update({ id: 42, name: "item", itemName: null, pos: { x: 2, y: 64, z: 3 } });
  const drop = entities.entities[42];
  assert.equal(drop.visible, false, "no purple placeholder while item metadata is pending");
  entities.update({ id: 42, name: "item", itemName: "cobblestone" });
  assert.equal(entities.entities[42], drop, "metadata updates the existing moving entity");
  assert.equal(drop.visible, true);
  await ready;
  assert.equal(drop.children.length, 1);
  assert.equal(drop.children[0].material.map.flipY, false, "block UVs match the terrain atlas");
  assert(paths.includes("textures/1.21.4.png"));
  const uv = drop.children[0].geometry.attributes.uv;
  assert(uv.getX(0) > 0.1, "cobblestone UVs point at its atlas tile, away from missing texture");
  let disposed = false;
  drop.children[0].geometry.addEventListener("dispose", () => { disposed = true; });
  entities.update({ id: 42, name: "item", itemName: "oak_log" });
  assert(disposed);
  const logUv = drop.children[0].geometry.attributes.uv;
  assert.notEqual(logUv.getX(0), logUv.getX(8), "logs keep separate bark and end-grain textures");
  entities.update({ id: 43, name: "item", itemName: "oak_stairs" });
  assert.equal(entities.entities[43].children.length, 2, "stairs use their model rather than a full cube");
  entities.update({ id: 44, name: "item", itemName: "raw_iron" });
  assert.equal(entities.entities[44].children[0].geometry.type, "PlaneGeometry", "ore drops use the actual dropped item artwork");
  assert(paths.includes("textures/1.21.4/items/raw_iron.png"));
  for (const path of paths) assert(viewerRequire.resolve(`./public/${path}`));
  entities.update({ id: 42, delete: true });
  assert.equal(entities.entities[42], undefined);
  assert.equal(drop.children.length, 0);
  assert.equal(drop.parent, null);
  entities.clear();
  assert.equal(scene.children.length, 0);
  assert.deepEqual(entities.entities, {});
});

test("block artwork survives a failed model fetch and late model loading cannot resurrect a collected drop", async () => {
  const three = { ...THREE, TextureLoader: class { load() { return new THREE.Texture(); } } };
  const entities = new Entities(new THREE.Scene());
  await installViewerDroppedItems(three, entities, artwork, async () => { throw new Error("offline"); });
  entities.update({ id: 1, name: "item", itemName: "dirt" });
  assert.equal(entities.entities[1].visible, true);
  assert.equal(entities.entities[1].children[0].geometry.type, "BoxGeometry");
  entities.clear();
  let resolveModels!: (value: unknown) => void;
  const other = new Entities(new THREE.Scene());
  const ready = installViewerDroppedItems(three, other, artwork, () => new Promise(resolve => { resolveModels = resolve; }));
  await Promise.resolve();
  other.update({ id: 2, name: "item", itemName: "dirt" });
  other.update({ id: 2, delete: true });
  resolveModels(states);
  await ready;
  assert.equal(other.scene.children.length, 0);
  assert.equal(other.entities[2], undefined);
});
