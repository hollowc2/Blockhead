import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { MinecraftConfigSchema } from "../config/schema.js";
import type { DashboardSnapshot } from "./types.js";
import { cachedPublicState, toPublicViewerState } from "./public-state.js";

/** A snapshot full of things that must never reach the public listener. */
const secretSnapshot = (): DashboardSnapshot => ({
  schema: 1, process: { startedAt: "2026-01-01T00:00:00.000Z", uptimeSeconds: 42 },
  connection: { connected: true, player: "CobbleBob", server: "mc.secret-host.example:25565" },
  viewer: { enabled: true, status: "running", port: 3001, distance: 6, failure: null },
  self: { health: 19.5, hunger: 17, position: { x: 1234.5, y: 64, z: -987.25 }, dimension: "overworld", timePhase: "day" },
  goal: { id: "g1", description: "Guard HomeBase at 1200 64 -950", source: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z", currentStep: "walk home", successCriteria: [], recentResults: [], note: "owner OwnerSecretName asked", endedAt: null } as never,
  task: { id: "t1", type: "goto", priority: "high", source: "owner", objective: "return to base 1200 64 -950", status: "running", createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, completedAt: null, phase: null, attempts: 1, lastError: "/home/corey/secret/path.ts:12" } as never,
  buildProject: null,
  action: { label: "Walking to 1200 64 -950", taskId: "t1" },
  background: { label: "Mining diamonds", taskId: null },
  stockpiles: null,
  inventory: { items: [{ name: "diamond", count: 12 }], totalItems: 12 },
  danger: { score: 1, nearestHostile: { type: "zombie", distance: 5 }, hostileCount: 1 },
  llmLastCall: { at: null, latencyMs: 100, tool: "goto", rationale: "SECRET-PROMPT-RATIONALE" },
  llmActivity: { state: "thinking", thinking: true, decisionType: "owner_instruction", thinkingStartedAt: null, thinkingDurationMs: null, model: "secret-model", endpoint: "http://10.0.0.5:8080/v1?api_key=sk-SECRET", lastAction: "goto", lastRationale: "SECRET-PROMPT-RATIONALE", lastLatencyMs: 100, lastFailure: { at: "x", kind: "http", error: "stack at /home/corey" } },
  path: { status: "moving", destination: { x: 1200, y: 64, z: -950 }, distance: 40 },
  recentEvents: [{ at: "x", kind: "home", message: "home set at 1200 64 -950" }],
  recentFailures: [{ at: "x", kind: "error", message: "Error: at /mnt/Repos/Games/Blockhead/src/x.ts" }],
  recentChat: [{ at: "x", sender: "OwnerSecretName", message: "the base is at 1200 64 -950" }],
});

test("public state is an allowlisted, redacted projection", () => {
  assert.deepEqual(toPublicViewerState(secretSnapshot()), {
    public: true,
    connection: { connected: true },
    status: { activity: "resting", detail: "Taking a break between jobs.", since: null },
    self: { health: 20, hunger: 17, dimension: "overworld", timePhase: "day", timeOfDay: null },
    viewer: { status: "running" },
    story: [],
    world: null,
    inventory: { items: [{ name: "diamond", count: 12 }], totalItems: 12 },
    equipment: null,
    now: { label: "Taking a break between jobs.", step: null, progress: null },
    build: null,
    brain: { thinking: true, decisionsLastHour: 0, lastLatencyMs: null, model: null },
    thinking: null,
    vitals: [],
    uptimeSeconds: 42,
  });
});

test("public state passes story and world stats through, but only their allowlisted fields", () => {
  const snapshot = {
    ...secretSnapshot(),
    story: [{ id: 3, at: "2026-01-01T00:00:00.000Z", icon: "build", text: "Finished building a cottage!", highlight: true, secret: "1200 64 -950" }],
    world: { day: 12, blocksMined: 5, itemsCrafted: 1, mobsKilled: 2, deaths: 1, distanceKm: 3.5, buildsCompleted: 1, nemesis: "zombie", milestones: [] },
  } as unknown as DashboardSnapshot;
  const state = toPublicViewerState(snapshot);
  assert.deepEqual(state.story, [{ id: 3, at: "2026-01-01T00:00:00.000Z", icon: "build", text: "Finished building a cottage!", highlight: true }]);
  assert.equal(state.world?.day, 12);
  assert.equal(JSON.stringify(state).includes("1200"), false);
});

test("public state leaks no coordinates, names, chat, LLM data or internals", () => {
  const body = JSON.stringify(toPublicViewerState(secretSnapshot()));
  for (const secret of ["1234", "987", "1200", "-950", "OwnerSecretName", "CobbleBob", "secret", "SECRET", "/home", "/mnt", "zombie", "position", "chat", "llm", "3001", "Walking", "goal", "task"]) {
    assert.equal(body.includes(secret), false, `public state contains ${secret}`);
  }
});

test("public gear exposes only item types and counts, with no custom names or metadata", () => {
  const snapshot = secretSnapshot();
  const sword = { name: "iron_sword", count: 1, displayName: "OwnerSecretName", nbt: { base: "1200 64 -950" } };
  snapshot.equipment = { hand: sword, "off-hand": null, head: null, torso: null, legs: null, feet: null };
  snapshot.inventory = { items: [sword], totalItems: 1 };
  const state = toPublicViewerState(snapshot);
  assert.deepEqual(state.equipment, { hand: { name: "iron_sword", count: 1 }, "off-hand": null, head: null, torso: null, legs: null, feet: null });
  assert.deepEqual(state.inventory, { items: [{ name: "iron_sword", count: 1 }], totalItems: 1 });
  assert.notEqual(state.equipment?.hand, sword);
  assert.equal(JSON.stringify(state).includes("OwnerSecretName"), false);
  snapshot.connection.connected = false;
  assert.equal(toPublicViewerState(snapshot).equipment, null);
  assert.equal(toPublicViewerState(snapshot).inventory, null);
});

test("public state is cached so polling does not drive snapshot cost", async () => {
  let calls = 0;
  let now = 0;
  const state = cachedPublicState(() => { calls += 1; return secretSnapshot(); }, 1000, () => now);
  await state();
  await state();
  now = 999;
  await state();
  assert.equal(calls, 1);
  now = 1000;
  await state();
  assert.equal(calls, 2);
});

test("a failed snapshot is not cached", async () => {
  let fail = true;
  const state = cachedPublicState(() => { if (fail) throw new Error("boom"); return secretSnapshot(); }, 1000, () => 0);
  await assert.rejects(state());
  fail = false;
  assert.equal((await state()).public, true);
});

/**
 * The broadcast fields' inputs, every one of them hostile: coordinates in
 * goal and task text, owner names in chat-derived names and build goals,
 * hosts in errors and the model endpoint, digits in the rationale.
 */
const HOSTILE_RATIONALE = "Mine iron near OwnerSecretName's base at 1200 64 -950 via mc.secret-host.example";
const broadcastSnapshot = (): DashboardSnapshot => {
  const snapshot = secretSnapshot();
  snapshot.goal = {
    id: "g1", description: "Guard HomeBase at 1200 64 -950 for OwnerSecretName", source: "background", status: "active" as never, createdAt: "2026-01-01T00:00:00.000Z",
    currentStep: "walk to OwnerSecretName at 1200 64 -950", note: "OwnerSecretName asked", endedAt: null,
    recentResults: [{ action: "collect_resource", outcome: "failed", message: "Error at /home/corey 1200 64 -950", at: "x" }],
    successCriteria: [{ kind: "inventory", stockpile: null, item: "iron_ingot", min: 10, label: "carried iron_ingot >= 10 at 1200 64 -950" }],
  };
  snapshot.task = { id: "t2", type: "collect_resource", priority: 70, source: "owner", objective: "mine iron at 1200 64 -950 for OwnerSecretName", status: "active", createdAt: "x", startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, phase: "walk to 1200 64 -950", attempts: 3, lastError: "mc.secret-host.example refused" } as never;
  snapshot.inventory = { items: [{ name: "iron_ingot", count: 3 }], totalItems: 3 };
  snapshot.buildProject = {
    id: "b1", source: "user", userGoal: "Build OwnerSecretName a cottage at 1200 64 -950", origin: { x: 1200, y: 64, z: -950 }, structureType: "cottage", status: "active",
    phase: { id: "p1", label: "walls at 1200 64 -950", status: "active", verifiedOperations: 2, totalOperations: 9 }, verifiedOperations: 42, totalOperations: 100,
    currentShortage: { material: "glass", required: 18, available: 0 } as never, lastBlockingReason: "Need 18 glass from OwnerSecretName", blocker: "Need 18 glass; missing 18 sand at 1200 64 -950.", blueprintHash: "hash-SECRET",
  };
  snapshot.broadcast = {
    vitals: [{ at: "2026-01-01T00:00:00.000Z", health: 19.6, hunger: 17.2 }, { at: "2026-01-01T00:01:00.000Z", health: null, hunger: null }],
    decisionsLastHour: 37,
    lastDecision: { at: "2026-01-01T00:02:00.000Z", latencyMs: 812.4, tool: "collect_resource", callType: "background_director", rationale: HOSTILE_RATIONALE },
    privateTerms: ["OwnerSecretName", "mc.secret-host.example", "secret-host"],
    modelLabel: "Qwen3.5 9B",
  };
  snapshot.process.uptimeSeconds = 4242.9;
  return snapshot;
};
/** What may never appear anywhere in the public JSON built from broadcastSnapshot. */
const BROADCAST_SECRETS = ["1200", "950", "1234", "987", "OwnerSecretName", "ownersecretname", "CobbleBob", "secret", "SECRET", "HomeBase", "/home", "10.0.0.5", "8080", "Need", "glass", "sand", "walk", "walls", "refused", "userGoal", "origin", "blocker", "endpoint", "objective", "description", "Guard"];
const assertNoBroadcastLeak = (state: unknown): void => {
  const body = JSON.stringify(state);
  for (const secret of BROADCAST_SECRETS) assert.equal(body.includes(secret), false, `public state contains ${secret}`);
};

test("broadcast fields are built from templates, fixed phrases and filtered text only", () => {
  const state = toPublicViewerState(broadcastSnapshot());
  assert.deepEqual(state.now, { label: "Collect iron ingot · 3/10", step: "Gathering materials", progress: { done: 3, total: 10 } });
  assert.deepEqual(state.build, { structure: "cottage", percent: 42, blocksPlaced: 42 });
  assert.deepEqual(state.brain, { thinking: true, decisionsLastHour: 37, lastLatencyMs: 812, model: "Qwen3.5 9B" });
  assert.deepEqual(state.thinking, { text: "Deciding what to gather next…", at: "2026-01-01T00:02:00.000Z" });
  assert.deepEqual(state.vitals, [{ at: "2026-01-01T00:00:00.000Z", health: 20, hunger: 17 }, { at: "2026-01-01T00:01:00.000Z", health: null, hunger: null }]);
  assert.equal(state.uptimeSeconds, 4242);
  assertNoBroadcastLeak(state);
});

test("now never copies goal or task text and drops goal items that aren't plain registry names", () => {
  const snapshot = broadcastSnapshot();
  const criterion = snapshot.goal!.successCriteria[0]!;
  for (const item of ["OwnerSecretName_gift", "ownersecretname_gift", "Dark_Knight", "diamond_1200", "mc.secret-host.example", "iron ingot at 1200 64 -950", "secret_host_loot", "village:cottage"]) {
    snapshot.goal!.successCriteria = [{ ...criterion, item }];
    const state = toPublicViewerState(snapshot);
    // The unusable criterion is skipped; the build underway stands in.
    assert.deepEqual(state.now, { label: "Build a cottage · 42%", step: "Gathering materials", progress: { done: 42, total: 100 } }, item);
    assertNoBroadcastLeak(state);
  }
  snapshot.goal!.successCriteria = [
    { kind: "inventory", stockpile: null, item: "iron_ingot", min: 3, label: "carried iron_ingot >= 3" },
    { kind: "stockpile", stockpile: "torches", item: null, min: 128, label: "torches stockpile >= 128" },
  ];
  snapshot.stockpiles = { levels: { wood: 1, food: 2, fuel: 3, torches: 66 }, targets: { wood: 1, food: 1, fuel: 1, torches: 128 }, deficits: [] };
  assert.deepEqual(toPublicViewerState(snapshot).now?.label, "Stock up torches · 66/128", "the first open criterion wins");
  snapshot.goal!.successCriteria = [{ kind: "chest_contains", stockpile: null, item: "iron_ingot", min: 32, label: "chest at 1200,64,-950 (OwnerSecretName) holds iron_ingot >= 32" }];
  assert.deepEqual(toPublicViewerState(snapshot).now, { label: "Store iron ingot", step: "Gathering materials", progress: null });
  snapshot.goal!.successCriteria = [{ kind: "area_cleared", stockpile: null, item: null, min: 1, label: "area 10x10x4 at 1200,64,-950..1210,68,-940 fully cleared" }];
  assert.equal(toPublicViewerState(snapshot).now?.label, "Clear an area");
  // An unknown task type gets no step; no goal and no build falls back to the fixed status sentence.
  snapshot.goal = null;
  snapshot.buildProject = null;
  snapshot.task = { ...snapshot.task!, type: "OwnerSecretName_custom" };
  assert.deepEqual(toPublicViewerState(snapshot).now, { label: "Busy with chores around base.", step: null, progress: null });
  assertNoBroadcastLeak(toPublicViewerState(snapshot));
  snapshot.connection.connected = false;
  assert.equal(toPublicViewerState(snapshot).now, null);
});

test("build exposes only a plain structure name, percent and blocks placed", () => {
  const snapshot = broadcastSnapshot();
  for (const structureType of ["OwnerSecretName's tower", "tower at 1200 64 -950", "mc.secret-host.example", "secret_host_hut", "x".repeat(40)]) {
    snapshot.buildProject = { ...snapshot.buildProject!, structureType };
    const state = toPublicViewerState(snapshot);
    assert.equal(state.build?.structure, "structure", structureType);
    assertNoBroadcastLeak(state);
  }
  snapshot.buildProject = { ...snapshot.buildProject!, structureType: "village:small_cottage", verifiedOperations: 140, totalOperations: 120 };
  assert.deepEqual(toPublicViewerState(snapshot).build, { structure: "small cottage", percent: 100, blocksPlaced: 120 });
  assert.deepEqual(Object.keys(toPublicViewerState(snapshot).build!).sort(), ["blocksPlaced", "percent", "structure"]);
  snapshot.buildProject = { ...snapshot.buildProject!, totalOperations: 0, verifiedOperations: 0 };
  assert.equal(toPublicViewerState(snapshot).build?.percent, 0);
  for (const status of ["paused", "blocked", "completed", "failed", "cancelled"] as const) {
    snapshot.buildProject = { ...snapshot.buildProject!, status };
    assert.equal(toPublicViewerState(snapshot).build, null, status);
  }
  snapshot.buildProject = { ...snapshot.buildProject!, status: "active" };
  snapshot.connection.connected = false;
  assert.equal(toPublicViewerState(snapshot).build, null);
});

test("brain shows the configured model label only, never the endpoint or the server's model id", () => {
  const snapshot = broadcastSnapshot();
  for (const modelLabel of ["http://10.0.0.5:8080/v1", "secret-model@10.0.0.5", "mc.secret-host.example:8080", "a/b", "x".repeat(33), "", null]) {
    snapshot.broadcast = { ...snapshot.broadcast!, modelLabel };
    const state = toPublicViewerState(snapshot);
    assert.equal(state.brain?.model, null, String(modelLabel));
    assertNoBroadcastLeak(state);
  }
  snapshot.broadcast = { ...snapshot.broadcast!, lastDecision: null, decisionsLastHour: Number.NaN };
  snapshot.llmActivity = { ...snapshot.llmActivity, thinking: false };
  assert.deepEqual(toPublicViewerState(snapshot).brain, { thinking: false, decisionsLastHour: 0, lastLatencyMs: null, model: null });
});

test("thinking passes a clean rationale whole and replaces any doubtful one with a fixed phrase", () => {
  const snapshot = broadcastSnapshot();
  const decision = snapshot.broadcast!.lastDecision!;
  const think = (rationale: string | null, callType = decision.callType, tool = decision.tool): string | undefined => {
    snapshot.broadcast = { ...snapshot.broadcast!, lastDecision: { ...decision, rationale, callType, tool } };
    return toPublicViewerState(snapshot).thinking?.text;
  };
  assert.equal(think("Smelt the carried iron into ingots using home furnace fuel."), "Smelt the carried iron into ingots using home furnace fuel.");
  for (const rationale of [HOSTILE_RATIONALE, "Help ownersecretname", "Visit the secret-host", "Go to the chest north of home", "Return to base at 1200 64 -950", "Ask CobbleBob", "Meet xXOwnerXx", null]) {
    assert.equal(think(rationale), "Deciding what to gather next…", String(rationale));
  }
  assert.equal(think("Smelt the carried iron.", "owner_instruction", "come_to_player"), "Working out what the owner asked for…", "owner requests paraphrase private chat");
  assert.equal(think(HOSTILE_RATIONALE, "goal_decision", "build_design"), "Planning the next part of the build…");
  // Decisions on an owner's goal paraphrase the owner's request.
  snapshot.goal = { ...snapshot.goal!, source: "owner" as never };
  assert.equal(think("Gathering logs for the tower by the lake.", "goal_decision"), "Working out what the owner asked for…");
  snapshot.goal = { ...snapshot.goal!, source: "background" as never };
  assertNoBroadcastLeak(toPublicViewerState(snapshot));
  snapshot.broadcast = { ...snapshot.broadcast!, lastDecision: { ...decision, at: "not a date" } };
  assert.equal(toPublicViewerState(snapshot).thinking, null);
  delete snapshot.broadcast;
  assert.equal(toPublicViewerState(snapshot).thinking, null);
  assert.deepEqual(toPublicViewerState(snapshot).vitals, []);
});

test("vitals keep at most an hour of whole-number samples and nothing else", () => {
  const snapshot = broadcastSnapshot();
  const vitals = Array.from({ length: 75 }, (_, minute) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), health: 1200.4, hunger: -950, position: { x: 1200, y: 64, z: -950 }, player: "OwnerSecretName",
  }));
  snapshot.broadcast = { ...snapshot.broadcast!, vitals: [...vitals, { at: "OwnerSecretName", health: 1, hunger: 1 }] as never };
  const state = toPublicViewerState(snapshot);
  assert.equal(state.vitals?.length, 59, "the 60 most recent samples, minus the one with a bad time");
  assert.deepEqual(state.vitals?.[0], { at: "2026-01-01T00:16:00.000Z", health: 1200, hunger: 0 });
  assert.equal(JSON.stringify(state.vitals).includes("OwnerSecretName"), false);
  assert.equal(JSON.stringify(state.vitals).includes("position"), false);
});

test("the model label is a short fixed display string in config, never a URL", () => {
  const base = parse(readFileSync("config/minecraft.yaml", "utf8"));
  assert.equal(MinecraftConfigSchema.parse(base).dashboard?.public_viewer.model_label, "Qwen3.5 9B");
  for (const model_label of ["http://127.0.0.1:8080", "model@host", "a/b", "x".repeat(33), " leading space", ""]) {
    base.dashboard.public_viewer.model_label = model_label;
    assert.equal(MinecraftConfigSchema.safeParse(base).success, false, model_label);
  }
  delete base.dashboard.public_viewer.model_label;
  assert.equal(MinecraftConfigSchema.parse(base).dashboard?.public_viewer.model_label, undefined);
});

test("uptime is whole, non-negative seconds", () => {
  const snapshot = broadcastSnapshot();
  snapshot.process.uptimeSeconds = -5;
  assert.equal(toPublicViewerState(snapshot).uptimeSeconds, 0);
  snapshot.process.uptimeSeconds = Number.NaN;
  assert.equal(toPublicViewerState(snapshot).uptimeSeconds, 0);
});

test("the world clock is a whole tick count in one day, to the nearest 100, and nothing else", () => {
  const clock = (timeOfDay: unknown, connected = true): unknown => {
    const snapshot = broadcastSnapshot();
    snapshot.connection.connected = connected;
    snapshot.self = { ...snapshot.self, timeOfDay: timeOfDay as number };
    return toPublicViewerState(snapshot).self.timeOfDay;
  };
  assert.deepEqual([0, 49, 50, 6012, 12_999, 13_000, 23_949, 23_950, 23_999].map((ticks) => clock(ticks)), [0, 0, 100, 6000, 13_000, 13_000, 23_900, 0, 0]);
  // Raw world time, negative (frozen cycle) or junk still lands on a bounded multiple of 100.
  for (const ticks of [1_234_567_891, -950, 1200.64, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    const value = clock(ticks);
    assert(typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 24_000 && value % 100 === 0, `${ticks} -> ${value}`);
  }
  for (const junk of [Number.NaN, Infinity, "1200 64 -950", { x: 1200 }, null, undefined]) assert.equal(clock(junk), null, String(junk));
  assert.equal(clock(6000, false), null, "no clock while disconnected");
  const snapshot = broadcastSnapshot();
  snapshot.self = { ...snapshot.self, timeOfDay: 6012 };
  assertNoBroadcastLeak(toPublicViewerState(snapshot));
});

test("build story lines are re-rendered from a checked structure name, never the owner's request", () => {
  const snapshot = broadcastSnapshot();
  const line = (text: string, structure?: string) => ({ id: 1, at: "2026-01-01T00:00:00.000Z", icon: "build" as const, text, highlight: true, ...(structure === undefined ? {} : { facts: { kind: "build_finished" as const, structure } }) });
  snapshot.story = [
    line("Finished building a barnaby castle!", "barnaby castle"),
    line("Finished building a cottage for OwnerSecretName at 1200 64 -950!"),
    line("Finished building a cottage!", "cottage"),
    { ...line("Started building a OwnerSecretName tower"), id: 2 },
    { ...line("Worked on the base"), id: 3 },
  ];
  snapshot.broadcast = { ...snapshot.broadcast!, privateTerms: ["Barnabyisbig", "OwnerSecretName"] };
  assert.deepEqual(toPublicViewerState(snapshot).story.map((entry) => entry.text), [
    "Finished building a structure!", "Finished building a structure!", "Finished building a cottage!", "Started building a structure", "Worked on the base",
  ]);
});

test("a stockpile named like an Object prototype key gives no label", () => {
  const snapshot = broadcastSnapshot();
  snapshot.goal = { ...snapshot.goal!, successCriteria: [{ kind: "stockpile", stockpile: "constructor" as never, item: null, min: 5, label: "x" }] };
  assert.equal(typeof toPublicViewerState(snapshot).now?.label, "string");
});
