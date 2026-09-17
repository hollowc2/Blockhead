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
  const patchedClient = patchViewerRecenterHotkey(
    patchViewerClient(clientSource, fileURLToPath(viewerClient)),
    fileURLToPath(viewerClient),
  );
  if (patchedClient !== clientSource) await writeFile(viewerClient, patchedClient);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await patchPrismarineViewer();
}
