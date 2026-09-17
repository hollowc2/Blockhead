import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../node_modules/prismarine-viewer/viewer/lib/worldrenderer.js", import.meta.url);
const source = await readFile(path, "utf8");
const legacy = "for (let y = 0; y < 256; y += 16) {";
const modern = "for (let y = -64; y < 320; y += 16) {";

if (source.includes(modern)) process.exit(0);
if (source.split(legacy).length - 1 !== 2) {
  throw new Error("Unexpected prismarine-viewer worldrenderer.js layout; refusing to patch");
}

await writeFile(path, source.replaceAll(legacy, modern));
