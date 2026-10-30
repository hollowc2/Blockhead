import type { PublicAction } from "../agent/public-actions.js";
import type { ObserverRecord, TickRecord } from "./gesture-records.js";
import type { CaptureIntegrity } from "./gesture-collector.js";

/**
 * Correlation and tolerance rules, fixed before any trial (see
 * docs/public-gesture-enablement.md for their derivation). Changing them after
 * seeing trial results invalidates that trial.
 */
export const GESTURE_RULES = {
  /** Contiguous server ticks with Bob present, all before the request was sent (1 s). */
  baselineTicks: 20,
  /** The effect window runs from the request send to this long after the HTTP response. */
  settleMs: 1000,
  /** Contiguous ticks after the window, so late, duplicate or extra effects are seen (2 s). */
  postTicks: 40,
  /**
   * Server yaw is Notchian degrees: Mineflayer's toNotchianYaw(y) = deg(PI - y), so
   * look_left (+PI/4 rad locally) is -45 deg on the server and look_right +45.
   */
  expectedYawDeg: { look_left: -45, look_right: 45 } as Record<"look_left" | "look_right", number>,
  /**
   * Mineflayer quantizes the change to its 0.15 deg sensitivity grid (45 deg is exactly
   * 300 steps) and sends float32 degrees; float32 spacing below 1024 deg is <= 6.2e-5 deg.
   * 0.01 deg is far above serialization error and far below one 0.15 deg step.
   */
  yawToleranceDeg: 0.01,
  /** Pitch is re-sent unchanged; only float32 representation can differ. */
  pitchToleranceDeg: 0.001,
  /** Blocks, per axis. A grounded, stationary player does not move at all. */
  positionTolerance: 0.001,
  /** Tick-to-tick yaw differences at or below this are not a turn. */
  changeEpsilonDeg: 0.001,
} as const;

/** Packets Bob sends in normal idle operation. Movement packets are judged by pose. */
const AMBIENT = new Set(["ServerboundKeepAlivePacket", "ServerboundPongPacket", "ServerboundClientTickEndPacket", "ServerboundChunkBatchReceivedPacket",
  "ServerboundChatAckPacket", "ServerboundMovePlayerPacket$Pos", "ServerboundMovePlayerPacket$PosRot", "ServerboundMovePlayerPacket$Rot", "ServerboundMovePlayerPacket$StatusOnly"]);
const GESTURE_PACKETS = new Set(["ServerboundChatPacket", "ServerboundSwingPacket"]);
/** Packets that can attack, use, place, dig, move items/vehicles, change inputs or run commands. */
export const PROHIBITED_PACKETS = new Set(["ServerboundInteractPacket", "ServerboundUseItemPacket", "ServerboundUseItemOnPacket", "ServerboundPlayerActionPacket",
  "ServerboundContainerClickPacket", "ServerboundContainerButtonClickPacket", "ServerboundContainerClosePacket", "ServerboundContainerSlotStateChangedPacket",
  "ServerboundSetCarriedItemPacket", "ServerboundPickItemFromBlockPacket", "ServerboundPickItemFromEntityPacket", "ServerboundPlaceRecipePacket",
  "ServerboundEditBookPacket", "ServerboundSignUpdatePacket", "ServerboundChatCommandPacket", "ServerboundChatCommandSignedPacket",
  "ServerboundPlayerCommandPacket", "ServerboundPlayerInputPacket", "ServerboundMoveVehiclePacket", "ServerboundPaddleBoatPacket",
  "ServerboundSetCreativeModeSlotPacket", "ServerboundRenameItemPacket", "ServerboundSelectTradePacket", "ServerboundSetBeaconPacket",
  "ServerboundSetCommandBlockPacket", "ServerboundSetCommandMinecartPacket", "ServerboundSetJigsawBlockPacket", "ServerboundSetStructureBlockPacket",
  "ServerboundJigsawGeneratePacket", "ServerboundTeleportToEntityPacket", "ServerboundClientCommandPacket", "ServerboundChangeDifficultyPacket",
  "ServerboundLockDifficultyPacket", "ServerboundPlayerAbilitiesPacket", "ServerboundSelectBundleItemPacket"]);
/** Applied effects no gesture may cause. */
const PROHIBITED_EFFECTS = new Set(["attack", "interact", "use_item", "use_item_on", "drop", "open_menu", "block_action", "destroy_block", "damage_dealt"]);
/** Server interference or survival events: the interval cannot be attributed. */
const INTERFERENCE_EFFECTS = new Set(["correction", "force_rotation", "damage_taken"]);

/** Signs that other work shared the interval. */
const OVERLAP = new Set(["movement_overlap", "other_chat_overlap", "interference_damage_taken", "interference_correction", "interference_force_rotation",
  "prohibited_packet_outside_window", "prohibited_effect_outside_window", "lifecycle_respawn", "lifecycle_death", "lifecycle_disconnect", "lifecycle_login", "lifecycle_entity_changed"]);
/** Failures that hold whatever else was happening. */
const DEFINITE = new Set(["prohibited_packet", "prohibited_effect", "off_hand_swing", "unreported_effect"]);

export type EffectOutcome = "pass" | "fail" | "unknown";
export interface GestureRequest {
  action: PublicAction;
  /** Bot-host wall clock (Date.now()) just before the HTTP request was sent; same host clock as the server. */
  sentAtMs: number;
  respondedAtMs: number;
  /** The HTTP response's delivery field, or "lost" when no response arrived. */
  delivery: "sent" | "not_sent" | "uncertain" | "lost";
}
/** Sanitized: counts and deltas only, no coordinates, entity IDs or chat text. */
export interface GestureEvidence {
  baselineTicks: number; windowTicks: number; postTicks: number;
  chatPackets: number; fixedHelloPackets: number; chatEffects: number; fixedHelloEffects: number;
  swingPackets: { main: number; off: number }; swingCalls: { main: number; off: number };
  broadcasts: { main: number; off: number; other: number }; recipients: number[];
  rotationChanges: number; yawDeltaDeg: number | null; pitchDeltaDeg: number | null; maxPositionDelta: number | null;
  rotationPackets: number; prohibited: string[]; unknownPackets: number;
}
export interface GestureEvaluation { action: PublicAction; outcome: EffectOutcome; reasons: string[]; delivery: GestureRequest["delivery"]; evidence: GestureEvidence }

/** Signed difference in (-180, 180]. */
export function wrapDegrees(delta: number): number {
  let d = delta % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
}

/**
 * pass only when the capture is complete and unambiguous and the one expected
 * effect is independently present; fail on a definite violation; otherwise unknown.
 * HTTP success alone never passes: a missing effect with complete coverage fails.
 */
export function evaluateGesture(records: readonly ObserverRecord[], request: GestureRequest, rules = GESTURE_RULES, integrity?: CaptureIntegrity): GestureEvaluation {
  const fail: string[] = [], unknown: string[] = [];
  const evidence: GestureEvidence = { baselineTicks: 0, windowTicks: 0, postTicks: 0, chatPackets: 0, fixedHelloPackets: 0, chatEffects: 0, fixedHelloEffects: 0,
    swingPackets: { main: 0, off: 0 }, swingCalls: { main: 0, off: 0 }, broadcasts: { main: 0, off: 0, other: 0 }, recipients: [],
    rotationChanges: 0, yawDeltaDeg: null, pitchDeltaDeg: null, maxPositionDelta: null, rotationPackets: 0, prohibited: [], unknownPackets: 0 };
  const result = (): GestureEvaluation => ({ action: request.action, delivery: request.delivery, evidence,
    outcome: fail.length > 0 ? "fail" : unknown.length > 0 ? "unknown" : "pass", reasons: [...new Set([...fail, ...unknown])] });

  // ---- capture integrity: any doubt is unknown ----
  if (integrity && integrity.invalidLines > 0) unknown.push("invalid_records");
  if (integrity?.truncated) unknown.push("capture_truncated");
  const status = records[0];
  if (status?.type !== "status") { unknown.push("missing_status"); return result(); }
  if (!status.supported) unknown.push("observer_unsupported");
  if (!status.complete) unknown.push("hooks_incomplete");
  let lastTick: number | null = null, lastMs = 0;
  for (let i = 1; i < records.length; i++) {
    const r = records[i]!;
    if (r.run !== status.run) unknown.push("server_run_changed");
    if (r.seq !== i) unknown.push(r.seq < i ? "duplicate_or_reordered" : "sequence_gap");
    if (r.type === "overflow") unknown.push("overflow");
    if (r.type === "fault") unknown.push("observer_fault");
    if (r.type === "status") unknown.push("unexpected_status");
    if (r.ms + 50 < lastMs) unknown.push("clock_regression");
    lastMs = Math.max(lastMs, r.ms);
    if (r.type === "tick") {
      if (lastTick !== null && r.tick !== lastTick + 1) unknown.push("tick_discontinuity");
      lastTick = r.tick;
    } else if (lastTick !== null && r.tick < lastTick) unknown.push("tick_regression");
  }
  if (request.delivery === "not_sent") unknown.push("not_dispatched");
  if (!(request.respondedAtMs >= request.sentAtMs)) { unknown.push("bad_request_timing"); return result(); }

  // ---- correlation windows over the record order ----
  const ticks = records.map((r, i) => [r, i] as const).filter((e): e is readonly [TickRecord, number] => e[0].type === "tick");
  const windowEnd = request.respondedAtMs + rules.settleMs;
  const before = ticks.filter(([t]) => t.ms < request.sentAtMs);
  const inWindow = ticks.filter(([t]) => t.ms >= request.sentAtMs && t.ms <= windowEnd);
  const after = ticks.filter(([t]) => t.ms > windowEnd);
  const baseline = before.slice(-rules.baselineTicks);
  const post = after.slice(0, rules.postTicks);
  evidence.baselineTicks = baseline.length; evidence.windowTicks = inWindow.length; evidence.postTicks = post.length;
  if (baseline.length < rules.baselineTicks) unknown.push("insufficient_baseline");
  if (post.length < rules.postTicks) unknown.push("insufficient_post_window");
  if (inWindow.length === 0) unknown.push("empty_window");
  if (baseline.length === 0 || inWindow.length === 0) return result();
  const startIndex = baseline[0]![1], baseIndex = baseline.at(-1)![1], endIndex = inWindow.at(-1)![1];
  const lastIndex = (post.at(-1) ?? inWindow.at(-1)!)[1];
  const end = records.find(r => r.type === "end");
  if (end && records.indexOf(end) <= lastIndex) unknown.push("capture_ended_early");

  const span = [...baseline, ...inWindow, ...post].map(([t]) => t);
  const first = span[0]!.bob;
  for (const t of span) {
    if (t.bob === null || first === null) { unknown.push("bob_absent"); break; }
    if (t.bob.conn !== first.conn || t.bob.entity !== first.entity) unknown.push("connection_or_entity_changed");
    if (t.bob.removed) unknown.push("entity_removed");
  }
  const phase = (index: number): "baseline" | "window" | "post" | null => index < startIndex || index > lastIndex ? null : index <= baseIndex ? "baseline" : index <= endIndex ? "window" : "post";

  // ---- packets and applied effects ----
  let lateGesture = false;
  for (let i = startIndex; i <= lastIndex; i++) {
    const r = records[i]!, at = phase(i);
    if (r.type === "lifecycle") unknown.push(`lifecycle_${r.event}`);
    if (r.type === "packet") {
      if (r.kind === "unknown") { evidence.unknownPackets++; unknown.push("unknown_packet_type"); continue; }
      if (PROHIBITED_PACKETS.has(r.kind)) {
        if (at === "window") { fail.push("prohibited_packet"); evidence.prohibited.push(r.kind); } else unknown.push("prohibited_packet_outside_window");
        continue;
      }
      if (!AMBIENT.has(r.kind) && !GESTURE_PACKETS.has(r.kind)) { unknown.push("unexpected_packet"); continue; }
      if (GESTURE_PACKETS.has(r.kind) && at !== "window") { lateGesture = true; continue; }
      if (r.kind === "ServerboundChatPacket") { evidence.chatPackets++; if (r.fixedHello) evidence.fixedHelloPackets++; }
      if (r.kind === "ServerboundSwingPacket") { if (r.hand === "main") evidence.swingPackets.main++; else evidence.swingPackets.off++; }
      if (r.hasRot && at === "window") evidence.rotationPackets++;
    }
    if (r.type === "effect") {
      if (PROHIBITED_EFFECTS.has(r.effect)) {
        if (at === "window") { fail.push("prohibited_effect"); evidence.prohibited.push(r.effect); } else unknown.push("prohibited_effect_outside_window");
        continue;
      }
      if (INTERFERENCE_EFFECTS.has(r.effect)) { unknown.push(`interference_${r.effect}`); continue; }
      if (at !== "window") { lateGesture = true; continue; }
      if (r.effect === "chat") { evidence.chatEffects++; if (r.fixedHello) evidence.fixedHelloEffects++; }
      if (r.effect === "swing_call") { if (r.hand === "main") evidence.swingCalls.main++; else evidence.swingCalls.off++; }
      if (r.effect === "animate_broadcast") {
        if (r.action === 0) evidence.broadcasts.main++; else if (r.action === 3) evidence.broadcasts.off++; else evidence.broadcasts.other++;
        evidence.recipients.push(r.recipients ?? -1);
      }
    }
  }
  if (lateGesture) unknown.push("gesture_activity_outside_window");

  // ---- authoritative pose: baseline vs window, then the post window ----
  type Pose = NonNullable<TickRecord["bob"]>;
  const moved = (a: Pose, b: Pose): number => Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
  const turned = (a: Pose, b: Pose): boolean => Math.abs(wrapDegrees(b.yaw - a.yaw)) > rules.changeEpsilonDeg || Math.abs(b.pitch - a.pitch) > rules.changeEpsilonDeg;
  const reference = baseline.at(-1)![0].bob, last = inWindow.at(-1)![0].bob;
  if (reference === null || last === null) return result();
  // The baseline must be settled: any earlier motion makes the interval unattributable.
  for (const [t] of baseline) if (t.bob && (moved(t.bob, reference) > rules.positionTolerance || turned(t.bob, reference))) { unknown.push("baseline_not_settled"); break; }
  // Window: count distinct pose changes from the last baseline tick, and the furthest displacement.
  let changes = 0, maxPosition = 0, previous = reference;
  for (const [t] of inWindow) {
    if (!t.bob) continue;
    if (turned(previous, t.bob)) changes++;
    maxPosition = Math.max(maxPosition, moved(reference, t.bob));
    previous = t.bob;
  }
  evidence.rotationChanges = changes; evidence.maxPositionDelta = maxPosition;
  evidence.yawDeltaDeg = wrapDegrees(last.yaw - reference.yaw); evidence.pitchDeltaDeg = last.pitch - reference.pitch;
  // No gesture moves Bob: displacement means other work overlapped the window.
  if (maxPosition > rules.positionTolerance) unknown.push("movement_overlap");
  for (const [t] of post) if (t.bob && (turned(last, t.bob) || moved(last, t.bob) > rules.positionTolerance)) { unknown.push("post_window_activity"); break; }

  // ---- the one expected effect ----
  const quietChat = evidence.chatPackets === 0 && evidence.chatEffects === 0;
  const quietSwing = evidence.swingPackets.main + evidence.swingPackets.off === 0 && evidence.broadcasts.main + evidence.broadcasts.off + evidence.broadcasts.other === 0;
  const quietTurn = changes === 0;
  switch (request.action) {
    case "hello":
      if (evidence.chatPackets - evidence.fixedHelloPackets > 0 || evidence.chatEffects - evidence.fixedHelloEffects > 0) unknown.push("other_chat_overlap");
      if (evidence.fixedHelloPackets === 0 && evidence.fixedHelloEffects === 0) fail.push("effect_absent");
      else if (evidence.fixedHelloPackets > 1 || evidence.fixedHelloEffects > 1) fail.push("duplicate_effect");
      else if (evidence.fixedHelloEffects === 0) fail.push("not_accepted");
      else if (evidence.fixedHelloPackets === 0) unknown.push("effect_without_packet");
      if (!quietSwing) fail.push("unexpected_swing");
      if (!quietTurn) fail.push("unexpected_turn");
      break;
    case "wave":
      if (evidence.swingPackets.off > 0 || evidence.broadcasts.off > 0) fail.push("off_hand_swing");
      if (evidence.broadcasts.other > 0) fail.push("unexpected_animation");
      if (evidence.swingPackets.main === 0 && evidence.broadcasts.main === 0) fail.push("effect_absent");
      else if (evidence.swingPackets.main > 1 || evidence.broadcasts.main > 1) fail.push("duplicate_effect");
      else if (evidence.broadcasts.main === 0) fail.push("not_accepted");
      else if (evidence.swingPackets.main === 0) unknown.push("effect_without_packet");
      if (evidence.recipients.some(n => n < 0)) unknown.push("recipients_unknown");
      if (!quietChat) fail.push("unexpected_chat");
      if (!quietTurn) fail.push("unexpected_turn");
      break;
    case "look_left":
    case "look_right": {
      const expected = rules.expectedYawDeg[request.action];
      if (changes === 0) fail.push("effect_absent");
      else if (changes > 1) fail.push("extra_turn");
      else if (evidence.yawDeltaDeg === null || Math.abs(wrapDegrees(evidence.yawDeltaDeg - expected)) > rules.yawToleranceDeg) fail.push("wrong_turn");
      if (evidence.pitchDeltaDeg !== null && Math.abs(evidence.pitchDeltaDeg) > rules.pitchToleranceDeg) fail.push("pitch_changed");
      if (changes === 1 && evidence.rotationPackets === 0) unknown.push("turn_without_packet");
      if (!quietChat) fail.push("unexpected_chat");
      if (!quietSwing) fail.push("unexpected_swing");
      break;
    }
  }
  // Owner/survival work may preempt a trial and is never suppressed; when it overlaps the
  // window, gesture-specific findings cannot be attributed. Prohibited actions stay failures.
  if (unknown.some(reason => OVERLAP.has(reason))) {
    const attributable = fail.filter(reason => !DEFINITE.has(reason));
    fail.splice(0, fail.length, ...fail.filter(reason => DEFINITE.has(reason)));
    unknown.push(...attributable.map(reason => `${reason}_during_overlap`));
  }
  // Nothing dispatched: absence is expected (unknown, not a pass), but an applied effect the
  // controller says it never sent is a definite failure.
  if (request.delivery === "not_sent") {
    fail.splice(0, fail.length, ...fail.filter(reason => reason !== "effect_absent"));
    if (evidence.fixedHelloEffects + evidence.broadcasts.main + changes > 0) fail.push("unreported_effect");
  }
  return result();
}
