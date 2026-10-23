import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createViewerEquipment } from "./viewer-equipment.mjs";
import { installViewerDroppedItems } from "./viewer-dropped-items.mjs";

const files = [
  {
    path: new URL("../node_modules/prismarine-viewer/viewer/lib/worldrenderer.js", import.meta.url),
    legacy: "for (let y = 0; y < 256; y += 16) {",
    modern: "for (let y = -64; y < 320; y += 16) {",
  },
  {
    path: new URL("../node_modules/prismarine-viewer/public/index.js", import.meta.url),
    legacy: "for(let i=0;i<256;i+=16)",
    modern: "for(let i=-64;i<320;i+=16)",
  },
];

const workerFiles = [
  new URL("../node_modules/prismarine-viewer/viewer/lib/worker.js", import.meta.url),
  new URL("../node_modules/prismarine-viewer/public/worker.js", import.meta.url),
];

const viewerClient = new URL("../node_modules/prismarine-viewer/public/index.js", import.meta.url);
const mineflayerInventory = new URL("../node_modules/mineflayer/lib/plugins/inventory.js", import.meta.url);
const itemTextures = Object.fromEntries(JSON.parse(readFileSync(new URL("../node_modules/prismarine-viewer/public/textures/1.21.4/items_textures.json", import.meta.url), "utf8"))
  .map(item => [item.name, item.texture.replace(/^minecraft:/, "").replace(/^block\//, "blocks/").replace(/^item\//, "items/") + ".png"])
  .filter(([, texture]) => /^(?:items|blocks)\/[a-z0-9_]+\.png$/.test(texture)));

export function patchWorldRenderer(source, legacy, modern, path = "world renderer") {
  if (source.includes(modern)) return source;
  if (source.split(legacy).length - 1 !== 2) {
    throw new Error(`Unexpected prismarine-viewer layout in ${path}; refusing to patch`);
  }
  return source.replaceAll(legacy, modern);
}

export function patchWorker(source, path = "worker") {
  const legacy = /([A-Za-z_$][\w$]*)\.sections\[Math\.floor\(([A-Za-z_$][\w$]*)\s*\/\s*16\)\]/g;
  const matches = [...source.matchAll(legacy)];
  if (matches.length === 0 && source.includes(".getSectionAtIndex(Math.floor(")) return source;
  if (matches.length !== 2) {
    throw new Error(`Unexpected prismarine-viewer section lookup in ${path}; refusing to patch`);
  }
  return source.replace(legacy, "$1.getSectionAtIndex(Math.floor($2 / 16))");
}

/** Keep the orbit camera centered on the bot as the bot moves. */
export function patchViewerClient(source, path = "viewer client") {
  const legacy = "h.target.set(t.x,t.y,t.z),u.camera.position.set(t.x,t.y+20,t.z+20),h.update(),s=!1";
  const modern = "h.target.set(t.x,t.y,t.z),u.camera.position.set(t.x+8,t.y+8,t.z+8),h.update(),s=!1";
  if (source.includes(modern)) return source;
  if (!source.includes(legacy)) {
    throw new Error(`Unexpected prismarine-viewer client layout in ${path}; refusing to patch`);
  }
  return source.replace(legacy, modern);
}

/** Add a browser-only recenter shortcut for the orbit camera. */
export function patchViewerRecenterHotkey(source, path = "viewer client") {
  const legacy = "let h=new THREE.OrbitControls(u.camera,l.domElement);";
  const modern = "let h=new THREE.OrbitControls(u.camera,l.domElement),c=null;window.addEventListener(\"keydown\",e=>{if((e.key===\"r\"||e.key===\"R\")&&h&&c){h.target.set(c.x,c.y,c.z),u.camera.position.set(c.x+8,c.y+8,c.z+8),h.update()}});";
  if (source.includes(modern)) return source;
  if (!source.includes(legacy)) {
    throw new Error(`Unexpected prismarine-viewer recenter layout in ${path}; refusing to patch`);
  }
  const withHotkey = source.replace(legacy, modern);
  /*
  const positionLegacy = "(({pos:t,addMesh:i,yaw:r,pitch:o})=>{";
  const positionModern = "(({pos:t,addMesh:i,yaw:r,pitch:o})=>(c=t,{");
  if (!withHotkey.includes(positionLegacy)) {
    throw new Error(`Unexpected prismarine-viewer position layout in ${path}; refusing to patch`);
  }
  */
  const positionLegacyFixed = "(({pos:t,addMesh:i,yaw:r,pitch:o})=>{";
  if (!withHotkey.includes(positionLegacyFixed)) throw new Error(`Unexpected prismarine-viewer position layout in ${path}; refusing to patch`);
  return withHotkey.replace(positionLegacyFixed, "(({pos:t,addMesh:i,yaw:r,pitch:o})=>{c=t;");
}

/** The first, eyes-only toggle; kept so bundles patched with it can be upgraded. */
export const FIRST_PERSON_V1 = [
  [
    "});!function t(){window.requestAnimationFrame(t),h&&h.update(),u.update()",
    "});let bobPov={on:!1,yaw:0,pitch:0,mesh:null,move:null,turn:null,look:{yaw:0,pitch:0}," +
      "go(t,y,p){if(!t)return;this.move&&this.move.stop();this.turn&&this.turn.stop();" +
      "this.move=new n.Tween(u.camera.position).to({x:t.x,y:t.y+u.playerHeight,z:t.z},120).start();" +
      "const d=((y-this.look.yaw)%(2*Math.PI)+3*Math.PI)%(2*Math.PI)-Math.PI;" +
      "this.turn=new n.Tween(this.look).to({yaw:this.look.yaw+d,pitch:p},150)" +
      ".onUpdate(()=>u.camera.rotation.set(this.look.pitch,this.look.yaw,0,\"ZYX\")).start()}," +
      "set(on){if(on===this.on)return;this.on=on;h.enabled=!on;this.mesh&&(this.mesh.visible=!on);" +
      "if(on){this.look.yaw=this.yaw;this.look.pitch=this.pitch;u.camera.rotation.set(this.pitch,this.yaw,0,\"ZYX\");this.go(c,this.yaw,this.pitch)}" +
      "else if(c){this.move&&this.move.stop();this.turn&&this.turn.stop();h.target.set(c.x,c.y,c.z),u.camera.position.set(c.x+8,c.y+8,c.z+8),h.update()}}};" +
      "window.addEventListener(\"bob-pov\",e=>bobPov.set(!!e.detail));" +
      "window.addEventListener(\"keydown\",e=>{if(e.key===\"v\"||e.key===\"V\"){if(window.parent!==window)try{window.parent.dispatchEvent(new window.parent.KeyboardEvent(\"keydown\",{key:\"v\"}))}catch{}else bobPov.set(!bobPov.on)}" +
      "else if((e.key===\"r\"||e.key===\"R\")&&bobPov.on)bobPov.go(c,bobPov.yaw,bobPov.pitch)});" +
      "!function t(){window.requestAnimationFrame(t),h&&!bobPov.on&&h.update(),u.update()",
  ],
  [
    "if(void 0!==r&&void 0!==o)return h&&(h.dispose(),h=null),void u.setFirstPersonCamera(t,r,o);",
    "void 0!==r&&(bobPov.yaw=r);void 0!==o&&(bobPov.pitch=o);if(bobPov.on)return void bobPov.go(t,bobPov.yaw,bobPov.pitch);",
  ],
  [
    "e||(e=new a(\"1.16.4\",\"player\",u.scene).mesh,u.scene.add(e))",
    "e||(e=new a(\"1.16.4\",\"player\",u.scene).mesh,u.scene.add(e),bobPov.mesh=e)",
  ],
];

/**
 * Camera modes for CobbleBob, eased every frame so nothing snaps:
 *  - orbit:  upstream's draggable orbit camera (default)
 *  - eyes:   from CobbleBob's head, following where it looks
 *  - follow: behind and above CobbleBob, turning slowly with the direction it
 *            walks (not its head) and never pitching, so it stays calm; a
 *            ray from its head pulls the camera in front of blocks in the way
 * Upstream's one-way switch (a packet with a pitch disposes the orbit camera
 * for good) is replaced. `bob-cam` events carry the mode from the parent
 * shell; V and T inside the frame ask the shell to switch. The code goes in
 * after the recenter hotkey without touching it, so re-running every patch is
 * a no-op.
 */
const CAMERA_MODES = `let bobCam={mode:"orbit",pos:null,yaw:0,pitch:0,heading:0,mesh:null,last:0,boom:5.2,want:5.2,probed:0,ray:new THREE.Raycaster,cam:{x:0,y:0,z:0,yaw:0,pitch:0},
seen(t,y,p){if(!t)return;if(this.pos){const dx=t.x-this.pos.x,dz=t.z-this.pos.z;dx*dx+dz*dz>.0025&&(this.heading=Math.atan2(-dx,-dz))}else void 0!==y&&(this.heading=y);this.pos={x:t.x,y:t.y,z:t.z};void 0!==y&&(this.yaw=y);void 0!==p&&(this.pitch=p)},
goal(){const t=this.pos;if(this.mode==="eyes")return{x:t.x,y:t.y+u.playerHeight,z:t.z,yaw:this.yaw,pitch:this.pitch};const y=this.mode==="follow"?this.cam.yaw:this.heading,d=this.dir(y),b=this.boom;return{x:t.x+d.x*b,y:t.y+u.playerHeight+d.y*b,z:t.z+d.z*b,yaw:this.heading,pitch:-.3}},
dir(y){return new THREE.Vector3(5*Math.sin(y),1.4,5*Math.cos(y)).normalize()},
probe(){const t=this.pos,head=new THREE.Vector3(t.x,t.y+u.playerHeight,t.z),near=Object.values(u.world.sectionMeshs).filter(m=>m.position.distanceTo(head)<28);this.ray.set(head,this.dir(this.cam.yaw));this.ray.far=5.5;const hit=this.ray.intersectObjects(near,!1)[0];this.want=hit?Math.max(.8,hit.distance-.35):5.2},
set(m){if(m===this.mode)return;this.mode=m;h.enabled=m==="orbit";this.mesh&&(this.mesh.visible=m!=="eyes");if(m==="orbit"){c&&(h.target.set(c.x,c.y,c.z),u.camera.position.set(c.x+8,c.y+8,c.z+8),h.update());return}if(this.pos){this.cam.yaw=this.heading;m==="follow"&&(this.probe(),this.boom=this.want);Object.assign(this.cam,this.goal());this.place()}this.last=0},
place(){u.camera.position.set(this.cam.x,this.cam.y,this.cam.z);u.camera.rotation.set(this.cam.pitch,this.cam.yaw,0,"ZYX")},
frame(now){if(this.mode==="orbit"||!this.pos)return;const dt=this.last?Math.min(.1,(now-this.last)/1e3):0;this.last=now;const turn=1-Math.exp(-dt*(this.mode==="eyes"?10:2)),move=1-Math.exp(-dt*(this.mode==="eyes"?14:5)),angle=(a,b)=>a+(((b-a)%(2*Math.PI)+3*Math.PI)%(2*Math.PI)-Math.PI)*turn;
this.cam.yaw=angle(this.cam.yaw,this.mode==="eyes"?this.yaw:this.heading);if(this.mode==="follow"){now-this.probed>150&&(this.probed=now,this.probe());this.boom+=(this.want-this.boom)*(1-Math.exp(-dt*(this.want<this.boom?20:2)))}const g=this.goal();this.cam.pitch+=(g.pitch-this.cam.pitch)*turn;this.cam.x+=(g.x-this.cam.x)*move;this.cam.y+=(g.y-this.cam.y)*move;this.cam.z+=(g.z-this.cam.z)*move;this.place()}};
window.addEventListener("bob-cam",e=>bobCam.set(["eyes","follow"].includes(e.detail)?e.detail:"orbit"));
window.addEventListener("keydown",e=>{const k=e.key.toLowerCase();if(k!=="v"&&k!=="t")return;if(window.parent!==window){try{window.parent.dispatchEvent(new window.parent.KeyboardEvent("keydown",{key:k}))}catch{}return}const m=k==="v"?"eyes":"follow";bobCam.set(bobCam.mode===m?"orbit":m)});`.replaceAll("\n", "");

export function patchViewerCamera(source, path = "viewer client") {
  if (source.includes("bobCam")) return source;
  let patched = source;
  const swap = (from, to) => {
    if (patched.split(from).length - 1 !== 1) {
      throw new Error(`Unexpected prismarine-viewer camera layout in ${path}; refusing to patch`);
    }
    patched = patched.replace(from, to);
  };
  if (patched.includes("bobPov")) for (const [legacy, modern] of FIRST_PERSON_V1) swap(modern, legacy);
  swap(
    "});!function t(){window.requestAnimationFrame(t),h&&h.update(),u.update()",
    `});${CAMERA_MODES}!function t(){window.requestAnimationFrame(t),h&&bobCam.mode==="orbit"&&h.update(),bobCam.frame(performance.now()),u.update()`,
  );
  swap(
    "if(void 0!==r&&void 0!==o)return h&&(h.dispose(),h=null),void u.setFirstPersonCamera(t,r,o);",
    "bobCam.seen(t,r,o);",
  );
  swap(
    "e||(e=new a(\"1.16.4\",\"player\",u.scene).mesh,u.scene.add(e))",
    "e||(e=new a(\"1.16.4\",\"player\",u.scene).mesh,u.scene.add(e),bobCam.mesh=e,e.visible=bobCam.mode!==\"eyes\")",
  );
  return patched;
}

/** Add worn/held gear and textured dropped stacks to the browser renderer. */
export function patchViewerEquipment(source, path = "viewer client") {
  const hook = 'o.on("version",(t=>{';
  const model = 'e.visible=bobCam.mode!=="eyes")';
  const code = `u.bobEquipment=(${createViewerEquipment.toString()})(THREE,${JSON.stringify(itemTextures)}),o.on("equipment",e=>u.bobEquipment.update(e)),/* bob-dropped-items */(${installViewerDroppedItems.toString()})(THREE,u.entities,${JSON.stringify(itemTextures)}),`;
  const start = source.indexOf("u.bobEquipment=");
  if (start !== -1) {
    const end = source.indexOf(hook, start);
    if (end === -1) throw new Error(`Unexpected prismarine-viewer equipment layout in ${path}; refusing to patch`);
    return source.slice(0, start) + code + source.slice(end);
  }
  if (source.split(hook).length !== 2 || source.split(model).length !== 2) {
    throw new Error(`Unexpected prismarine-viewer equipment layout in ${path}; refusing to patch`);
  }
  return source.replace(hook, code + hook)
    .replace(model, `${model},u.bobEquipment.attach(e)`);
}

/**
 * Modern servers can keep crafting result slot 0 visually unchanged when
 * another identical result remains. Mineflayer otherwise waits forever for a
 * slot-0-specific update even though the server accepted the craft.
 */
export function patchMineflayerCrafting(source, path = "mineflayer inventory plugin") {
  const replacements = [
    ["await once(bot.inventory, 'updateSlot:0')", "await once(bot.inventory, 'updateSlot')"],
    ["await once(bot.currentWindow, 'updateSlot:0')", "await once(bot.currentWindow, 'updateSlot')"],
    [
      "const promisePutAway = once(window, `updateSlot:${slot}`)",
      "const promisePutAway = slot === window.craftingResultSlot && (window.type === 'minecraft:inventory' || window.type === 'minecraft:crafting')\n      ? once(window, 'updateSlot')\n      : once(window, `updateSlot:${slot}`)",
    ],
  ];

  let patched = source;
  for (const [legacy, modern] of replacements) {
    if (patched.includes(modern)) continue;
    if (patched.split(legacy).length - 1 !== 1) {
      throw new Error(`Unexpected Mineflayer crafting layout in ${path}; refusing to patch`);
    }
    patched = patched.replace(legacy, modern);
  }
  return patched;
}

export async function patchPrismarineViewer() {
  for (const file of files) {
    const source = await readFile(file.path, "utf8");
    const patched = patchWorldRenderer(source, file.legacy, file.modern, fileURLToPath(file.path));
    if (patched !== source) await writeFile(file.path, patched);
  }
  for (const path of workerFiles) {
    const source = await readFile(path, "utf8");
    const patched = patchWorker(source, fileURLToPath(path));
    if (patched !== source) await writeFile(path, patched);
  }
  const clientSource = await readFile(viewerClient, "utf8");
  const patchedClient = patchViewerEquipment(patchViewerCamera(
    patchViewerRecenterHotkey(
      patchViewerClient(clientSource, fileURLToPath(viewerClient)),
      fileURLToPath(viewerClient),
    ),
    fileURLToPath(viewerClient),
  ), fileURLToPath(viewerClient));
  if (patchedClient !== clientSource) await writeFile(viewerClient, patchedClient);

  const mineflayerSource = await readFile(mineflayerInventory, "utf8");
  const patchedMineflayer = patchMineflayerCrafting(mineflayerSource, fileURLToPath(mineflayerInventory));
  if (patchedMineflayer !== mineflayerSource) await writeFile(mineflayerInventory, patchedMineflayer);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await patchPrismarineViewer();
}
