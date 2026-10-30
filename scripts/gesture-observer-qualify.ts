/**
 * Local qualification of the gesture observer against a disposable vanilla
 * 1.21.4 server. Never point this at production: it starts its own server in a
 * scratch directory on a loopback port, with disposable offline players.
 *
 *   tsx scripts/gesture-observer-qualify.ts --java <java25> --server-jar <official server.jar>
 *       --agent <gesture-observer.jar> --workdir <empty scratch dir> --out <result.json> [--port 25611] [--mode inert]
 *
 * --mode inert gives the agent an unusable socket path and checks that the
 * server still starts normally with the agent disabled (no hooks, one line).
 *
 * It drives the real PublicActionController + PublicInteractions HTTP handler
 * with real Mineflayer clients, collects the observer's records and evaluates
 * each request with the pre-declared rules. Negative scenarios deliberately
 * break a primitive to prove the evaluator does not pass them.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Bot } from "mineflayer";
import { createCobbleBob } from "../src/minecraft/bot.js";
import type { MinecraftConfig } from "../src/config/schema.js";
import { PublicActionController, type GestureBot, type PublicAction } from "../src/agent/public-actions.js";
import { PublicSafetyObservations, safePublicPhysicalState, safePublicThreatState } from "../src/agent/public-action-safety.js";
import { WorldActionExecutor } from "../src/agent/world-actions.js";
import { PublicInteractions } from "../src/dashboard/public-interactions.js";
import { armObserver, observerStatus } from "../src/observer/gesture-collector.js";
import { evaluateGesture, GESTURE_RULES, type GestureRequest } from "../src/observer/gesture-evaluator.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
const absolute = (name: string) => { const value = args.get(name); return value === undefined ? undefined : resolve(value); };
const java = absolute("java"), serverJar = absolute("server-jar"), agentJar = absolute("agent"), workdirArg = absolute("workdir"), out = absolute("out");
const port = Number(args.get("port") ?? 25611);
if (!java || !serverJar || !agentJar || !workdirArg || !out) throw new Error("missing arguments; see header");
const workdir = resolve(workdirArg);
if (workdir.includes("mc-server") || workdir.includes("blockhead-runtime") || (existsSync(workdir) && readdirSync(workdir).length > 0)) throw new Error("workdir must be a new, empty scratch directory");
if (!Number.isInteger(port) || port < 20000 || port === 25565) throw new Error("use an isolated non-default port");
mkdirSync(workdir, { recursive: true });
const ORIGIN = "https://qualify.invalid";
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);

// ---- disposable server ----
copyFileSync(serverJar, join(workdir, "server.jar"));
writeFileSync(join(workdir, "eula.txt"), "eula=true\n");
writeFileSync(join(workdir, "server.properties"), [
  "online-mode=false", `server-port=${port}`, "server-ip=127.0.0.1", "level-name=qualify-world", "level-type=minecraft\\:flat",
  "difficulty=peaceful", "spawn-monsters=false", "spawn-protection=0", "generate-structures=false", "enable-rcon=false", "enable-query=false",
  "white-list=false", "max-players=4", "view-distance=4", "simulation-distance=4", "sync-chunk-writes=false", "enable-command-block=false",
].join("\n") + "\n");
// Unix socket paths are limited to 108 bytes: use a short path relative to the scratch workdir.
process.chdir(workdir);
const inert = args.get("mode") === "inert";
const socketPath = inert ? `observer/${"x".repeat(120)}.sock` : "observer/observer.sock";
const player = "QualBob";
const serverStarted = performance.now();
const mc = spawn(java, ["-Xms512M", "-Xmx1G", `-javaagent:${resolve(agentJar)}=socket=${socketPath},player=${player}`, "-jar", "server.jar", "--nogui"], { cwd: workdir, stdio: ["pipe", "pipe", "pipe"] });
let serverLog = "";
mc.stdout.on("data", chunk => { serverLog += chunk; if (serverLog.length > 2_000_000) serverLog = serverLog.slice(-1_000_000); });
mc.stderr.on("data", chunk => { serverLog += chunk; });
const exited = new Promise<number | null>(resolveExit => mc.on("exit", code => resolveExit(code)));
async function waitFor(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) { if (Date.now() > until) throw new Error(`timeout: ${what}`); await sleep(50); }
}
const result: Record<string, unknown> = { recordedAt: new Date().toISOString(), node: process.version, java, rules: GESTURE_RULES,
  hashes: { serverJar: sha256(serverJar), agentJar: sha256(agentJar) } };

try {
  await waitFor(() => /Done \(/.test(serverLog), 180_000, "server start");
  result.serverStartSeconds = (performance.now() - serverStarted) / 1000;
  log("server up");
  if (inert) {
    result.inert = { serverStarted: true, disabledLine: /blockhead gesture observer disabled: IOException: socket path longer than 100 bytes/.test(serverLog),
      socketCreated: existsSync(join(workdir, "observer")) && readdirSync(join(workdir, "observer")).length > 0 };
    result.verdict = (result.inert as { disabledLine: boolean; socketCreated: boolean }).disabledLine && !(result.inert as { socketCreated: boolean }).socketCreated ? "inert_ok" : "inert_failed";
    throw new Error("inert mode complete");
  }
  result.statusBeforeLogin = await observerStatus(socketPath);

  // ---- disposable players ----
  const connect = (username: string): Promise<Bot> => new Promise((resolveBot, reject) => {
    const bot = createCobbleBob({ server: { host: "127.0.0.1", port, username } } as unknown as MinecraftConfig);
    bot.once("spawn", () => resolveBot(bot)); bot.once("error", reject); bot.once("kicked", reason => reject(new Error(String(reason))));
  });
  const bob = await connect(player);
  const viewer = await connect("QualViewer");
  const viewerSaw = { animations: 0, offHand: 0, hello: 0 };
  viewer._client.on("animation", (p: { entityId: number; animation: number }) => { if (p.entityId === bob.entity.id) { if (p.animation === 0) viewerSaw.animations++; if (p.animation === 3) viewerSaw.offHand++; } });
  viewer.on("chat", (username, message) => { if (username === player && message === "Hello, everyone!") viewerSaw.hello++; });
  const safety = new PublicSafetyObservations(bob); safety.attach();
  await waitFor(() => bob.entity.onGround && safety.fresh(), 20_000, "bob grounded and fresh");
  await sleep(2000);
  result.statusAfterLogin = await observerStatus(socketPath);
  log("players in", JSON.stringify(result.statusAfterLogin));

  // ---- the real controller and HTTP handler ----
  const executor = new WorldActionExecutor();
  const safe = (): boolean => safePublicPhysicalState(bob, 8) && safePublicThreatState(bob) && safety.fresh();
  const makeInteractions = () => {
    const gestures = new PublicActionController({ session: () => bob as unknown as GestureBot, safe, tryRun: (signal, action) => executor.tryRun("public-gesture", signal, action) });
    return { gestures, interactions: new PublicInteractions({ config: { allowed_origin: ORIGIN, questions_enabled: false, actions_enabled: true }, gestures,
      facts: () => ({ connected: true, health: bob.health, hunger: bob.food, activity: "idle", time: "day", actions: true }) }) };
  };
  let current = makeInteractions();
  const http = createServer((req, res) => { void current.interactions.handle("action", req, res); });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const httpPort = (http.address() as { port: number }).port;
  const post = (action: string): Promise<{ status: number; body: { code: string; delivery: GestureRequest["delivery"] } }> => new Promise((ok, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port: httpPort, method: "POST", path: "/", headers: { origin: ORIGIN, "content-type": "application/json" } }, res => {
      let body = ""; res.on("data", c => { body += c; }); res.on("end", () => ok({ status: res.statusCode!, body: JSON.parse(body) }));
    });
    req.on("error", fail); req.end(JSON.stringify({ action }));
  });

  // ---- one capture spanning a quiet period and every scenario ----
  const capture = armObserver(socketPath, 240);
  const armedStatus = await capture.ready;
  const requests: { name: string; expect: "pass" | "not_pass"; request: GestureRequest; http: number; code: string }[] = [];
  const settleMs = GESTURE_RULES.settleMs + GESTURE_RULES.postTicks * 50 + 500;
  await sleep(GESTURE_RULES.baselineTicks * 50 + 2000);
  const quietUntil = Date.now();
  async function trial(name: string, action: PublicAction, expect: "pass" | "not_pass", sabotage?: () => () => void) {
    current = makeInteractions();
    await waitFor(() => current.gestures.available(), 30_000, `${name} admission`);
    await sleep(GESTURE_RULES.baselineTicks * 50 + 300);
    const restore = sabotage?.();
    const sentAtMs = Date.now();
    let reply: Awaited<ReturnType<typeof post>> | null = null;
    try { reply = await post(action); } catch { reply = null; }
    const respondedAtMs = Date.now();
    restore?.();
    requests.push({ name, expect, http: reply?.status ?? 0, code: reply?.body.code ?? "lost",
      request: { action, sentAtMs, respondedAtMs, delivery: reply?.body.delivery ?? "lost" } });
    log(name, reply?.status, reply?.body.code, reply?.body.delivery);
    await sleep(settleMs);
  }
  for (const action of ["hello", "wave", "look_left", "look_right"] as const) await trial(action, action, "pass");
  await trial("absent_chat_with_http_success", "hello", "not_pass", () => { const chat = bob.chat; bob.chat = () => undefined; return () => { bob.chat = chat; }; });
  await trial("off_hand_swing", "wave", "not_pass", () => { const swing = bob.swingArm; bob.swingArm = () => swing.call(bob, "left"); return () => { bob.swingArm = swing; }; });
  await trial("prohibited_use_item", "wave", "not_pass", () => { const swing = bob.swingArm; bob.swingArm = (arm) => { swing.call(bob, arm); bob.activateItem(); bob.deactivateItem(); }; return () => { bob.swingArm = swing; }; });
  await trial("wrong_direction", "look_left", "not_pass", () => { const look = bob.look; bob.look = (yaw, pitch, force) => look.call(bob, yaw - Math.PI / 2, pitch, force); return () => { bob.look = look; }; });
  await trial("extra_turn", "look_right", "not_pass", () => {
    const look = bob.look;
    // A second, separate turn two physics ticks later (after the gesture's own packet was written).
    bob.look = async (yaw, pitch, force) => {
      await look.call(bob, yaw, pitch, force);
      let ticks = 0;
      const again = (): void => { if (++ticks < 2) return; bob.off("physicsTick", again); void look.call(bob, yaw + Math.PI / 4, pitch, true); };
      bob.on("physicsTick", again);
    };
    return () => { bob.look = look; };
  });
  const integrity = await capture.stop();
  const records = capture.records;
  const end = records.find(r => r.type === "end");

  // ---- evaluation, with rules fixed before the run ----
  const evaluations = requests.map(r => ({ name: r.name, expect: r.expect, http: r.http, code: r.code, ...evaluateGesture(records, r.request, GESTURE_RULES, integrity) }));
  const quiet = records.filter(r => r.ms <= quietUntil && r.ms >= (records[1]?.ms ?? 0) && (r.type === "effect" || (r.type === "packet" && !r.kind.startsWith("ServerboundMovePlayer") && r.kind !== "ServerboundKeepAlivePacket" && r.kind !== "ServerboundClientTickEndPacket")));
  const ticks = records.filter(r => r.type === "tick");
  const intervals = ticks.slice(1).map((t, i) => t.ms - ticks[i]!.ms);

  // ---- teardown: collection off, hooks removed, capture after unhook is empty ----
  await sleep(500);
  const unhook = await new Promise<string>((ok, fail) => {
    import("node:net").then(({ connect: c }) => { const s = c(socketPath); let b = ""; s.on("connect", () => s.write("UNHOOK\n")); s.on("data", d => { b += d; }); s.on("close", () => ok(b.trim())); s.on("error", fail); });
  });
  const afterUnhook = armObserver(socketPath, 3);
  await afterUnhook.ready.catch(() => undefined);
  await sleep(1500);
  await afterUnhook.stop();
  result.unhook = { status: JSON.parse(unhook), ticksAfterUnhook: afterUnhook.records.filter(r => r.type === "tick").length, recordsAfterUnhook: afterUnhook.records.length };

  Object.assign(result, {
    armedStatus, integrity, recordCount: records.length, end,
    overhead: end && end.type === "end" ? { hookCalls: end.hookCalls, hookNanos: end.hookNanos, meanNanosPerCall: end.hookCalls ? Math.round(end.hookNanos / end.hookCalls) : null } : null,
    tickIntervalMs: { count: intervals.length, mean: intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length), max: Math.max(...intervals) },
    quietPeriodNonAmbient: quiet.map(r => r.type === "effect" ? r.effect : r.type === "packet" ? r.kind : r.type),
    viewerCrossCheck: viewerSaw,
    evaluations,
    verdict: evaluations.every(e => e.expect === "pass" ? e.outcome === "pass" : e.outcome !== "pass") ? "qualified" : "not_qualified",
  });
  http.close(); safety.detach(); bob.quit(); viewer.quit();
  await sleep(500);
} catch (error) {
  if (!inert) result.error = String(error);
  result.serverLogTail = serverLog.slice(-4000).replace(/\d+\.\d+, \d+\.\d+, \d+\.\d+/g, "<pos>");
} finally {
  mc.stdin.write("stop\n");
  const code = await Promise.race([exited, sleep(30_000).then(() => { mc.kill("SIGKILL"); return "killed"; })]);
  result.serverExit = code;
  result.verifyErrors = /VerifyError|ClassFormatError|LinkageError/.test(serverLog);
  result.agentErrors = /blockhead\.observer/.test(serverLog);
  result.java = "maia runtime copy";
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  log("wrote", out, result.verdict ?? result.error);
}
