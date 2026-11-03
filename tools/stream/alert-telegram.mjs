#!/usr/bin/env node
// STREAM_ALERT_COMMAND hook: posts one stream alert (JSON on stdin) to a Telegram chat.
//
//   STREAM_ALERT_COMMAND=/usr/bin/node %h/.local/share/cobblebob-stream/alert-telegram.mjs
//   node alert-telegram.mjs --test      sends a test message (no stdin needed)
//
// The bot token and chat come from a 0600 file, not the environment (the alert hook drops
// any variable naming a TOKEN): ~/.config/cobblebob-stream/telegram.env, or the path in
// STREAM_TELEGRAM_CONFIG, with lines TELEGRAM_BOT_TOKEN=... and TELEGRAM_CHAT_ID=...
// The token is never logged; errors name only the HTTP status or Telegram's description.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABELS = {
  "service-restarting": "Stream service keeps restarting",
  "encoder-exhausted": "Encoder out of restarts",
  "output-stalled": "Encoder not sending video",
  "not-live": "Broadcast not showing the live world",
  "picture-frozen": "Live picture frozen",
  "picture-black": "Live picture black",
  "holding-assets-missing": "Holding card missing",
};

export function parseConfig(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*"?([^"\s#]*)"?/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.TELEGRAM_BOT_TOKEN || !out.TELEGRAM_CHAT_ID) throw new Error("telegram config needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  return { token: out.TELEGRAM_BOT_TOKEN, chat: out.TELEGRAM_CHAT_ID };
}

const plain = value => String(value ?? "").replace(/[^\w .,:;'()/-]/g, "").slice(0, 200);

/** One alert event (as alerts.mjs emits it) as a short message. */
export function formatAlert(event) {
  const condition = plain(event?.condition);
  const label = LABELS[condition] ?? "Stream alert";
  if (event?.kind === "recovered") return `✅ CobbleBob stream recovered: ${label}`;
  if (event?.kind === "test") return "🔔 CobbleBob stream alerts are connected.";
  const since = Number.isFinite(event?.sinceSeconds) && event.sinceSeconds >= 60 ? ` (for ${Math.round(event.sinceSeconds / 60)} min)` : "";
  // Only fixed labels and a number leave Maia; event text (summary, detail) is never forwarded.
  return `⚠️ CobbleBob stream: ${label}${since}\nCheck: streamctl status`;
}

export async function send({ token, chat }, text, fetchImpl = fetch, timeoutMs = 8000) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) return;
  let description = "";
  try { description = plain((await res.json())?.description); } catch {}
  throw new Error(`telegram ${res.status}${description ? `: ${description}` : ""}`);
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 65536) break; }
  return data;
}

async function main() {
  const path = process.env.STREAM_TELEGRAM_CONFIG || join(homedir(), ".config/cobblebob-stream/telegram.env");
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must not be readable by group or others (chmod 600)`);
  const config = parseConfig(readFileSync(path, "utf8"));
  const event = process.argv.includes("--test") ? { kind: "test" } : JSON.parse(await readStdin());
  await send(config, formatAlert(event));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    // Never echo the token: error messages here carry only a status or Telegram's description.
    process.stderr.write(`alert-telegram: ${String(error?.message ?? error).replace(/bot[0-9]+:[\w-]+/g, "bot[redacted]")}\n`);
    process.exit(1);
  });
}
