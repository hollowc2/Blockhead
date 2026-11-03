#!/usr/bin/env node
// Local stand-in for the viewer shell and the bot's /health, for exercising the
// streamer without Minecraft. Loopback only. Never deploy or point at production.
//
//   node fixture-server.mjs [port]      (default 3999)
//   curl 'http://127.0.0.1:3999/set?viewer=offline'   viewer state shown in #viewerStatus
//   curl 'http://127.0.0.1:3999/set?bot=down'         /health reports disconnected (bot=up restores)
//   curl 'http://127.0.0.1:3999/set?freeze=8'         block the 3D frame's main thread for 8 s
//
// In a repo checkout it also serves the real broadcast page at /broadcast,
// with a fake 3D frame at /viewer/, the viewer's textures and canned
// public state at /api/state:
//   curl 'http://127.0.0.1:3999/set?state=edge'       normal | edge | empty (bot=down or viewer=offline: offline)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const port = Number(process.argv[2] ?? 3999);
const control = { viewer: "connected", bot: "up", freeze: 0, state: "normal" };

const shell = `<!doctype html><meta charset="utf-8"><title>fixture</title>
<style>body{margin:0;background:#123;color:#fff;font:20px sans-serif}.stage{position:absolute;inset:0}iframe{border:0;width:100%;height:100%}
footer{position:absolute;bottom:8px;left:8px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3c7;animation:p 1s infinite}@keyframes p{50%{opacity:.2}}</style>
<div class="stage"><iframe src="/frame"></iframe></div>
<footer><i class="dot"></i> FIXTURE WORLD · viewer <b id="viewerStatus">connecting</b> <button id="followToggle" aria-pressed="false">follow</button></footer>
<script>
document.addEventListener("keydown", e => { if (e.key === "t") document.getElementById("followToggle").setAttribute("aria-pressed", "true"); });
setInterval(async () => {
  const c = await (await fetch("/control")).json();
  document.getElementById("viewerStatus").textContent = c.viewer;
  if (c.freeze > 0) document.querySelector("iframe").contentWindow.postMessage({ freeze: c.freeze }, "*");
}, 500);
</script>`;

const frame = `<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow:hidden}</style><canvas width="1280" height="720"></canvas><script>
const g = document.querySelector("canvas").getContext("2d");
addEventListener("message", e => { const until = performance.now() + e.data.freeze * 1000; while (performance.now() < until) {} });
const draw = t => {
  g.fillStyle = "#3a6b35"; g.fillRect(0, 0, 1280, 720);
  for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? "#7f888f" : "#5a4632"; g.fillRect((i * 110 + t / 8) % 1400 - 60, 300 + Math.sin(t / 600 + i) * 120, 60, 60); }
  g.fillStyle = "#fff"; g.font = "bold 48px sans-serif"; g.fillText("FIXTURE LIVE WORLD " + (t / 1000).toFixed(1), 60, 100);
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
</script>`;

// The broadcast page's 3D frame: speaks the viewer lifecycle (scripts/viewer-lifecycle.mjs)
// for its visit token, shows the camera mode it was sent, and freezes on request.
const viewerFrame = `<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow:hidden}canvas{width:100vw;height:100vh;display:block}</style><canvas width="960" height="540"></canvas><script>
const token = new URLSearchParams(location.search).get("visit");
const send = state => { if (/^[a-f0-9-]{36}$/.test(token || "") && parent !== window) parent.postMessage({ type: "bob-viewer", version: 1, token, state }, location.origin); };
send("connecting"); setTimeout(() => send("socket-connected"), 300); setTimeout(() => send("ready"), 900);
let cam = "orbit"; addEventListener("bob-cam", e => { cam = e.detail; });
setInterval(async () => { const c = await (await fetch("/control")).json(); if (c.freeze > 0) { const until = performance.now() + c.freeze * 1000; while (performance.now() < until) {} } }, 500);
const g = document.querySelector("canvas").getContext("2d");
const draw = t => {
  const sky = g.createLinearGradient(0, 0, 0, 300); sky.addColorStop(0, "#79a6e0"); sky.addColorStop(1, "#b8d4ef");
  g.fillStyle = sky; g.fillRect(0, 0, 960, 540);
  g.fillStyle = "#5b8f3a"; g.fillRect(0, 300, 960, 240);
  for (let i = 0; i < 16; i++) { g.fillStyle = i % 3 ? "#7f888f" : "#6b4f32"; g.fillRect((i * 90 + t / 20) % 1040 - 60, 250 + (i % 4) * 50, 48, 48); }
  g.fillStyle = "#2a9fa1"; g.fillRect(452, 300, 56, 84); g.fillStyle = "#b98a63"; g.fillRect(458, 246, 44, 44); g.fillStyle = "#3b4190"; g.fillRect(452, 384, 56, 70);
  g.fillStyle = "#0008"; g.font = "bold 22px sans-serif"; g.fillText("FIXTURE WORLD · camera " + cam + " · " + (t / 1000).toFixed(1), 300, 520);
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
</script>`;

// Canned public state (the shape of toPublicViewerState). It moves with time so
// the inventory glow, the fresh story entry and the dial can be seen.
const started = Date.now();
const milestones = (ids) => ["day-1", "day-7", "logs-100", "stone-1000", "iron-pickaxe", "diamond", "kills-10", "builds-1"].map((id) => ({ id, title: id, description: id, unlocked: ids.includes(id), progress: ids.includes(id) ? 1 : 0.4 }));
const SCENES = {
  normal: ({ t, iso, at }) => ({
    status: { activity: "gathering", detail: "Collecting materials and supplies.", since: iso(420) },
    self: { health: 17, hunger: 14, dimension: "minecraft:overworld", timePhase: "day" },
    story: [
      { id: 40, at: iso(1500), icon: "night", text: "Night falls", highlight: false },
      { id: 41, at: at(started - 240_000), icon: "day", text: "A new day dawns", highlight: false },
      { id: 42, at: iso(200), icon: "build", text: "Finished building a small house!", highlight: true },
      { id: 43, at: iso(130), icon: "hostile", text: "Spotted a creeper", highlight: false },
      { id: 44, at: iso(70), icon: "tool", text: "His stone pickaxe broke", highlight: false },
      ...Array.from({ length: Math.floor(t / 20) }, (_, i) => ({ id: 45 + i, at: at(started + (i + 1) * 20_000), icon: "gather", text: `Gathered ${8 + i} cobblestone`, highlight: false })),
    ],
    world: { day: 12, blocksMined: 18342, itemsCrafted: 1204, mobsKilled: 87, deaths: 3, distanceKm: 41.7, buildsCompleted: 2, nemesis: "creeper", milestones: milestones(["day-1", "day-7", "logs-100", "iron-pickaxe", "kills-10", "builds-1"]) },
    inventory: items([["cobblestone", 37 + Math.floor(t / 6)], ["oak_log", 12], ["oak_planks", 20], ["stick", 9], ["torch", 23], ["bread", 6], ["coal", 14], ["iron_ingot", 4], ["dirt", 64], ["crafting_table", 1], ["white_bed", 1], ...(t > 12 ? [["raw_iron", 2]] : [])]),
    equipment: { hand: { name: "iron_pickaxe", count: 1 }, "off-hand": { name: "shield", count: 1 }, head: { name: "iron_helmet", count: 1 }, torso: null, legs: { name: "leather_leggings", count: 1 }, feet: { name: "iron_boots", count: 1 } },
  }),
  // Edge values: long words, low vitals, overflowing inventory, big counters, the Nether at night.
  edge: ({ iso }) => ({
    status: { activity: "recovering", detail: "Getting back on his feet: healing, eating or staying safe.", since: iso(5400) },
    self: { health: 5, hunger: 3, dimension: "minecraft:the_nether", timePhase: "night" },
    story: [
      { id: 900, at: iso(9000), icon: "goal", text: "Goal complete: Collect sixty-four polished blackstone bricks for the extension", highlight: true },
      { id: 901, at: iso(4000), icon: "explore", text: "Set out on an expedition", highlight: false },
      { id: 902, at: iso(600), icon: "death", text: "Was killed by a zombified piglin", highlight: true },
      { id: 903, at: iso(590), icon: "respawn", text: "Respawned and back on his feet", highlight: false },
      { id: 904, at: iso(30), icon: "unknown-icon", text: "Something with an unfamiliar icon happened", highlight: false },
    ],
    world: { day: 1234, blocksMined: 2_512_345, itemsCrafted: 98_765, mobsKilled: 4321, deaths: 112, distanceKm: 1234.5, buildsCompleted: 57, nemesis: "zombie villager", milestones: milestones(["day-1", "day-7", "logs-100", "stone-1000", "iron-pickaxe", "diamond", "kills-10", "builds-1"]) },
    inventory: items(["netherrack", "quartz", "blaze_rod", "gold_nugget", "cooked_porkchop", "golden_carrot", "obsidian", "flint_and_steel", "diamond", "polished_blackstone_brick_stairs", "cobbled_deepslate", "torch", "arrow", "bow", "ender_pearl", "water_bucket", "chest", "magma_cream", "nether_wart", "soul_sand"].map((name, i) => [name, i % 3 ? 64 * (i + 1) : 1])),
    equipment: { hand: { name: "netherite_sword", count: 1 }, "off-hand": { name: "polished_blackstone_brick_stairs", count: 63 }, head: { name: "diamond_helmet", count: 1 }, torso: { name: "netherite_chestplate", count: 1 }, legs: { name: "golden_leggings", count: 1 }, feet: { name: "chainmail_boots", count: 1 } },
  }),
  // A brand-new world: nothing carried, nothing told, no stats yet.
  empty: () => ({
    status: { activity: "resting", detail: "Taking a break between jobs.", since: null },
    self: { health: 20, hunger: 20, dimension: "minecraft:overworld", timePhase: "day" },
    story: [], world: { day: 0, blocksMined: 0, itemsCrafted: 0, mobsKilled: 0, deaths: 0, distanceKm: 0, buildsCompleted: 0, nemesis: null, milestones: milestones([]) },
    inventory: { items: [], totalItems: 0 },
    equipment: { hand: null, "off-hand": null, head: null, torso: null, legs: null, feet: null },
  }),
};
function items(pairs) { return { items: pairs.map(([name, count]) => ({ name, count })), totalItems: pairs.reduce((total, [, count]) => total + count, 0) }; }
function publicState() {
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const scene = (SCENES[control.state] ?? SCENES.normal)({ t: (now - started) / 1000, iso: (secondsAgo) => at(now - secondsAgo * 1000), at });
  const connected = control.bot === "up" && control.viewer !== "offline";
  return {
    public: true, connection: { connected }, viewer: { status: "running" }, ...scene,
    status: connected ? scene.status : { activity: "offline", detail: "CobbleBob isn't connected to the world right now.", since: null },
    self: connected ? scene.self : { health: null, hunger: null, dimension: null, timePhase: null },
    inventory: connected ? scene.inventory : null, equipment: connected ? scene.equipment : null,
  };
}

const PUBLIC_DIR = new URL("../../src/dashboard/public/", import.meta.url);
const VIEWER_DIR = new URL("../../node_modules/prismarine-viewer/public/", import.meta.url);
const BROADCAST_FILES = { "/broadcast": "broadcast.html", "/broadcast.css": "broadcast.css", "/broadcast.js": "broadcast.js", "/broadcast-panels.mjs": "broadcast-panels.mjs", "/viewer-session.mjs": "viewer-session.mjs" };
const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", png: "image/png", json: "application/json" };
// Mirrors SHELL_SECURITY_HEADERS' CSP (src/dashboard/http-guard.ts), so a violation shows up here too.
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
async function sendFile(res, url, csp) {
  try {
    const body = await readFile(url);
    const type = TYPES[url.pathname.split(".").pop()] ?? TYPES.html;
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...(csp ? { "content-security-policy": SHELL_CSP } : {}) });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/set") {
    for (const [k, v] of url.searchParams) control[k] = k === "freeze" ? Number(v) : v;
    if (control.freeze) setTimeout(() => { control.freeze = 0; }, 600);
    res.end(JSON.stringify(control)); return;
  }
  if (url.pathname === "/control") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(control)); return; }
  if (url.pathname === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ schema: 1, minecraft: { connected: control.bot === "up", health: 20, serverObservationAgeMs: 400 }, autonomy: { paused: false, reasons: [] }, llm: { state: "ok" } }));
    return;
  }
  if (url.pathname === "/api/state") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(publicState())); return; }
  if (BROADCAST_FILES[url.pathname]) { void sendFile(res, new URL(BROADCAST_FILES[url.pathname], PUBLIC_DIR), true); return; }
  if (url.pathname === "/viewer/" || url.pathname === "/viewer") { res.setHeader("content-type", "text/html"); res.end(viewerFrame); return; }
  if (/^\/viewer\/textures\/[A-Za-z0-9._/-]+\.(?:png|json)$/.test(url.pathname) && !url.pathname.includes("..")) {
    void sendFile(res, new URL(url.pathname.slice("/viewer/".length), VIEWER_DIR), false); return;
  }
  res.setHeader("content-type", "text/html");
  res.end(url.pathname === "/frame" ? frame : shell);
}).listen(port, "127.0.0.1", () => console.log(`fixture on 127.0.0.1:${port}`));
