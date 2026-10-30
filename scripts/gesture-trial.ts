/**
 * Supervised public-gesture trial. Run ON MAIA, from the deployed runtime,
 * only under an explicit authorization naming this trial and its window.
 * See docs/public-gesture-enablement.md (Stage 3) before using it.
 *
 *   BLOCKHEAD_OPERATOR_TOKEN=... tsx scripts/gesture-trial.ts \
 *     --observer-socket <path> --origin <allowed_origin> --out <report.json> \
 *     [--public-url http://127.0.0.1:3003/api/public/action] [--window-seconds 600] [--capture-wait-seconds 60] \
 *     (--dry-run | --authorized-window)
 *
 * --dry-run checks observer health, a baseline and the private diagnostics,
 * and never enables actions. --authorized-window enables actions for at most
 * --window-seconds, requests each gesture at most once, stops on anything but
 * an independent pass, and always disables actions again (verified).
 * Ctrl-C/SIGTERM aborts and disables. Nothing here retries a public request.
 */
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import type { PublicAction } from "../src/agent/public-actions.js";
import { armObserver, observerStatus } from "../src/observer/gesture-collector.js";
import { runGestureTrial, type TrialDiagnostics, type TrialIO } from "../src/observer/gesture-trial.js";

const args = new Map<string, string>(), flags = new Set<string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === "--dry-run" || a === "--authorized-window") flags.add(a);
  else args.set(a.replace(/^--/, ""), process.argv[++i] ?? "");
}
const token = process.env.BLOCKHEAD_OPERATOR_TOKEN ?? "";
const socket = args.get("observer-socket"), origin = args.get("origin"), out = args.get("out");
const publicUrl = new URL(args.get("public-url") ?? "http://127.0.0.1:3003/api/public/action");
const windowSeconds = Number(args.get("window-seconds") ?? 600), captureWait = Number(args.get("capture-wait-seconds") ?? 60);
if (token.length < 32 || !socket || !origin || !out) throw new Error("needs BLOCKHEAD_OPERATOR_TOKEN, --observer-socket, --origin, --out");
if (flags.size !== 1) throw new Error("choose exactly one of --dry-run or --authorized-window");
if (publicUrl.hostname !== "127.0.0.1" || publicUrl.protocol !== "http:") throw new Error("public URL must be the loopback public shell");
if (!(windowSeconds >= 60 && windowSeconds <= 900) || !(captureWait >= 10 && captureWait <= 240)) throw new Error("window 60-900 s, capture wait 10-240 s");

function http(method: "GET" | "POST", url: URL, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request(url, { method, headers, timeout: 10_000 }, res => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", c => { if (text.length < 262_144) text += c; });
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.end(body);
  });
}
const operator = new URL("http://127.0.0.1:8155/public-interactions");
const auth = { authorization: `Bearer ${token}` };
async function diagnostics(): Promise<TrialDiagnostics> {
  const reply = await http("GET", operator, auth);
  if (reply.status !== 200) throw new Error(`diagnostics ${reply.status}`);
  const d = JSON.parse(reply.body);
  return {
    configuredActions: d.configuredActions === true, questionsEnabled: d.configuredQuestions === true, actions: d.actions === true,
    actionsCooldownMs: Number(d.actionsCooldownMs ?? Infinity), helloCooldownMs: Number(d.helloCooldownMs ?? Infinity),
    admissionSafe: d.admission?.safe === true, blocked: Object.entries(d.admission?.checks ?? {}).filter(([, v]) => v !== "pass").map(([k]) => k),
    quarantined: d.gesture?.quarantined !== false, gestureActive: d.gesture?.active !== false,
    dispatches: { refused: 0, dispatched: 0, interrupted: 0, uncertain: 0, ...(d.gesture?.dispatches ?? {}) },
  };
}
const log = (record: Record<string, unknown>) => process.stderr.write(JSON.stringify({ time: new Date().toISOString(), ...record }) + "\n");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { log({ event: "abort_requested", signal }); controller.abort(); });

const io: TrialIO = {
  now: () => Date.now(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  observerStatus: () => observerStatus(socket),
  arm: seconds => armObserver(socket, seconds),
  diagnostics,
  setActions: async (actions, questions) => {
    if (flags.has("--dry-run") && actions) throw new Error("dry run never enables actions");
    const reply = await http("POST", operator, { ...auth, "content-type": "application/json" }, JSON.stringify({ questions_enabled: questions, actions_enabled: actions }));
    if (reply.status !== 200) throw new Error(`configure ${reply.status}`);
  },
  publicAction: async (action: PublicAction) => {
    const reply = await http("POST", publicUrl, { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" }, JSON.stringify({ action }));
    const delivery = (() => { try { return JSON.parse(reply.body).delivery; } catch { return undefined; } })();
    return { status: reply.status, delivery: delivery === "sent" || delivery === "not_sent" || delivery === "uncertain" ? delivery : "lost" };
  },
  log,
};

let report: unknown;
if (flags.has("--dry-run")) {
  const status = await observerStatus(socket);
  const d = await diagnostics();
  const capture = armObserver(socket, 10);
  await capture.ready;
  await io.sleep(5000);
  const integrity = await capture.stop();
  const ticks = capture.records.filter(r => r.type === "tick");
  const bobPresent = ticks.every(t => t.type === "tick" && t.bob !== null);
  // Stage 2 readiness: every condition must hold before a window may be authorized.
  const ready = status.supported && status.complete && !status.unhooked && Object.values(status.hooks).filter(h => h === "installed").length === 22
    && integrity.invalidLines === 0 && !integrity.truncated && ticks.length >= 80 && bobPresent && !d.configuredActions && !d.quarantined;
  report = { mode: "dry-run", ready, observer: { supported: status.supported, complete: status.complete, unhooked: status.unhooked, hooks: status.hooks },
    capture: { ...integrity, records: capture.records.length, ticks: ticks.length, bobPresent },
    diagnostics: { configuredActions: d.configuredActions, admissionSafe: d.admissionSafe, blocked: d.blocked, quarantined: d.quarantined } };
} else {
  report = { mode: "authorized-window", windowSeconds, ...await runGestureTrial(io, { windowMs: windowSeconds * 1000, captureWaitMs: captureWait * 1000, signal: controller.signal }) };
}
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
log({ event: "report_written", out });
