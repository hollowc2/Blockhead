import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillSuccess } from "../memory/skills.js";
import type { LlmMessage } from "./client.js";
import type { StateSnapshot } from "./context.js";
import { buildMessages, fewShotsFromSkills } from "./prompt.js";

function success(name: string, parameters: Record<string, unknown>): SkillSuccess {
  return {
    id: `id-${name}`,
    skillName: name,
    parameters,
    startingConditions: { inventorySummary: {}, homeDistance: 10 },
    outcome: { durationMs: 500, interruptions: 0, finalInventoryDelta: {} },
    description: "recorded run",
    createdAt: "2026-09-14T00:00:00.000Z",
  };
}

const SNAPSHOT: StateSnapshot = {
  self: { position: { x: 0, y: 64, z: 0 }, dimension: "overworld", health: 20, hunger: 50 },
  task: { active: null, progress: null, lastError: null },
  nearby: { players: [] },
  recentEvents: [],
  from: "Corey",
  instruction: "get me 32 oak logs",
};

test("fewShotsFromSkills converts user-facing skill runs into valid tool-call examples", () => {
  const shots = fewShotsFromSkills([
    success("collect_resource", { resource: "oak_log", quantity: 32 }),
    success("ensure_item_craft", { item: "iron_pickaxe", quantity: 1 }),
    success("gather_food", { quantity: 12 }),
    success("defend_player", { player: "Corey" }),
  ]);
  assert.equal(shots.length, 4);
  assert.equal(shots[0]!.user, "Corey: get me 32 oak_log");
  assert.equal(
    shots[0]!.assistant,
    '{"decision":{"type":"tool","tool":"collect_resource","arguments":{"resource":"oak_log","quantity":32}},"rationale":"Worked before; same approach."}',
  );
  assert.equal(shots[1]!.user, "Corey: get me 1 iron_pickaxe");
  assert.match(shots[1]!.assistant, /"tool":"ensure_item"/);
  assert.match(shots[1]!.assistant, /"arguments":\{"item":"iron_pickaxe","quantity":1\}/);
  assert.equal(shots[3]!.user, "Corey: defend Corey");
});

test("fewShotsFromSkills skips runs without a user-facing tool", () => {
  const shots = fewShotsFromSkills([
    success("death_recovery", { deathId: 7 }),
    success("bootstrap.wood", {}),
    success("ensure_torches", { quantity: 16 }),
  ]);
  assert.deepEqual(shots, [], "no tool exists that can re-invoke these runs");
});

test("fewShotsFromSkills dedupes identical skill+parameters runs, keeping the first occurrence", () => {
  const first = success("collect_resource", { resource: "oak_log", quantity: 32 });
  const sameRunAgain = { ...first, id: "dup", createdAt: "2026-09-14T01:00:00.000Z" };
  const shots = fewShotsFromSkills([
    sameRunAgain,
    success("gather_food", { quantity: 8 }),
    first,
  ]);
  assert.equal(shots.length, 2, "the repeated collect run appears once");
  assert.match(shots[0]!.assistant, /"tool":"collect_resource"/, "first occurrence kept");
  assert.match(shots[1]!.assistant, /"tool":"gather_food"/);
});

test("buildMessages puts dynamic few-shots first, caps the total at 4, and keeps the contract", () => {
  const dynamic = [
    { user: "Corey: get me 7 iron_ingot", assistant: '{"decision":{"type":"tool","tool":"ensure_item","arguments":{},"rationale":"a"}}' },
    { user: "Corey: get me 3 wood", assistant: '{"decision":{"type":"tool","tool":"collect_resource","arguments":{},"rationale":"b"}}' },
  ];
  const messages: LlmMessage[] = buildMessages(SNAPSHOT, "[]", dynamic);
  // system + 2 pairs of dynamic + 2 pairs of static (cap 4) + final instruction
  assert.equal(messages.length, 1 + 8 + 1);
  assert.equal(messages[1]!.role, "user");
  assert.equal(messages[1]!.content, dynamic[0]!.user, "dynamic run leads the examples");
  assert.equal(messages[3]!.content, dynamic[1]!.user);
  const finalUser = messages.at(-1)!.content;
  assert.match(finalUser, /Available tools:/);
  assert.match(finalUser, /Owner instruction: "get me 32 oak logs"/);
});

test("buildMessages without dynamic few-shots falls back to the static examples", () => {
  const messages = buildMessages(SNAPSHOT, "[]");
  assert.equal(messages.length, 1 + 2 * 4 + 1, "all four static examples used");
  assert.match(messages[1]!.content, /come here/, "first static example leads");
});