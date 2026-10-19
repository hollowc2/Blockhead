import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

/**
 * Replace upstream's one-way first-person switch (any packet with a pitch
 * disposes the orbit camera for good) with a toggle: `bob-pov` events set it,
 * V asks the parent shell to flip it, and the camera eases toward CobbleBob's
 * eye position and look direction instead of snapping. It inserts after the
 * recenter hotkey without touching it, so re-running every patch is a no-op.
 */
export function patchViewerFirstPerson(source, path = "viewer client") {
  if (source.includes("bobPov")) return source;
  const replacements = [
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
  let patched = source;
  for (const [legacy, modern] of replacements) {
    if (patched.split(legacy).length - 1 !== 1) {
      throw new Error(`Unexpected prismarine-viewer first-person layout in ${path}; refusing to patch`);
    }
    patched = patched.replace(legacy, modern);
  }
  return patched;
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
  const patchedClient = patchViewerFirstPerson(
    patchViewerRecenterHotkey(
      patchViewerClient(clientSource, fileURLToPath(viewerClient)),
      fileURLToPath(viewerClient),
    ),
    fileURLToPath(viewerClient),
  );
  if (patchedClient !== clientSource) await writeFile(viewerClient, patchedClient);

  const mineflayerSource = await readFile(mineflayerInventory, "utf8");
  const patchedMineflayer = patchMineflayerCrafting(mineflayerSource, fileURLToPath(mineflayerInventory));
  if (patchedMineflayer !== mineflayerSource) await writeFile(mineflayerInventory, patchedMineflayer);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await patchPrismarineViewer();
}
