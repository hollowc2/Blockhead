import assert from "node:assert/strict";
import test from "node:test";
import { patchMineflayerCrafting, patchViewerClient, patchViewerRecenterHotkey, patchWorker, patchWorldRenderer } from "../../scripts/patch-prismarine-viewer.mjs";

test("patches both modern world-height loops", () => {
  const legacy = "for (let y = 0; y < 256; y += 16) {";
  const modern = "for (let y = -64; y < 320; y += 16) {";
  const patched = patchWorldRenderer(`${legacy} a } ${legacy} b }`, legacy, modern);
  assert.equal(patched.split(modern).length - 1, 2);
});

test("patches source and minified worker section lookups for negative Y", () => {
  const source = "chunk.sections[Math.floor(y / 16)] && chunk.sections[Math.floor(y / 16)]";
  const minified = "i.sections[Math.floor(a/16)]&&l.sections[Math.floor(n/16)]";
  assert.equal(
    patchWorker(source),
    "chunk.getSectionAtIndex(Math.floor(y / 16)) && chunk.getSectionAtIndex(Math.floor(y / 16))",
  );
  assert.equal(
    patchWorker(minified),
    "i.getSectionAtIndex(Math.floor(a / 16))&&l.getSectionAtIndex(Math.floor(n / 16))",
  );
});

test("viewer patch refuses unknown dependency layouts", () => {
  assert.throws(() => patchWorker("chunk.sections[section]"), /refusing to patch/);
  assert.throws(() => patchWorldRenderer("unrelated", "old", "new"), /refusing to patch/);
});

test("viewer client starts close enough to see CobbleBob", () => {
  const legacy = "h.target.set(t.x,t.y,t.z),u.camera.position.set(t.x,t.y+20,t.z+20),h.update(),s=!1";
  assert.match(patchViewerClient(legacy), /t\.x\+8,t\.y\+8,t\.z\+8/);
  assert.equal(patchViewerClient(patchViewerClient(legacy)), patchViewerClient(legacy));
});

test("viewer client adds an R shortcut to recenter on CobbleBob", () => {
  const source = "let h=new THREE.OrbitControls(u.camera,l.domElement);(({pos:t,addMesh:i,yaw:r,pitch:o})=>{";
  const patched = patchViewerRecenterHotkey(source);
  assert.match(patched, /e\.key===\\?\"r\\?\"/);
  assert.match(patched, /c=t/);
  assert.equal(patchViewerRecenterHotkey(patched), patched);
});

test("Mineflayer crafting patch accepts any authoritative slot update", () => {
  const source = [
    "await once(bot.inventory, 'updateSlot:0')",
    "await once(bot.currentWindow, 'updateSlot:0')",
    "const promisePutAway = once(window, `updateSlot:${slot}`)",
  ].join("\n");
  const patched = patchMineflayerCrafting(source);
  assert.match(patched, /once\(bot\.inventory, 'updateSlot'\)/);
  assert.match(patched, /once\(bot\.currentWindow, 'updateSlot'\)/);
  assert.match(patched, /slot === window\.craftingResultSlot/);
  assert.equal(patchMineflayerCrafting(patched), patched);
});

test("Mineflayer crafting patch refuses an unknown dependency layout", () => {
  assert.throws(() => patchMineflayerCrafting("unrelated"), /refusing to patch/);
});
