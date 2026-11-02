#!/usr/bin/env node
// Builds the broadcast holding cards: editable SVG sources, PNG review images,
// the runtime JPEGs (1280×720, same MJPEG input as the live frames), 9:16 crop
// previews and small-size previews, plus the embedded last-resort card.
//
// Dev tool: needs rsvg-convert and ffmpeg on PATH. Text is real SVG text set in
// Noto Sans (SIL OFL) at native size, so it rasterizes sharp; nothing loads
// remotely. Run:  node tools/stream/assets/build-holding.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const W = 1280, H = 720, CX = W / 2;
const CROP_W = Math.round(H * 9 / 16), CROP_X = Math.floor((W - CROP_W) / 2);  // 405 × 720 at x = 437
const FONT = "'Noto Sans', 'DejaVu Sans', sans-serif";
const C = { bg: "#1d252c", text: "#e6edf2", muted: "#b4c2cc", surface: "#2a353e", line: "#3b4954", green: "#3ccf7e", greenDk: "#1f8f58", cyan: "#2ee6f0", amber: "#f2b84b" };

// Only these labels can ever be drawn. The runtime picks a variant by name.
export const VARIANTS = {
  starting: { label: "Starting up", dot: C.cyan },
  reconnecting: { label: "Reconnecting", dot: C.amber },
  break: { label: "Taking a break", dot: "#95a5b2" },
};

// The cube mark, copied from src/dashboard/public/viewer-shell.html (classes → fills).
const mark = (x, y, size) => `
  <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <path fill="${C.greenDk}" d="M16 2 3 9v14l13 7z"/>
    <path fill="${C.green}" d="M6 12h3v3H6zm4 4h3v3h-3zm-4 4h3v3H6zm4-12h3v3h-3z"/>
    <path fill="none" stroke="${C.cyan}" stroke-width="1.4" stroke-linejoin="round" d="M16 2l13 7v14l-13 7M16 2l6 9 7-2M22 11l-2 8 9 4M20 19l-4 11M22 11l-6 8 4 0"/>
    <g fill="${C.cyan}"><circle cx="16" cy="2.5" r="1.6"/><circle cx="22" cy="11" r="1.6"/><circle cx="28.5" cy="9" r="1.6"/><circle cx="20" cy="19" r="1.6"/><circle cx="28.5" cy="23" r="1.6"/><circle cx="16" cy="29.5" r="1.6"/></g>
  </svg>`;

// 8×8 cobblestone texel tile: dark mortar with irregular stones (big enough to read at stream size).
const STONES = [[0,0,3,2],[4,0,4,2],[0,3,2,2],[3,3,3,2],[7,3,1,2],[0,6,4,2],[5,6,3,2]];
const HIGHLIGHTS = [[0,0,2,1],[4,0,2,1],[3,3,1,1],[0,6,2,1],[5,6,1,1]];
const SHADOWS = [[2,1,1,1],[7,1,1,1],[5,4,1,1],[3,7,1,1],[7,7,1,1]];
const MOSS = [[1,0,2,1],[6,6,2,1]];
const rects = (list, fill) => list.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`).join("");
const tile = (moss) => `<rect width="8" height="8" fill="#4c545b"/>${rects(STONES, "#7f888f")}${rects(HIGHLIGHTS, "#a3acb2")}${rects(SHADOWS, "#666f76")}${moss ? rects(MOSS, C.greenDk) + rects([[6,6,1,1]], C.green) : ""}`;

// Isometric cube: (cx, cy) is the top vertex; half-width a, quarter-height b, side height h.
function cube(cx, cy, a, b, h, { moss = false, rim = false, opacity = 1 } = {}) {
  const top = `matrix(${a / 8} ${b / 8} ${-a / 8} ${b / 8} ${cx} ${cy})`;
  const left = `matrix(${a / 8} ${b / 8} 0 ${h / 8} ${cx - a} ${cy + b})`;
  const right = `matrix(${a / 8} ${-b / 8} 0 ${h / 8} ${cx} ${cy + 2 * b})`;
  const leftFace = `${cx - a},${cy + b} ${cx},${cy + 2 * b} ${cx},${cy + 2 * b + h} ${cx - a},${cy + b + h}`;
  const rightFace = `${cx},${cy + 2 * b} ${cx + a},${cy + b} ${cx + a},${cy + b + h} ${cx},${cy + 2 * b + h}`;
  const topFace = `${cx},${cy} ${cx + a},${cy + b} ${cx},${cy + 2 * b} ${cx - a},${cy + b}`;
  return `<g opacity="${opacity}">
    <g transform="${top}"><use href="#${moss ? "mossy" : "cobble"}"/></g>
    <g transform="${left}"><use href="#cobble"/></g><polygon points="${leftFace}" fill="#0b1014" opacity=".38"/>
    <g transform="${right}"><use href="#cobble"/></g><polygon points="${rightFace}" fill="#0b1014" opacity=".55"/>
    ${rim ? `<polyline points="${cx},${cy + 2 * b} ${cx + a},${cy + b} ${cx + a},${cy + b + h}" fill="none" stroke="${C.cyan}" stroke-width="1.6" opacity=".55"/>
` : ""}
    <polygon points="${topFace}" fill="none" stroke="#0b1014" stroke-width=".8" opacity=".35"/>
  </g>`;
}

// Faint outline cubes floating in the background (mostly outside the 9:16 crop).
function ghost(cx, cy, a, opacity) {
  const b = a / 2, h = a * 1.15;
  return `<g opacity="${opacity}" fill="none" stroke="${C.cyan}" stroke-width="1.2" stroke-linejoin="round">
    <polygon points="${cx},${cy} ${cx + a},${cy + b} ${cx},${cy + 2 * b} ${cx - a},${cy + b}" fill="#2a353e"/>
    <polygon points="${cx - a},${cy + b} ${cx},${cy + 2 * b} ${cx},${cy + 2 * b + h} ${cx - a},${cy + b + h}" fill="#222c34"/>
    <polygon points="${cx},${cy + 2 * b} ${cx + a},${cy + b} ${cx + a},${cy + b + h} ${cx},${cy + 2 * b + h}" fill="#1a2228"/>
  </g>`;
}

function island() {
  const a = 32, b = 16, h = 30, ox = CX, oy = 452;
  const at = (i, j, k) => [ox + (i - j) * a, oy + (i + j) * b - k * h];
  const layers = [
    { k: -3, cells: [[1, 1]], scale: 0.55 },
    { k: -2, cells: [[1, 1], [2, 1], [1, 2]], scale: 0.8 },
    { k: -1, cells: [[0, 1], [1, 0], [1, 1], [2, 1], [1, 2], [2, 2]], scale: 1 },
    { k: 0, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]], scale: 1 },
  ];
  let out = "";
  for (const { k, cells, scale } of layers) {
    const right = Math.max(...cells.map(([i, j]) => i - j));
    for (const [i, j] of [...cells].sort((p, q) => p[0] + p[1] - (q[0] + q[1]) || p[0] - q[0])) {
      let [x, y] = at(i, j, k);
      // Narrower lower layers taper toward the island's centre line.
      if (scale !== 1) { x = ox + (x - ox) * scale; y = y - (1 - scale) * h * (k === -3 ? 1.6 : 0.5); }
      out += cube(x, y, a * scale, b * scale, h * scale, { moss: k === 0, rim: i - j === right });
    }
  }
  return out;
}

// A stone pickaxe leaning on the island, head up, handle resting on the top face.
const pickaxe = () => `
  <g transform="translate(${CX + 34} 452) rotate(-30)">
    <rect x="-4.5" y="-6" width="9" height="74" rx="1" fill="#7a4f2c"/>
    <rect x="-4.5" y="-6" width="3.5" height="74" fill="#9a6a3f"/>
    <rect x="-4.5" y="22" width="9" height="4" fill="#5d3b20"/>
    <path d="M-38 12 Q0 -22 38 12" fill="none" stroke="#5b646b" stroke-width="13" stroke-linecap="butt"/>
    <path d="M-38 12 Q0 -22 38 12" fill="none" stroke="#9aa4ab" stroke-width="7"/>
    <path d="M-30 4 Q0 -17 30 4" fill="none" stroke="#c9d2d8" stroke-width="2"/>
    <path d="M-38 12 Q0 -22 38 12" fill="none" stroke="${C.cyan}" stroke-width="1.2" opacity=".45" transform="translate(0 -6)"/>
  </g>`;

function card(variant) {
  const v = variant ? VARIANTS[variant] : null;
  const pillW = v ? Math.round(v.label.length * 10.6 + 62) : 0;
  const scene = v !== null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>CobbleBob — Back soon${v ? ` (${v.label})` : ""}</title>
  <defs>
    <radialGradient id="tl" cx="10%" cy="-10%" r="75%"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".09"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
    <radialGradient id="tr" cx="100%" cy="0%" r="65%"><stop offset="0" stop-color="${C.green}" stop-opacity=".08"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".16"/><stop offset=".6" stop-color="${C.green}" stop-opacity=".05"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
    <g id="cobble">${tile(false)}</g>
    <g id="mossy">${tile(true)}</g>
  </defs>
  <g id="background">
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#tl)"/>
    <rect width="${W}" height="${H}" fill="url(#tr)"/>
    ${scene ? [ghost(170, 150, 30, .22), ghost(285, 470, 20, .16), ghost(110, 560, 14, .12), ghost(1085, 120, 26, .2), ghost(1170, 420, 34, .18), ghost(985, 575, 16, .14), ghost(345, 255, 11, .12), ghost(925, 300, 12, .12)].join("") : ""}
    <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  </g>
  ${scene ? `<g id="scene">
    <ellipse cx="${CX}" cy="545" rx="260" ry="170" fill="url(#glow)"/>
    ${island()}
    ${pickaxe()}
    <g fill="${C.cyan}" opacity=".55"><rect x="${CX - 120}" y="470" width="3" height="3"/><rect x="${CX + 128}" y="520" width="3" height="3"/><rect x="${CX - 96}" y="600" width="2" height="2"/><rect x="${CX + 92}" y="628" width="2" height="2"/></g>
  </g>` : ""}
  <g id="copy" font-family="${FONT}" text-anchor="middle">
    ${mark(CX - 30, scene ? 64 : 150, 60)}
    <text x="${CX}" y="${scene ? 166 : 252}" font-size="34" font-weight="700" fill="${C.text}" letter-spacing="-.3">CobbleBob</text>
    <text x="${CX}" y="${scene ? 252 : 342}" font-size="58" font-weight="700" fill="${C.text}" letter-spacing="-1">Back soon.</text>
    <text x="${CX}" y="${scene ? 300 : 392}" font-size="24" fill="${C.muted}">His adventure will continue.</text>
    <text x="${CX}" y="${scene ? 331 : 423}" font-size="24" fill="${C.muted}">Thanks for waiting.</text>
    ${v ? `<g id="status">
      <rect x="${CX - pillW / 2}" y="358" width="${pillW}" height="40" rx="20" fill="${C.surface}" stroke="${v.dot}" stroke-opacity=".55" stroke-width="1.5"/>
      <circle cx="${CX - pillW / 2 + 24}" cy="378" r="5.5" fill="${v.dot}"/>
      <text x="${CX + 10}" y="385" font-size="19" font-weight="600" fill="${C.text}">${v.label}</text>
    </g>` : ""}
  </g>
</svg>
`;
}

// The YouTube broadcast thumbnail: same scene, copy sized to read at ~360 px wide.
// Uploaded by hand in Studio (it is not a runtime asset).
function thumbnail() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>CobbleBob — live 24/7</title>
  <defs>
    <radialGradient id="tl" cx="10%" cy="-10%" r="75%"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".12"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
    <radialGradient id="tr" cx="100%" cy="0%" r="65%"><stop offset="0" stop-color="${C.green}" stop-opacity=".1"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".22"/><stop offset=".6" stop-color="${C.green}" stop-opacity=".07"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
    <g id="cobble">${tile(false)}</g>
    <g id="mossy">${tile(true)}</g>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#tl)"/>
  <rect width="${W}" height="${H}" fill="url(#tr)"/>
  ${[ghost(760, 110, 30, .2), ghost(1200, 80, 22, .16), ghost(1210, 560, 30, .16), ghost(735, 600, 18, .12)].join("")}
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <g transform="translate(1025 385) scale(1.95) translate(-640 -520)">
    <ellipse cx="${CX}" cy="545" rx="260" ry="170" fill="url(#glow)"/>
    ${island()}
    ${pickaxe()}
  </g>
  <g font-family="${FONT}">
    <rect x="80" y="120" width="276" height="68" rx="12" fill="#e5322d"/>
    <circle cx="116" cy="154" r="10" fill="#fff"/>
    <text x="140" y="168" font-size="40" font-weight="800" fill="#fff" letter-spacing=".5">LIVE 24/7</text>
    ${mark(76, 236, 120)}
    <text x="206" y="332" font-size="104" font-weight="800" fill="${C.text}" letter-spacing="-3">CobbleBob</text>
    <text x="82" y="458" font-size="58" font-weight="700" fill="${C.green}" letter-spacing="-1">An AI playing</text>
    <text x="82" y="526" font-size="58" font-weight="700" fill="${C.green}" letter-spacing="-1">Minecraft alone</text>
    <text x="82" y="592" font-size="34" fill="${C.muted}">No human at the controls.</text>
  </g>
</svg>
`;
}

function run(cmd, args) { execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] }); }

const previews = join(here, "previews");
rmSync(previews, { recursive: true, force: true });
mkdirSync(previews, { recursive: true });
for (const name of [...Object.keys(VARIANTS), "fallback"]) {
  const svg = join(here, `holding-${name}.svg`), png = join(here, `holding-${name}.png`), jpg = join(here, `holding-${name}.jpg`);
  writeFileSync(svg, card(name === "fallback" ? null : name));
  run("rsvg-convert", ["-w", String(W), "-h", String(H), "-b", C.bg, "-o", png, svg]);
  // yuvj420p baseline JPEG, like Chromium's screencast frames: no filter reinit on a scene cut.
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", png, "-pix_fmt", "yuvj420p", "-q:v", name === "fallback" ? "6" : "2", "-frames:v", "1", "-update", "1", jpg]);
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", png, "-vf", `crop=${CROP_W}:${H}:${CROP_X}:0`, "-frames:v", "1", "-update", "1", join(previews, `${name}-crop-9x16.png`)]);
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", png, "-vf", `drawbox=x=0:y=0:w=${CROP_X}:h=${H}:color=black@0.6:t=fill,drawbox=x=${CROP_X + CROP_W}:y=0:w=${W - CROP_X - CROP_W}:h=${H}:color=black@0.6:t=fill,drawbox=x=${CROP_X}:y=0:w=${CROP_W}:h=${H}:color=0x2ee6f0@0.9:t=2`, "-frames:v", "1", "-update", "1", join(previews, `${name}-crop-guide.png`)]);
  for (const [w, h] of [[854, 480], [480, 270]]) run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", png, "-vf", `scale=${w}:${h}:flags=area`, "-frames:v", "1", "-update", "1", join(previews, `${name}-${w}x${h}.png`)]);
  if (name === "fallback") rmSync(png);
}

// The last-resort card ships inside the code, so a missing asset directory can't leave the stream blank.
const fallback = readFileSync(join(here, "holding-fallback.jpg"));
writeFileSync(join(here, "..", "holding-fallback.mjs"), `// Generated by tools/stream/assets/build-holding.mjs — the last-resort holding card
// (plain "CobbleBob · Back soon." with no scene), embedded so it can't go missing.
export const FALLBACK_JPEG_BASE64 = "${fallback.toString("base64")}";
`);
rmSync(join(here, "holding-fallback.jpg"));

const thumbs = join(here, "youtube");
mkdirSync(thumbs, { recursive: true });
writeFileSync(join(thumbs, "thumbnail.svg"), thumbnail());
run("rsvg-convert", ["-w", String(W), "-h", String(H), "-b", C.bg, "-o", join(thumbs, "thumbnail.png"), join(thumbs, "thumbnail.svg")]);
run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(thumbs, "thumbnail.png"), "-q:v", "2", "-frames:v", "1", "-update", "1", join(thumbs, "thumbnail.jpg")]);
run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(thumbs, "thumbnail.png"), "-vf", "scale=360:202:flags=area", "-frames:v", "1", "-update", "1", join(previews, "thumbnail-360x202.png")]);
console.log(`built ${Object.keys(VARIANTS).length} variants + fallback (${fallback.length} B)`);
