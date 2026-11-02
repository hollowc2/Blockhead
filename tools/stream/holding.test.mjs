import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jpegSize, loadHoldingFrames, VARIANT_NAMES } from "./holding.mjs";
import { FALLBACK_JPEG_BASE64 } from "./holding-fallback.mjs";
import { HOLDING_VARIANT } from "./broadcast-state.mjs";

const assets = join(dirname(fileURLToPath(import.meta.url)), "assets");

test("every packaged holding card is a complete 1280×720 JPEG", () => {
  const { frames, missing } = loadHoldingFrames(assets, { width: 1280, height: 720 });
  assert.deepEqual(missing, []);
  for (const name of VARIANT_NAMES) assert.deepEqual(jpegSize(frames[name]), { width: 1280, height: 720 });
});

test("every state's variant has a card", () => {
  for (const variant of Object.values(HOLDING_VARIANT)) assert.ok(VARIANT_NAMES.includes(variant), variant);
});

test("missing or wrong-size assets fall back to the embedded last-resort card", () => {
  const logs = [];
  const fallback = Buffer.from(FALLBACK_JPEG_BASE64, "base64");
  assert.deepEqual(jpegSize(fallback), { width: 1280, height: 720 });
  const { frames, missing } = loadHoldingFrames("/nonexistent", { width: 1280, height: 720, log: (msg, extra) => logs.push({ msg, ...extra }) });
  assert.deepEqual(missing, VARIANT_NAMES);
  for (const name of VARIANT_NAMES) assert.ok(frames[name].equals(fallback));
  assert.equal(logs[0].msg, "holding asset fallback");
  const wrong = loadHoldingFrames(assets, { width: 1920, height: 1080 });
  assert.deepEqual(wrong.missing, VARIANT_NAMES);
  const truncated = loadHoldingFrames(assets, { width: 1280, height: 720, read: path => readFileSync(path).subarray(0, 1000) });
  assert.deepEqual(truncated.missing, VARIANT_NAMES);
});

test("card sources carry only the allowlisted copy: no addresses, coordinates or remote fetches", () => {
  const allowed = new Set(["CobbleBob", "Back soon.", "His adventure will continue.", "Thanks for waiting.", "Starting up", "Reconnecting", "Taking a break"]);
  for (const file of readdirSync(assets).filter(f => f.endsWith(".svg"))) {
    const svg = readFileSync(join(assets, file), "utf8");
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
    for (const text of texts) assert.ok(allowed.has(text), `${file}: ${text}`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), `${file} references a remote URL`);
    assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b|\.ts\.net|maia|zeus/i.test(svg), `${file} names a host`);
  }
});
