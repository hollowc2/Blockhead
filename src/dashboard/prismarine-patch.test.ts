import assert from "node:assert/strict";
import test from "node:test";
import { FIRST_PERSON_V1, patchMineflayerCrafting, patchViewerClient, patchViewerCamera, patchViewerEquipment, patchViewerRecenterHotkey, patchWorker, patchWorldRenderer } from "../../scripts/patch-prismarine-viewer.mjs";

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

test("viewer client replaces upstream's permanent first-person switch with camera modes", () => {
  const source = [
    "let h=new THREE.OrbitControls(u.camera,l.domElement);",
    "!function t(){window.requestAnimationFrame(t),h&&h.update(),u.update(),l.render(u.scene,u.camera)}();",
    "(({pos:t,addMesh:i,yaw:r,pitch:o})=>{c=t;if(void 0!==r&&void 0!==o)return h&&(h.dispose(),h=null),void u.setFirstPersonCamera(t,r,o);",
    "e||(e=new a(\"1.16.4\",\"player\",u.scene).mesh,u.scene.add(e))",
  ].join("");
  const patched = patchViewerCamera(patchViewerRecenterHotkey(source));
  assert.doesNotMatch(patched, /h\.dispose\(\)/);
  assert.match(patched, /h&&bobCam\.mode==="orbit"&&h\.update\(\),bobCam\.frame\(/);
  assert.match(patched, /addEventListener\("bob-cam"/);
  assert.match(patched, /bobCam\.mesh=e/);
  assert.doesNotMatch(patched, /\n/);
  assert.equal(patchViewerCamera(patchViewerRecenterHotkey(patched)), patched, "re-running every patch is a no-op");
  assert.throws(() => patchViewerCamera("unrelated"), /refusing to patch/);
});

test("camera patch upgrades a bundle that has the eyes-only toggle", async () => {
  const { readFile } = await import("node:fs/promises");
  const bundle = await readFile(new URL("../../node_modules/prismarine-viewer/public/index.js", import.meta.url), "utf8");
  const target = patchViewerCamera(bundle);
  const cameraModes = target.slice(target.indexOf("});let bobCam="), target.indexOf("!function t(){window.requestAnimationFrame(t),h&&bobCam"));
  let base = target.replace(cameraModes, "});")
    .replace("h&&bobCam.mode===\"orbit\"&&h.update(),bobCam.frame(performance.now()),u.update()", "h&&h.update(),u.update()")
    .replace("bobCam.seen(t,r,o);", "if(void 0!==r&&void 0!==o)return h&&(h.dispose(),h=null),void u.setFirstPersonCamera(t,r,o);")
    .replace(",bobCam.mesh=e,e.visible=bobCam.mode!==\"eyes\")", ")");
  assert.doesNotMatch(base, /bobCam/);
  for (const [legacy, modern] of FIRST_PERSON_V1) base = base.replace(legacy, modern);
  assert.match(base, /bobPov/);
  assert.equal(patchViewerCamera(base), target);
});

test("the installed viewer bundle carries the camera modes and still parses", async () => {
  const { readFile } = await import("node:fs/promises");
  const bundle = await readFile(new URL("../../node_modules/prismarine-viewer/public/index.js", import.meta.url), "utf8");
  assert.match(bundle, /bobCam/);
  assert.doesNotMatch(bundle, /bobPov/);
  assert.match(bundle, /bobEquipment.attach\(e\)/);
  assert.match(bundle, /o.on\("equipment"/);
  assert.match(bundle, /bob-dropped-items/);
  assert.match(bundle, /bob-preview/);
  assert.equal(patchViewerEquipment(bundle), bundle, "equipment patch is idempotent");
  assert.throws(() => patchViewerEquipment("unrelated"), /refusing to patch/);
  assert.doesNotThrow(() => new Function(bundle));
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
