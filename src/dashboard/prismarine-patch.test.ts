import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { CAMERA_MODES, FIRST_PERSON_V1, patchMineflayerCrafting, patchViewerClient, patchViewerCamera, patchViewerEquipment, patchViewerRecenterHotkey, patchViewerShots, patchWorker, patchWorldRenderer } from "../../scripts/patch-prismarine-viewer.mjs";

const CAMERA_LISTENER = 'window.addEventListener("bob-cam",e=>bobCam.set(["eyes","follow"].includes(e.detail)?e.detail:"orbit"));';
const SHOTS_LISTENER = 'window.addEventListener("bob-cam",e=>bobCam.set(["eyes","follow","wide","close"].includes(e.detail)?e.detail:"orbit"));';
/** The bundle as patchViewerCamera alone leaves it: the broadcast shots taken back out, if a deploy already added them. */
function withoutShots(bundle: string): string {
  const start = bundle.indexOf("/* bob-shots */");
  if (start === -1) return bundle;
  const end = bundle.indexOf(SHOTS_LISTENER, start);
  return bundle.slice(0, start) + CAMERA_LISTENER + bundle.slice(end + SHOTS_LISTENER.length);
}

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
  const bundle = withoutShots(await readFile(new URL("../../node_modules/prismarine-viewer/public/index.js", import.meta.url), "utf8"));
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

test("the shots patch adds the wide and close shots to the installed bundle, idempotently", async () => {
  const { readFile } = await import("node:fs/promises");
  const bundle = await readFile(new URL("../../node_modules/prismarine-viewer/public/index.js", import.meta.url), "utf8");
  const patched = patchViewerShots(bundle);
  assert.equal(patched.split("/* bob-shots */").length, 2);
  assert.equal(patched.split(SHOTS_LISTENER).length, 2);
  assert(!patched.includes(CAMERA_LISTENER));
  assert.equal(patchViewerShots(patched), patched, "re-running is a no-op");
  // An older copy of the shots is replaced, not stacked.
  const older = patched.replace("WIDE_LAP_S = 150", "WIDE_LAP_S = 90");
  assert.equal(patchViewerShots(older), patched);
  assert.equal(withoutShots(patched), withoutShots(bundle));
  assert.doesNotThrow(() => new Function(patched));
  assert.throws(() => patchViewerShots("unrelated"), /refusing to patch/);
});

/** bobCam as the patched bundle builds it, around a real three.js camera and a stub viewer. */
function cameraRig() {
  const THREE = createRequire(import.meta.url)("three");
  const camera = new THREE.PerspectiveCamera();
  const viewer = { playerHeight: 1.62, camera, world: { sectionMeshs: {} as Record<string, unknown> } };
  const listeners: Array<(event: { detail: unknown }) => void> = [];
  const window = { parent: null as unknown, addEventListener: (type: string, run: (event: { detail: unknown }) => void) => { if (type === "bob-cam") listeners.push(run); } };
  window.parent = window;
  const controls = { enabled: true, target: { set() {} }, update() {} };
  const source = patchViewerShots(CAMERA_MODES);
  const cam = new Function("THREE", "u", "h", "c", "window", `${source}return bobCam;`)(THREE, viewer, controls, null, window);
  let now = 1000;
  const bob = { x: 1000.5, y: 64, z: -2000.5 };
  return {
    THREE, camera, viewer, cam, bob,
    send(mode: string) { for (const run of listeners) run({ detail: mode }); },
    /** Run frames for `ms` at 60 fps. */
    run(ms: number) { for (let t = 0; t < ms; t += 16) { now += 16; cam.frame(now); } },
    head() { return new THREE.Vector3(bob.x, bob.y + 1.62, bob.z); },
    distance() { return camera.position.distanceTo(this.head()); },
    /** Angle between where the camera looks and the direction to CobbleBob. */
    offAim() {
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const toBob = new THREE.Vector3(bob.x, bob.y + 1, bob.z).sub(camera.position).normalize();
      return forward.angleTo(toBob);
    },
  };
}

test("the wide shot orbits CobbleBob from above and further out, always looking at him", () => {
  const rig = cameraRig();
  rig.cam.seen(rig.bob, 0.4, -0.1);
  rig.send("follow");
  rig.run(2000);
  const follow = rig.distance();
  rig.send("wide");
  assert.equal(rig.cam.mode, "wide");
  assert(rig.distance() > 2 * follow, `wide ${rig.distance()} vs follow ${follow}`);
  assert(rig.camera.position.y > rig.bob.y + 8, "from above");
  assert(rig.offAim() < 0.1, `aim off by ${rig.offAim()}`);
  const start = rig.camera.position.clone();
  rig.run(20_000);
  assert(rig.camera.position.distanceTo(start) > 4, "it orbits");
  assert(rig.offAim() < 0.1, `aim off by ${rig.offAim()} after orbiting`);
  // He walks on; the shot follows him.
  rig.bob.x += 6;
  rig.cam.seen(rig.bob, 0.4, -0.1);
  rig.run(3000);
  assert(rig.offAim() < 0.1);
  assert(Math.abs(rig.distance() - 16.6) < 1.5, `distance ${rig.distance()}`);
  // Unknown modes still mean orbit, and the old shots are unchanged.
  rig.send("bogus");
  assert.equal(rig.cam.mode, "orbit");
  rig.send("eyes");
  assert.equal(rig.cam.mode, "eyes");
});

test("terrain between CobbleBob and the wide shot pulls the camera in", () => {
  const rig = cameraRig();
  const { THREE } = rig;
  // A slab of rock over his head, as in a cave.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40));
  roof.position.set(rig.bob.x, rig.bob.y + 4, rig.bob.z);
  roof.updateMatrixWorld();
  rig.viewer.world.sectionMeshs.roof = roof;
  rig.cam.seen(rig.bob, 0, 0);
  rig.send("wide");
  assert(rig.camera.position.y < rig.bob.y + 4, `camera at ${rig.camera.position.y} is under the roof`);
  rig.run(5000);
  assert(rig.camera.position.y < rig.bob.y + 4);
  assert(rig.offAim() < 0.15);
});

test("the close shot sits nearer than follow and turns with him", () => {
  const rig = cameraRig();
  rig.cam.seen(rig.bob, 1.2, 0);
  rig.send("follow");
  rig.run(3000);
  const follow = rig.distance();
  rig.send("close");
  assert.equal(rig.cam.mode, "close");
  rig.run(3000);
  assert(rig.distance() < follow - 1.5, `close ${rig.distance()} vs follow ${follow}`);
  assert(rig.distance() > 1.5);
  // Walking east: the camera swings round behind him (to his west).
  for (let i = 0; i < 40; i++) { rig.bob.x += 0.25; rig.cam.seen(rig.bob, 1.2, 0); rig.run(100); }
  rig.run(3000);
  assert(rig.camera.position.x < rig.bob.x - 1, "behind him");
  rig.send("follow");
  assert.equal(rig.cam.mode, "follow");
});
