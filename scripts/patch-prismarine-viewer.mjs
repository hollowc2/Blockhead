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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await patchPrismarineViewer();
}
