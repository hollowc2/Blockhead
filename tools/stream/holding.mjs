/**
 * Loads the pre-rendered holding cards before anything else starts. Each file
 * is checked to be a complete baseline/progressive JPEG of the stream size; a
 * missing or wrong file falls back to the embedded last-resort card, so the
 * encoder always has a presentable frame.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_JPEG_BASE64 } from "./holding-fallback.mjs";

export const VARIANT_NAMES = Object.freeze(["starting", "reconnecting", "break"]);

/** Width/height from the first SOF marker, or null if this isn't a sane JPEG. */
export function jpegSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

export function loadHoldingFrames(dir, { width, height, log = () => {}, read = readFileSync } = {}) {
  const fallback = Buffer.from(FALLBACK_JPEG_BASE64, "base64");
  const frames = {};
  const missing = [];
  for (const name of VARIANT_NAMES) {
    let frame = null;
    try { frame = read(join(dir, `holding-${name}.jpg`)); } catch {}
    const size = frame ? jpegSize(frame) : null;
    if (size && size.width === width && size.height === height) frames[name] = frame;
    else { frames[name] = fallback; missing.push(name); }
  }
  if (missing.length) log("holding asset fallback", { missing });
  return { frames, fallback, missing };
}
