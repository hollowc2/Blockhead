import { readFile, writeFile } from "node:fs/promises";

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

for (const file of files) {
  const source = await readFile(file.path, "utf8");
  if (source.includes(file.modern)) continue;
  if (source.split(file.legacy).length - 1 !== 2) {
    throw new Error(`Unexpected prismarine-viewer layout in ${file.path}; refusing to patch`);
  }
  await writeFile(file.path, source.replaceAll(file.legacy, file.modern));
}
