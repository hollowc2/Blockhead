import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGesture, GESTURE_RULES, wrapDegrees, type GestureRequest } from "./gesture-evaluator.js";
import { parseObserverLine, type ObserverRecord } from "./gesture-records.js";

const RUN = "6f1c2a7e-3b9d-4c1e-8f2a-1d2e3f4a5b6c";
type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };
/** Builds an observer trace the way the agent emits it: seq in queue order, a tick record every 50 ms. */
class Trace {
  private records: Record<string, unknown>[] = [];
  private tick = 1000; ms = 1_000_000;
  pose: Pose = { x: 10.5, y: 64, z: -3.5, yaw: 10, pitch: 5 };
  conn = 1; entity = 42;
  constructor(private status: Record<string, unknown> = {}) {}
  ticks(n: number, change?: Partial<Pose>): this {
    for (let i = 0; i < n; i++) {
      this.tick++; this.ms += 50;
      if (change && i === 0) this.pose = { ...this.pose, ...change };
      this.records.push({ type: "tick", tick: this.tick, ms: this.ms, bob: { conn: this.conn, entity: this.entity, removed: false, ...this.pose } });
    }
    return this;
  }
  add(type: string, fields: Record<string, unknown>): this { this.records.push({ type, tick: this.tick, ms: this.ms, ...fields }); return this; }
  packet(kind: string, fields: Record<string, unknown> = {}): this { return this.add("packet", { kind, ...fields }); }
  effect(effect: string, fields: Record<string, unknown> = {}): this { return this.add("effect", { effect, ...fields }); }
  now(): number { return this.ms; }
  build(edit?: (records: Record<string, unknown>[]) => void): ObserverRecord[] {
    const records = [{ type: "status", tick: 1000, ms: 1_000_000, agent: "1", mc: "1.21.4", supported: true, complete: true, unhooked: false, failure: null, hooks: { tick: "installed" }, ...this.status },
      ...this.records].map((r, i) => ({ v: 1, run: RUN, seq: i, ...r }));
    edit?.(records);
    return records.map(r => { const parsed = parseObserverLine(JSON.stringify(r)); assert(parsed, `schema: ${JSON.stringify(r)}`); return parsed; });
  }
}
/** Baseline, request sent, the supplied window activity, response, settle and post ticks. */
function scenario(action: GestureRequest["action"], during: (t: Trace) => void, options: { baseline?: number; post?: number; delivery?: GestureRequest["delivery"]; trace?: Trace } = {}) {
  const t = options.trace ?? new Trace();
  t.ticks(options.baseline ?? 25);
  const sentAtMs = t.now() + 1;
  t.ticks(1);
  during(t);
  t.ticks(2);
  const respondedAtMs = t.now();
  t.ticks(GESTURE_RULES.settleMs / 50 + (options.post ?? 45));
  return { t, request: { action, sentAtMs, respondedAtMs, delivery: options.delivery ?? "sent" } satisfies GestureRequest };
}
const hello = (t: Trace) => t.packet("ServerboundChatPacket", { fixedHello: true }).effect("chat", { fixedHello: true });
const wave = (t: Trace) => t.packet("ServerboundSwingPacket", { hand: "main" }).effect("swing_call", { hand: "main" }).effect("animate_broadcast", { action: 0, self: false, recipients: 0 });
const turn = (degrees: number) => (t: Trace) => { const yaw = wrapDegrees(t.pose.yaw + degrees); t.packet("ServerboundMovePlayerPacket$Rot", { hasPos: false, hasRot: true, yaw, pitch: t.pose.pitch }).ticks(1, { yaw }); };
const judge = (action: GestureRequest["action"], during: (t: Trace) => void, options: Parameters<typeof scenario>[2] = {}, edit?: (r: Record<string, unknown>[]) => void) => {
  const { t, request } = scenario(action, during, options);
  return evaluateGesture(t.build(edit), request);
};

test("each gesture passes only with its one independently observed effect", () => {
  assert.deepEqual(judge("hello", hello).outcome, "pass");
  const w = judge("wave", wave);
  assert.equal(w.outcome, "pass"); assert.deepEqual(w.evidence.broadcasts, { main: 1, off: 0, other: 0 }); assert.deepEqual(w.evidence.recipients, [0]);
  const left = judge("look_left", turn(-45)), right = judge("look_right", turn(45));
  assert.equal(left.outcome, "pass", left.reasons.join()); assert.equal(right.outcome, "pass", right.reasons.join());
  assert.equal(left.evidence.yawDeltaDeg, -45); assert.equal(left.evidence.rotationChanges, 1);
  // Evidence never carries coordinates, entity IDs or text.
  assert.doesNotMatch(JSON.stringify(left), /10\.5|-3\.5|"entity"|Hello, everyone/);
});

test("HTTP success with the effect absent never passes", () => {
  for (const action of ["hello", "wave", "look_left", "look_right"] as const) {
    const result = judge(action, () => undefined);
    assert.equal(result.outcome, "fail", action); assert(result.reasons.includes("effect_absent"));
  }
  const rejected = judge("hello", t => t.packet("ServerboundChatPacket", { fixedHello: true }));
  assert.equal(rejected.outcome, "fail"); assert(rejected.reasons.includes("not_accepted"));
  const suppressed = judge("wave", t => t.packet("ServerboundSwingPacket", { hand: "main" }).effect("swing_call", { hand: "main" }));
  assert(suppressed.reasons.includes("not_accepted"), "a server-suppressed swing has no broadcast");
});

test("yaw wrap and float32/sensitivity quantization stay inside the pre-declared tolerance; anything else is a wrong turn", () => {
  for (const [action, start, delta] of [["look_left", -170, -45], ["look_right", 170, 45], ["look_left", 179.99, -45], ["look_right", -180, 45]] as const) {
    const t = new Trace(); t.pose.yaw = start;
    const result = judge(action, turn(delta), { trace: t });
    assert.equal(result.outcome, "pass", `${action} from ${start}: ${result.reasons}`);
  }
  assert.equal(judge("look_left", turn(-45.00006)).outcome, "pass");
  for (const delta of [-45.02, 45, -44.85, -90]) {
    const result = judge("look_left", turn(delta));
    assert.equal(result.outcome, "fail", String(delta)); assert(result.reasons.includes("wrong_turn"));
  }
  const pitch = judge("look_right", t => { turn(45)(t); t.ticks(1, { pitch: 5.01 }); });
  assert(pitch.reasons.includes("pitch_changed") || pitch.reasons.includes("extra_turn"));
  const extra = judge("look_right", t => { turn(45)(t); turn(45)(t); });
  assert.equal(extra.outcome, "fail"); assert(extra.reasons.includes("extra_turn"));
  assert.equal(wrapDegrees(-215), 145); assert.equal(wrapDegrees(180), 180); assert.equal(wrapDegrees(-180), 180);
});

test("arm selection: off-hand or extra swings fail, wrong-arm broadcasts fail", () => {
  const off = judge("wave", t => t.packet("ServerboundSwingPacket", { hand: "off" }).effect("animate_broadcast", { action: 3, self: false, recipients: 1 }));
  assert.equal(off.outcome, "fail"); assert(off.reasons.includes("off_hand_swing"));
  const twice = judge("wave", t => { wave(t); wave(t); });
  assert(twice.reasons.includes("duplicate_effect"));
  const unknownRecipients = judge("wave", t => t.packet("ServerboundSwingPacket", { hand: "main" }).effect("animate_broadcast", { action: 0, self: false, recipients: -1 }));
  assert.equal(unknownRecipients.outcome, "unknown");
  assert.equal(judge("hello", t => { hello(t); wave(t); }).outcome, "fail");
});

test("prohibited packets and effects fail in the window and are never a pass anywhere in the interval", () => {
  for (const kind of ["ServerboundUseItemPacket", "ServerboundInteractPacket", "ServerboundUseItemOnPacket", "ServerboundPlayerActionPacket", "ServerboundContainerClickPacket", "ServerboundChatCommandPacket", "ServerboundPlayerInputPacket"]) {
    const result = judge("wave", t => { wave(t); t.packet(kind); });
    assert.equal(result.outcome, "fail", kind); assert.deepEqual(result.evidence.prohibited, [kind]);
  }
  for (const effect of ["attack", "interact", "use_item", "use_item_on", "block_action", "destroy_block", "drop", "open_menu", "damage_dealt"]) {
    assert.equal(judge("hello", t => { hello(t); t.effect(effect); }).outcome, "fail", effect);
  }
  const earlier = new Trace(); earlier.ticks(20).packet("ServerboundUseItemPacket");
  assert.equal(judge("hello", hello, { trace: earlier, baseline: 5 }).outcome, "unknown", "prohibited activity in the baseline is overlap, not a pass");
  assert.equal(judge("look_left", t => { turn(-45)(t); t.packet("unknown"); }).outcome, "unknown", "unknown packet types invalidate absence claims");
  assert.equal(judge("hello", t => { hello(t); t.packet("ServerboundCommandSuggestionPacket"); }).outcome, "unknown");
});

test("missing, duplicate, reordered, dropped and overflowed records are unknown", () => {
  const cases: [string, (r: Record<string, unknown>[]) => void][] = [
    ["gap", r => { r.splice(10, 1); }],
    ["duplicate", r => { r.splice(10, 0, { ...r[10]! }); }],
    ["reordered", r => { const a = r[10]!.seq; r[10]!.seq = r[11]!.seq; r[11]!.seq = a; }],
    ["overflow", r => { r.splice(40, 0, { ...r[40]!, type: "overflow", dropped: 3, bob: undefined }); for (let i = 40; i < r.length; i++) r[i]!.seq = i; }],
    ["fault", r => { r.splice(40, 0, { v: 1, run: RUN, seq: 40, tick: r[40]!.tick, ms: r[40]!.ms, type: "fault", where: "tick" }); for (let i = 40; i < r.length; i++) r[i]!.seq = i; }],
    ["tick discontinuity", r => { for (let i = 30; i < r.length; i++) r[i]!.tick = (r[i]!.tick as number) + 5; }],
    ["server restart", r => { r[50]!.run = "00000000-0000-4000-8000-000000000000"; }],
    ["unsupported", r => { r[0]!.supported = false; }],
    ["incomplete hooks", r => { r[0]!.complete = false; }],
    ["ended early", r => { r.splice(35, 0, { v: 1, run: RUN, seq: 35, tick: r[35]!.tick, ms: r[35]!.ms, type: "end", reason: "client", dropped: 0, faults: 0, hookCalls: 1, hookNanos: 1 }); for (let i = 35; i < r.length; i++) r[i]!.seq = i; }],
  ];
  for (const [name, edit] of cases) {
    const result = judge("hello", hello, {}, edit);
    assert.equal(result.outcome, "unknown", `${name}: ${result.reasons}`);
  }
  for (const [options, reason] of [[{ baseline: 5 }, "insufficient_baseline"], [{ post: 3 }, "insufficient_post_window"]] as const) {
    const result = judge("look_right", turn(45), options);
    assert.equal(result.outcome, "unknown"); assert(result.reasons.includes(reason));
  }
  assert.equal(evaluateGesture([], { action: "hello", sentAtMs: 1, respondedAtMs: 2, delivery: "sent" }).outcome, "unknown");
});

test("lifecycle changes, removal and server corrections make the interval unknown", () => {
  for (const edit of [
    (t: Trace) => { hello(t); t.add("lifecycle", { event: "respawn" }); },
    (t: Trace) => { hello(t); t.add("lifecycle", { event: "disconnect" }); },
    (t: Trace) => { hello(t); t.add("lifecycle", { event: "death" }); },
    (t: Trace) => { hello(t); t.entity = 43; },
    (t: Trace) => { hello(t); t.conn = 2; },
    (t: Trace) => { hello(t); t.effect("correction"); },
    (t: Trace) => { hello(t); t.effect("damage_taken"); },
  ]) assert.equal(judge("hello", edit).outcome, "unknown");
});

test("owner or survival work overlapping the window is unknown, not suppressed into a pass or blamed on the gesture", () => {
  const walked = judge("look_left", t => { turn(-45)(t); t.ticks(1, { x: 11.5 }); });
  assert.equal(walked.outcome, "unknown"); assert(walked.reasons.includes("movement_overlap"));
  const owner = judge("hello", t => { hello(t); t.effect("chat", { fixedHello: false }); t.packet("ServerboundChatPacket", { fixedHello: false }); });
  assert.equal(owner.outcome, "unknown"); assert(owner.reasons.includes("other_chat_overlap"));
  const turnedWhileWalking = judge("wave", t => { wave(t); t.ticks(1, { x: 12, yaw: 30 }); });
  assert.equal(turnedWhileWalking.outcome, "unknown"); assert(turnedWhileWalking.reasons.includes("unexpected_turn_during_overlap"));
  const unsettled = new Trace(); unsettled.ticks(10).ticks(1, { yaw: 20 });
  assert.equal(judge("look_right", turn(45), { trace: unsettled, baseline: 15 }).reasons.includes("baseline_not_settled"), true);
  const resumed = judge("hello", t => { hello(t); }, {}, r => { const last = r.length - 10; (r[last]!.bob as Pose).x += 2; });
  assert.equal(resumed.outcome, "unknown"); assert(resumed.reasons.includes("post_window_activity"));
  // A prohibited action stays a failure even during overlap.
  assert.equal(judge("wave", t => { wave(t); t.ticks(1, { x: 12 }); t.packet("ServerboundUseItemPacket"); }).outcome, "fail");
});

test("transport and effect are judged separately: not-sent with no effect is unknown; an unreported effect fails", () => {
  assert.equal(judge("hello", () => undefined, { delivery: "not_sent" }).outcome, "unknown");
  const unreported = judge("hello", hello, { delivery: "not_sent" });
  assert.equal(unreported.outcome, "fail"); assert(unreported.reasons.includes("unreported_effect"));
  const lost = judge("wave", wave, { delivery: "lost" });
  assert.equal(lost.outcome, "pass"); assert.equal(lost.delivery, "lost");
  const late = judge("hello", () => undefined, {}, r => { r.splice(r.length - 10, 0, { ...r[r.length - 10]!, type: "effect", effect: "chat", fixedHello: true, bob: undefined }); for (let i = 0; i < r.length; i++) r[i]!.seq = i; });
  assert.notEqual(late.outcome, "pass"); assert(late.reasons.includes("gesture_activity_outside_window"));
});

test("record parsing rejects unknown types, extra fields, oversize lines and non-finite poses", () => {
  const ok = { v: 1, run: RUN, seq: 1, tick: 2, ms: 3, type: "effect", effect: "chat", fixedHello: true };
  assert(parseObserverLine(JSON.stringify(ok)));
  for (const bad of [{ ...ok, effect: "teleport_anyone" }, { ...ok, text: "hello" }, { ...ok, type: "raw" }, { ...ok, v: 2 }, { ...ok, run: "x" }])
    assert.equal(parseObserverLine(JSON.stringify(bad)), null);
  assert.equal(parseObserverLine("{\"v\":1," + " ".repeat(3000) + "}"), null);
  assert.equal(parseObserverLine('{"v":1,"run":"' + RUN + '","seq":1,"tick":1,"ms":1,"type":"tick","bob":{"conn":1,"entity":1,"removed":false,"x":NaN,"y":0,"z":0,"yaw":0,"pitch":0}}'), null);
  assert.equal(parseObserverLine("not json"), null);
});
