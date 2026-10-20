import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { PublicProtocolObservations } from "./public-protocol-observations.js";

const selfUuid = "12345678-1234-1234-1234-123456789abc";
function fixture() {
  let now = 100;
  const client = Object.assign(new EventEmitter(), { write: () => { throw Error("observer must never send"); } });
  const bot = Object.assign(new EventEmitter(), {
    _client: client, version: "1.21.4", registry: minecraftData("1.21.4"),
    entity: { id: 1 }, player: { uuid: selfUuid },
    entities: { 7: { id: 7, name: "enderman", metadata: { 17: false, 18: false }, isValid: true } } as Record<number, unknown>,
  });
  const observer = new PublicProtocolObservations(bot as unknown as Bot, () => now);
  const emit = (name: string, data: unknown) => client.emit("packet", data, { name });
  return { observer, bot, client, emit, advance: (ms: number) => { now += ms; } };
}

test("version-bound metadata distinguishes known false, missing and timestamped observations; none proves calm", () => {
  const f = fixture(); f.observer.attach(); f.observer.attach();
  assert.equal(f.client.listenerCount("packet"), 1);
  let snapshot = f.observer.snapshot();
  assert.equal(snapshot.supported, true); assert.equal(snapshot.canProveCalm, false);
  assert.deepEqual(snapshot.endermen?.[0]?.creepy, { value: false, receivedAgeMs: null });
  f.emit("entity_metadata", { entityId: 7, metadata: [{ key: 17, value: true }, { key: 18, value: false }] });
  f.advance(3000); snapshot = f.observer.snapshot();
  assert.deepEqual(snapshot.endermen?.[0]?.creepy, { value: true, receivedAgeMs: 3000 });
  assert.equal(snapshot.canProveCalm, false); assert.equal(snapshot.pendingTarget, "not_transmitted");
  f.emit("entity_metadata", { entityId: 7, metadata: [{ key: 17, value: 0 }] });
  assert.equal(f.observer.snapshot().endermen?.[0]?.creepy.value, null);
  assert.equal(f.observer.snapshot().incomplete, true);
  f.bot.entities[8] = { id: 8, name: "enderman", metadata: {} };
  assert.deepEqual(f.observer.snapshot().endermen?.[1]?.creepy, { value: null, receivedAgeMs: null });
  f.bot.version = "1.21.5";
  assert.equal(f.observer.snapshot().supported, false);
  assert.equal(f.observer.snapshot().endermen?.[0]?.creepy.value, null);
  f.observer.detach();
});

test("only exact self hello echoes are counted; animation/corrections are never claimed as full effect acceptance", () => {
  const f = fixture(); f.observer.attach();
  f.emit("player_chat", { senderUuid: selfUuid.replaceAll("-", ""), plainMessage: "Hello, everyone!" });
  for (const packet of [{ senderUuid: "another-player", plainMessage: "Hello, everyone!" }, { senderUuid: selfUuid, plainMessage: "PRIVATE_CANARY" }, { plainMessage: "Hello, everyone!" }]) f.emit("player_chat", packet);
  f.emit("animation", { entityId: 2, animation: 0 }); f.emit("animation", { entityId: 1, animation: 3 });
  f.emit("animation", { entityId: 1, animation: 0 }); f.emit("position", { yaw: 42, flags: 255 });
  const snapshot = f.observer.snapshot();
  assert.equal(snapshot.helloEchoes, 1); assert.equal(snapshot.mainArmEchoes, 1); assert.equal(snapshot.positionCorrections, 1);
  assert.equal(snapshot.outgoingAttackOrUse, "not_observed");
  assert.equal(snapshot.normalSelfPoseAcknowledgement, "not_available");
  assert.equal(snapshot.effectAcceptance, "not_established");
  assert(!JSON.stringify(snapshot).includes(selfUuid)); assert(!JSON.stringify(snapshot).includes("PRIVATE_CANARY"));
  f.observer.detach();
});

test("lifecycle boundaries invalidate retained metadata and counters, remove listeners and cannot cross sessions", () => {
  const f = fixture(); f.observer.attach();
  for (const event of ["death", "respawn"]) {
    f.emit("entity_metadata", { entityId: 7, metadata: [{ key: 17, value: true }] });
    f.emit("player_chat", { senderUuid: selfUuid, plainMessage: "Hello, everyone!" });
    f.bot.emit(event);
    assert.equal(f.observer.snapshot().helloEchoes, 0);
    assert.equal(f.observer.snapshot().endermen?.[0]?.creepy.receivedAgeMs, null);
  }
  f.emit("entity_metadata", { entityId: 7, metadata: [{ key: 17, value: true }] });
  f.bot.emit("entityGone", f.bot.entities[7]);
  assert.equal(f.observer.snapshot().endermen?.[0]?.creepy.receivedAgeMs, null);
  f.bot.emit("end");
  assert.equal(f.client.listenerCount("packet"), 0); assert.equal(f.bot.listenerCount("death"), 0);
  assert.equal(f.bot.listenerCount("entityGone"), 0); assert.equal(f.observer.snapshot().attached, false);
  assert.deepEqual(f.observer.snapshot().endermen, []);
  f.observer.detach();
});

test("malformed, unsupported and oversized observations stay bounded without changing admission or throwing", () => {
  const f = fixture(); f.observer.attach();
  for (let i = 8; i < 208; i++) {
    f.bot.entities[i] = { id: i, name: "enderman", metadata: { 17: false } };
    f.emit("entity_metadata", { entityId: i, metadata: [{ key: 17, value: false }] });
  }
  for (const data of [null, [], { entityId: 7, metadata: {} }, { entityId: 7, metadata: [null] }]) f.emit("entity_metadata", data);
  const snapshot = f.observer.snapshot();
  assert.equal(snapshot.endermanCount, 201); assert.equal(snapshot.endermen?.length, 32);
  assert.equal(snapshot.truncated, true); assert.equal(snapshot.incomplete, true); assert.equal(snapshot.canProveCalm, false);
  f.bot.version = "future";
  f.emit("player_chat", { senderUuid: selfUuid, plainMessage: "Hello, everyone!" });
  assert.equal(f.observer.snapshot().helloEchoes, 0);
  f.observer.detach();
});

test("schema drift, unavailable registry, absent identity and a new session cannot establish evidence", () => {
  const f = fixture();
  assert.equal(f.observer.snapshot().attached, false);
  f.observer.attach();
  f.bot.registry = { entitiesByName: { enderman: { metadataKeys: [] } } } as never;
  f.emit("entity_metadata", { entityId: 7, metadata: [{ key: 17, value: false }] });
  assert.equal(f.observer.snapshot().supported, false);
  assert.equal(f.observer.snapshot().endermen?.[0]?.creepy.value, null);
  f.bot.registry = undefined as never;
  assert.equal(f.observer.snapshot().canProveCalm, false);
  f.bot.registry = minecraftData("1.21.4");
  f.bot.player.uuid = "";
  f.emit("player_chat", { senderUuid: "", plainMessage: "Hello, everyone!" });
  assert.equal(f.observer.snapshot().helloEchoes, 0);
  f.observer.detach();
  const next = fixture(); next.observer.attach();
  assert.equal(next.observer.snapshot().helloEchoes, 0);
  assert.equal(next.observer.snapshot().endermen?.[0]?.creepy.receivedAgeMs, null);
  next.observer.detach();
});
