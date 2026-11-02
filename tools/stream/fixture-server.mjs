#!/usr/bin/env node
// Local stand-in for the viewer shell and the bot's /health, for exercising the
// streamer without Minecraft. Loopback only. Never deploy or point at production.
//
//   node fixture-server.mjs [port]      (default 3999)
//   curl 'http://127.0.0.1:3999/set?viewer=offline'   viewer state shown in #viewerStatus
//   curl 'http://127.0.0.1:3999/set?bot=down'         /health reports disconnected (bot=up restores)
//   curl 'http://127.0.0.1:3999/set?freeze=8'         block the 3D frame's main thread for 8 s
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3999);
const control = { viewer: "connected", bot: "up", freeze: 0 };

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
  res.setHeader("content-type", "text/html");
  res.end(url.pathname === "/frame" ? frame : shell);
}).listen(port, "127.0.0.1", () => console.log(`fixture on 127.0.0.1:${port}`));
