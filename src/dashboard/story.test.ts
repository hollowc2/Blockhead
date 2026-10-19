import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../events/bus.js";
import { humanize, StoryFeed, stripCoordinates } from "./story.js";

function feed(start = 1_000_000) {
  let clock = start;
  const bus = new EventBus();
  const story = new StoryFeed({ bus, now: () => clock });
  // Payloads are partial on purpose: the feed only reads a few fields.
  const emit = (name: string, payload: unknown): void => { (bus.emit as (n: string, p: unknown) => void)(name, payload); };
  return { story, emit, advance(ms: number) { clock += ms; } };
}

test("big moments are highlighted and phrased for viewers", () => {
  const { story, emit } = feed();
  emit("build_project.verified", { project: { structureType: "village:cottage", userGoal: "x" } });
  emit("death", { killer: { name: "creeper", x: 1200, y: 64, z: -950 }, position: { x: 1200, y: 64, z: -950 }, dimension: "overworld", inventory: {} });
  emit("time.night", { time: "night" });
  const entries = story.recent();
  assert.deepEqual(entries.map((e) => [e.icon, e.text, e.highlight]), [
    ["build", "Finished building a cottage!", true],
    ["death", "Was killed by a creeper", true],
    ["night", "Night falls", false],
  ]);
  assert.deepEqual(entries.map((e) => e.id), [1, 2, 3]);
  assert.equal(JSON.stringify(entries).includes("1200"), false, "death coordinates never reach the story");
});

test("goal text loses coordinates and owner requests stay private", () => {
  const { story, emit } = feed();
  emit("goal.started", { goal: { source: "director", description: "Build a watchtower at 120, 64, -30." } });
  emit("goal.started", { goal: { source: "owner", description: "Guard my base at 1200 64 -950" } });
  assert.deepEqual(story.recent().map((e) => e.text), ["New goal: Build a watchtower", "Took on a request from the owner"]);
});

test("routine noise is filtered: repeats, hostile spam and unremarkable tasks", () => {
  const { story, emit, advance } = feed();
  emit("hostile.detected", { type: "zombie" });
  emit("hostile.detected", { type: "zombie" });
  advance(60_000);
  emit("hostile.detected", { type: "zombie" });
  emit("task.completed", { task: { type: "ensure_item", objective: "ensure 1 stick" } });
  emit("task.completed", { task: { type: "night_shelter", objective: "shelter" } });
  emit("task.completed", { task: { type: "night_shelter", objective: "shelter" } });
  emit("resource.gather.complete", { resource: "iron_ore", quantity: 8, gathered: 8, delivered: 8, status: "completed" });
  emit("resource.gather.complete", { resource: "iron_ore", quantity: 8, gathered: 0, delivered: 0, status: "failed" });
  assert.deepEqual(story.recent().map((e) => e.text), ["Spotted a zombie", "Made it to shelter for the night", "Gathered 8 iron ore"]);
});

test("the feed is bounded and stops listening on dispose", () => {
  const bus = new EventBus();
  let clock = 0;
  const story = new StoryFeed({ bus, maxEntries: 3, now: () => (clock += 200_000) });
  const emit = bus.emit as (n: string, p: unknown) => void;
  for (let i = 0; i < 5; i++) emit.call(bus, i % 2 ? "time.day" : "time.night", {});
  assert.equal(story.recent().length, 3);
  story.dispose();
  emit.call(bus, "time.day", {});
  assert.equal(story.recent().at(-1)!.id, 5);
});

test("helpers humanize ids and strip coordinate runs", () => {
  assert.equal(humanize("minecraft:iron_ore"), "iron ore");
  assert.equal(humanize("village:storage_shed"), "storage shed");
  assert.equal(humanize(undefined, "tool"), "tool");
  assert.equal(stripCoordinates("Return to base (100, 64, -20) now"), "Return to base now");
  assert.equal(stripCoordinates("Mine 64 cobblestone"), "Mine 64 cobblestone");
});
