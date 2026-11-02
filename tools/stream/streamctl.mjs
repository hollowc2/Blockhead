#!/usr/bin/env node
// Private operator control for the CobbleBob broadcast. Local files only: run
// it as the service user on Maia. Nothing here talks to YouTube or the bot.
//
//   streamctl status              current scene, reason codes, encoder progress
//   streamctl hold                latch the holding card ("Taking a break") until `auto`
//   streamctl auto                clear the latch; live returns after the admission window
//   streamctl reconnect-encoder   restart only ffmpeg (one short output interruption)
//   streamctl transitions [n]     last n scene transitions (default 20)
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.STREAM_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "cobblebob-stream");
const [command = "status", arg] = process.argv.slice(2);
mkdirSync(dir, { recursive: true, mode: 0o700 });

function status() {
  try { return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch { return null; }
}

switch (command) {
  case "status": {
    const s = status();
    if (!s) { console.log("no status yet (is cobblebob-stream.service running?)"); process.exit(1); }
    const age = Math.round((Date.now() - Date.parse(s.time)) / 1000);
    console.log(JSON.stringify({ ...s, statusFileAgeSeconds: age, latch: existsSync(join(dir, "maintenance")) }, null, 2));
    if (age > 10) console.log(`warning: status is ${age}s old — the streamer may be stopped or stuck`);
    break;
  }
  case "hold":
    writeFileSync(join(dir, "maintenance"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    console.log("maintenance latch set: the stream shows the holding card until `streamctl auto`");
    break;
  case "auto":
    rmSync(join(dir, "maintenance"), { force: true });
    console.log("latch cleared: live returns once bot, viewer and renderer are healthy for the admission window");
    break;
  case "reconnect-encoder":
    writeFileSync(join(dir, "reconnect-encoder.request"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    console.log("encoder reconnect requested (picked up within 1 s; output pauses briefly)");
    break;
  case "transitions": {
    const n = Math.max(1, Math.min(500, Number(arg) || 20));
    let lines = [];
    try { lines = readFileSync(join(dir, "transitions.jsonl"), "utf8").trim().split("\n"); } catch {}
    console.log(lines.slice(-n).join("\n") || "no transitions recorded");
    break;
  }
  default:
    console.error("usage: streamctl status|hold|auto|reconnect-encoder|transitions [n]");
    process.exit(2);
}
