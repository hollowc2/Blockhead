import assert from "node:assert/strict";
import test from "node:test";
import { patchWorker, patchWorldRenderer } from "../../scripts/patch-prismarine-viewer.mjs";

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
