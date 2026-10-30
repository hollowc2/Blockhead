import test from "node:test";
import assert from "node:assert/strict";
import type { PublicAction } from "../agent/public-actions.js";
import type { Capture } from "./gesture-collector.js";
import type { ObserverRecord, StatusRecord } from "./gesture-records.js";
import { runGestureTrial, type TrialDiagnostics, type TrialIO } from "./gesture-trial.js";

const RUN = "6f1c2a7e-3b9d-4c1e-8f2a-1d2e3f4a5b6c";
/** Virtual server + bot: ticks every 50 ms of virtual time into any armed capture. */
class World {
  now = 1_000_000; tick = 100; yaw = 10;
  captures: { records: ObserverRecord[]; open: boolean; seq: number }[] = [];
  dispatches = { refused: 0, dispatched: 0, interrupted: 0, uncertain: 0 };
  configuredActions = false; questions = true; safe = true; complete = true;
  requests: PublicAction[] = []; settings: [boolean, boolean][] = [];
  dropEffect: PublicAction | null = null; lose: PublicAction | null = null; visitorAt: number | null = null; failDisableOnce = false;
  push(fields: Record<string, unknown>) {
    for (const c of this.captures) if (c.open) c.records.push({ v: 1, run: RUN, seq: c.seq++, tick: this.tick, ms: this.now, ...fields } as ObserverRecord);
  }
  advance(ms: number) {
    for (let t = 0; t < ms; t += 50) {
      this.now += 50; this.tick++;
      this.push({ type: "tick", bob: { conn: 1, entity: 7, removed: false, x: 1, y: 64, z: 1, yaw: this.yaw, pitch: 0 } });
      if (this.visitorAt !== null && this.now >= this.visitorAt) { this.dispatches.dispatched++; this.visitorAt = null; }
    }
  }
  status(): StatusRecord { return { v: 1, run: RUN, seq: 0, tick: this.tick, ms: this.now, type: "status", agent: "1", mc: "1.21.4", supported: true, complete: this.complete, unhooked: false, failure: null, hooks: {} }; }
  io(log: Record<string, unknown>[] = []): TrialIO {
    return {
      now: () => this.now,
      sleep: async ms => { this.advance(ms); await Promise.resolve(); },
      observerStatus: async () => this.status(),
      arm: () => {
        const c = { records: [this.status()] as ObserverRecord[], open: true, seq: 1 };
        this.captures.push(c);
        const stop = async () => { if (c.open) { this.push({ type: "end", reason: "client", dropped: 0, faults: 0, hookCalls: 1, hookNanos: 1 }); c.open = false; } return { invalidLines: 0, truncated: false, closedEarly: false }; };
        return { ready: Promise.resolve(c.records[0] as StatusRecord), records: c.records, stop, closed: new Promise(() => undefined) } satisfies Capture;
      },
      diagnostics: async (): Promise<TrialDiagnostics> => ({ configuredActions: this.configuredActions, questionsEnabled: this.questions, actions: this.configuredActions && this.safe,
        actionsCooldownMs: 0, helloCooldownMs: 0, admissionSafe: this.safe, blocked: this.safe ? [] : ["active_task"], quarantined: false, gestureActive: false, dispatches: { ...this.dispatches } }),
      setActions: async (actions, questions) => {
        if (!actions && this.failDisableOnce) { this.failDisableOnce = false; throw new Error("socket"); }
        this.settings.push([actions, questions]); this.configuredActions = actions; this.questions = questions;
      },
      publicAction: async action => {
        this.requests.push(action);
        this.advance(50);
        if (this.lose === action) return { status: 0, delivery: "lost" as const };
        this.dispatches.dispatched++;
        if (this.dropEffect !== action) {
          if (action === "hello") { this.push({ type: "packet", kind: "ServerboundChatPacket", fixedHello: true }); this.push({ type: "effect", effect: "chat", fixedHello: true }); }
          if (action === "wave") { this.push({ type: "packet", kind: "ServerboundSwingPacket", hand: "main" }); this.push({ type: "effect", effect: "animate_broadcast", action: 0, self: false, recipients: 0 }); }
          if (action === "look_left" || action === "look_right") { this.yaw += action === "look_left" ? -45 : 45; this.push({ type: "packet", kind: "ServerboundMovePlayerPacket$Rot", hasPos: false, hasRot: true, yaw: this.yaw, pitch: 0 }); }
        }
        this.advance(50);
        return { status: 200, delivery: "sent" as const };
      },
      log: record => { log.push(record); },
    };
  }
}
const options = { windowMs: 120_000, captureWaitMs: 20_000 };

test("a clean trial requests each gesture once, passes on independent effects, and leaves actions verifiably off", async () => {
  const w = new World(), log: Record<string, unknown>[] = [];
  const report = await runGestureTrial(w.io(log), options);
  assert.equal(report.stop, "completed");
  assert.deepEqual(report.results.map(r => [r.action, r.outcome]), [["hello", "pass"], ["wave", "pass"], ["look_left", "pass"], ["look_right", "pass"]]);
  assert.deepEqual(w.requests, ["hello", "wave", "look_left", "look_right"]);
  assert.deepEqual(w.settings, [[true, true], [false, true]], "enabled once, disabled once, questions untouched");
  assert.equal(report.disabledVerified, true); assert.equal(w.configuredActions, false);
  assert.doesNotMatch(JSON.stringify(report), /"x":|"entity"/);
});

test("an absent effect stops the trial without a retry", async () => {
  const w = new World(); w.dropEffect = "wave";
  const report = await runGestureTrial(w.io(), options);
  assert.equal(report.stop, "not_pass");
  assert.deepEqual(w.requests, ["hello", "wave"]);
  assert.equal(report.results.at(-1)!.outcome, "fail");
  assert.equal(w.configuredActions, false); assert.equal(report.disabledVerified, true);
});

test("no eligible window ends with actions off and no request, not an endless wait", async () => {
  const w = new World(); w.safe = false;
  const report = await runGestureTrial(w.io(), { windowMs: 60_000, captureWaitMs: 20_000 });
  assert.equal(report.stop, "window_expired");
  assert.deepEqual(w.requests, []); assert.equal(w.configuredActions, false);
  assert(report.enabledMs !== null && report.enabledMs <= 60_000 + 30_000);
});

test("a lost response, another visitor's effect or an unready observer stops safely", async () => {
  const lost = new World(); lost.lose = "hello";
  assert.equal((await runGestureTrial(lost.io(), options)).stop, "transport");
  assert.deepEqual(lost.requests, ["hello"]); assert.equal(lost.configuredActions, false);

  const visitor = new World(); visitor.visitorAt = visitor.now + 6_000; // during the first gesture's post window
  assert.equal((await runGestureTrial(visitor.io(), options)).stop, "other_visitor");
  assert.equal(visitor.configuredActions, false);

  const unready = new World(); unready.complete = false;
  assert.equal((await runGestureTrial(unready.io(), options)).stop, "observer_not_ready");
  assert.deepEqual(unready.settings.filter(([actions]) => actions), [], "never enabled");
});

test("abort and a failing first disable still end with actions verifiably off", async () => {
  const w = new World(), controller = new AbortController(); w.safe = false; w.failDisableOnce = true;
  const running = runGestureTrial(w.io(), { ...options, signal: controller.signal });
  controller.abort();
  const report = await running;
  assert(["aborted", "window_expired"].includes(report.stop));
  assert.equal(report.disabledVerified, true); assert.equal(w.configuredActions, false);
});

test("actions already on before the trial is a preflight failure, then turned off", async () => {
  const w = new World(); w.configuredActions = true;
  const report = await runGestureTrial(w.io(), options);
  assert.equal(report.stop, "preflight_failed"); assert.deepEqual(w.requests, []);
  assert.equal(w.configuredActions, false); assert.equal(w.questions, true);
});
