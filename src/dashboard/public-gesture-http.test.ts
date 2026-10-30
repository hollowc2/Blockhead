import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { ACTION_TEXT, PublicInteractions } from "./public-interactions.js";
import { PublicActionController, type GestureBot } from "../agent/public-actions.js";
import { fakeGestureBot } from "../agent/public-actions.fixture.js";
import { WorldActionExecutor } from "../agent/world-actions.js";

const origin = "https://bob.example";
const headers = { origin, "content-type": "application/json" };
type Reply = { status: number; body: Record<string, unknown> };

function fixture(options: { manualTicks?: boolean; budgetMs?: number } = {}) {
  let now = 0, safe = true;
  const effects: unknown[] = [], records: Record<string, unknown>[] = [];
  const executor = new WorldActionExecutor();
  let bot: GestureBot & ReturnType<typeof fakeGestureBot> = fakeGestureBot(effects, options);
  const gestures = new PublicActionController({ session: () => bot, safe: () => safe, tryRun: (signal, action) => executor.tryRun("public", signal, action), budgetMs: options.budgetMs });
  const interactions = new PublicInteractions({ config: { allowed_origin: origin, questions_enabled: true, actions_enabled: true }, gestures,
    facts: () => ({ connected: true, health: 20, hunger: 20, activity: "idle", time: "day", actions: true }), now: () => now, log: r => records.push(r) });
  const server = createServer((req, res) => { void interactions.handle("action", req, res); });
  return { server, interactions, gestures, executor, effects, records, get bot() { return bot; }, replace: () => { bot = fakeGestureBot(effects, options); },
    setSafe: (value: boolean) => { safe = value; }, advance: (ms = 60_001) => { now += ms; } };
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); return address.port;
}
function post(port: number, action: string, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "POST", headers, signal }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
    });
    req.on("error", reject); req.end(JSON.stringify({ action }));
  });
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
const turn = () => new Promise(resolve => setImmediate(resolve));

test("a dispatched gesture says it was sent, never that Minecraft confirmed it", async () => {
  const f = fixture(), port = await listen(f.server);
  try {
    for (const action of ["hello", "wave", "look_left", "look_right"]) {
      const reply = await post(port, action);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.code, "ok"); assert.equal(reply.body.delivery, "sent"); assert.equal(reply.body.text, ACTION_TEXT.sent);
      assert.match(String(reply.body.text), /hasn't independently confirmed/); assert.doesNotMatch(String(reply.body.text), /\bdone\b|verified/i);
      f.advance();
    }
    assert.equal(f.effects.length, 4);
    // Private records carry the fixed dispatch outcome and request ID, never visitor content.
    const record = f.records.at(-1)!;
    assert.equal(record.dispatch, "dispatched"); assert.equal(typeof record.requestId, "string");
    assert.deepEqual(Object.keys(record).sort(), ["action", "answeredBy", "dispatch", "durationMs", "feature", "modelOutcome", "outcome", "reason", "requestId", "time"].sort());
  } finally { await close(f.server); }
});

test("a refusal after admission sends nothing and says so", async () => {
  const f = fixture(), port = await listen(f.server);
  try {
    const original = f.executor.tryRun.bind(f.executor);
    f.executor.tryRun = (owner, signal, action) => original(owner, signal, async lease => { f.setSafe(false); return action(lease); });
    const reply = await post(port, "wave");
    assert.equal(reply.status, 503); assert.equal(reply.body.code, "unavailable");
    assert.equal(reply.body.delivery, "not_sent"); assert.equal(reply.body.text, ACTION_TEXT.refused);
    assert.deepEqual(f.effects, []);
  } finally { await close(f.server); }
});

test("an interrupt after the packet was handed over is reported as sent-but-interrupted", async () => {
  const f = fixture({ manualTicks: true }), port = await listen(f.server);
  try {
    const pending = post(port, "look_left");
    while (f.effects.length === 0) await turn();
    f.interactions.cancel();
    f.bot.emit("physicsTick");
    const reply = await pending;
    assert.equal(reply.status, 503); assert.equal(reply.body.code, "unconfirmed");
    assert.equal(reply.body.delivery, "sent"); assert.equal(reply.body.text, ACTION_TEXT.interrupted);
    assert.equal(f.records.at(-1)!.dispatch, "interrupted");
    assert.equal(f.gestures.diagnostics().quarantined, false);
  } finally { await close(f.server); }
});

test("an unsettled primitive is uncertain, quarantines, and is never retried", async () => {
  const f = fixture({ manualTicks: true, budgetMs: 25 }), port = await listen(f.server);
  try {
    const reply = await post(port, "look_right");
    assert.equal(reply.status, 503); assert.equal(reply.body.code, "action_timeout");
    assert.equal(reply.body.delivery, "uncertain"); assert.equal(reply.body.text, ACTION_TEXT.uncertain);
    assert.equal(f.effects.length, 1, "exactly one attempt");
    assert.equal(f.interactions.availability().actionsReason, "busy");
    f.bot.emit("physicsTick"); await turn();
    f.replace(); f.advance();
    assert.equal(f.interactions.availability().actions, false, "quarantine survives settlement and a new session");
    const again = await post(port, "hello");
    assert.equal(again.body.delivery, "not_sent"); assert.equal(f.effects.length, 1);
  } finally { await close(f.server); }
});

test("a visitor disconnect mid-turn leaves an irreversible dispatch record and no queued work", async () => {
  const f = fixture({ manualTicks: true }), port = await listen(f.server);
  try {
    const abort = new AbortController();
    const pending = post(port, "look_left", abort.signal).catch(() => "aborted");
    while (f.effects.length === 0) await turn();
    abort.abort();
    // Let the server observe the closed connection before the physics tick writes the turn.
    await new Promise(resolve => setTimeout(resolve, 50));
    while (f.records.length === 0) { f.bot.emit("physicsTick"); await turn(); }
    assert.equal(await pending, "aborted");
    assert.equal(f.records[0]!.dispatch, "interrupted");
    assert.equal(f.executor.activeOwner, null); assert.equal(f.executor.pendingCount, 0);
    assert.equal(f.bot.listenerCount("physicsTick"), 0);
    assert.equal((f.interactions.diagnostics() as { actionsInFlight: number }).actionsInFlight, 0);
  } finally { await close(f.server); }
});

test("disabling actions and shutdown refuse before any effect", async () => {
  const f = fixture(), port = await listen(f.server);
  try {
    f.interactions.configure({ questions_enabled: true, actions_enabled: false });
    assert.equal((await post(port, "hello")).body.delivery, "not_sent");
    f.interactions.configure({ questions_enabled: true, actions_enabled: true });
    f.interactions.shutdown();
    assert.equal((await post(port, "wave")).body.delivery, "not_sent");
    assert.deepEqual(f.effects, []);
  } finally { await close(f.server); }
});
