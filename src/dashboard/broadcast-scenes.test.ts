import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACTION_HOLD_MS, BANNER_GAP_MS, BANNER_MS, BANNER_QUEUE_MAX, BANNER_STALE_MS, BUILD_REARM_MS, createScenes, gearTiers, LOWER_THIRD_EVERY_MS, LOWER_THIRD_FIRST_MS, LOWER_THIRD_MS, MIN_DWELL_MS, NIGHT_AWAY_MS, NIGHT_ENTER_MS, stepScenes, type Scenes } from "./public/broadcast-scenes.mjs";

interface Entry { id: number; icon: string; text: string; highlight: boolean; at?: string }
interface Fixture {
  connected?: boolean; activity?: string; timeOfDay?: number | null; timePhase?: string | null; dimension?: string;
  story?: Entry[]; milestones?: Array<{ id: string; title: string; description?: string; unlocked: boolean }> | null;
  build?: { structure: string; percent: number } | null; items?: string[]; equipment?: Record<string, { name: string } | null> | null;
}
const T0 = 1_000_000;
const entry = (id: number, icon = "gather", highlight = false, text = `Entry ${icon}`): Entry => ({ id, icon, text, highlight });
const BASE_STORY = [entry(1, "day"), entry(2, "gather")];

function state(f: Fixture = {}): unknown {
  return {
    public: true, connection: { connected: f.connected ?? true },
    status: { activity: f.activity ?? "gathering", detail: "", since: null },
    self: { health: 20, hunger: 20, dimension: f.dimension ?? "minecraft:overworld", timePhase: f.timePhase ?? null, timeOfDay: f.timeOfDay === undefined ? 6000 : f.timeOfDay },
    story: f.story ?? BASE_STORY,
    world: f.milestones === null ? null : { day: 3, milestones: f.milestones ?? [{ id: "day-1", title: "First Night", unlocked: true }, { id: "iron-pickaxe", title: "Iron Age", description: "Craft an iron pickaxe", unlocked: false }] },
    build: f.build ?? null,
    inventory: { items: (f.items ?? ["dirt", "stone_pickaxe"]).map((name) => ({ name, count: 1 })), totalItems: 2 },
    equipment: f.equipment === undefined ? { hand: null, "off-hand": null, head: null, torso: null, legs: null, feet: null } : f.equipment,
  };
}

/** Drives the machine one poll a second, like the page. */
class Driver {
  now = T0;
  m: Scenes = createScenes(T0);
  /** The showing banner, read fresh (an assert on `m.banner` would otherwise narrow it for good). */
  b(): Scenes["banner"] { return this.m.banner; }
  poll(s: unknown, advanceMs = 1000): Scenes { this.now += advanceMs; this.m = stepScenes(this.m, s, this.now); return this.m; }
  /** Polls `s` every second for `ms`; returns every scene seen. */
  hold(s: unknown, ms: number): string[] { const seen: string[] = []; for (let t = 0; t < ms; t += 1000) seen.push(this.poll(s).scene); return seen; }
}

test("the first poll and a reconnect only take a baseline: no banner, no action", () => {
  const d = new Driver();
  // A page opened right after a death, a build and an unlock replays none of them.
  const busy = state({ activity: "building", story: [entry(1, "death", true), entry(2, "build", true), entry(3, "hostile")], milestones: [{ id: "diamond", title: "Diamonds!", unlocked: true }], items: ["diamond_pickaxe"] });
  assert.equal(d.poll(busy).scene, "normal");
  assert.equal(d.m.banner, null);
  assert.equal(d.m.queue.length, 0);
  assert.deepEqual(d.hold(busy, 20_000).filter((scene) => scene !== "normal"), []);
  // Offline, then back with new entries and better gear: the reconnect poll is quiet too.
  d.hold(state({ connected: false }), 5000);
  const back = state({ story: [entry(1, "death", true), entry(2, "build", true), entry(3, "hostile"), entry(4, "death", true)], milestones: [{ id: "diamond", title: "Diamonds!", unlocked: true }, { id: "day-7", title: "One Week In", unlocked: true }], items: ["netherite_pickaxe"], equipment: { head: { name: "diamond_helmet" } } });
  assert.equal(d.poll(back).scene, "normal");
  assert.equal(d.m.banner, null);
  assert.equal(d.m.queue.length, 0);
  // Unreachable (null state) behaves the same.
  d.poll(null);
  d.poll(state({ story: [...BASE_STORY, entry(9, "death", true)] }));
  assert.equal(d.m.banner, null);
});

test("a bot restart (story ids start again) is a fresh baseline, not news", () => {
  const d = new Driver();
  d.poll(state({ story: [entry(40, "gather"), entry(41, "day")] }));
  d.poll(state({ story: [entry(1, "death", true)] }));
  assert.equal(d.m.banner, null);
  assert.equal(d.m.scene, "normal");
  d.hold(state({ story: [entry(1, "death", true)] }), MIN_DWELL_MS);
  // From the new baseline, news is news again.
  d.poll(state({ story: [entry(1, "death", true), entry(2, "death", true, "Was killed by a zombie")] }));
  assert.equal(d.m.scene, "action");
  assert.equal(d.b()?.kind, "death");
  assert.equal(d.b()?.text, "Was killed by a zombie");
});

test("action starts on a fight, hostile, death or highlighted entry and holds 30 s after the last one", () => {
  for (const [icon, highlight] of [["fight", false], ["hostile", false], ["death", true], ["goal", true], ["build", true]] as const) {
    const d = new Driver();
    d.poll(state());
    d.hold(state(), MIN_DWELL_MS);
    assert.equal(d.poll(state({ story: [...BASE_STORY, entry(3, icon, highlight)] })).scene, "action", icon);
  }
  // Routine lines do not.
  for (const icon of ["gather", "tool", "explore", "day", "night", "goal", "build"]) {
    const d = new Driver();
    d.poll(state());
    assert.equal(d.poll(state({ story: [...BASE_STORY, entry(3, icon, false)] })).scene, "normal", icon);
  }
  const d = new Driver();
  d.poll(state());
  d.hold(state(), MIN_DWELL_MS);
  const one = state({ story: [...BASE_STORY, entry(3, "hostile")] });
  d.poll(one);
  const start = d.now;
  d.hold(one, 20_000);
  // A second trigger 20 s in extends the hold from then.
  const two = state({ story: [...BASE_STORY, entry(3, "hostile"), entry(4, "fight")] });
  d.poll(two);
  const extended = d.now;
  while (d.now < extended + ACTION_HOLD_MS - 1000) assert.equal(d.poll(two).scene, "action", `at ${d.now - start}`);
  assert.equal(d.poll(two, 1000).scene, "normal");
});

test("sightings while resting do not start action; a fight still does", () => {
  const d = new Driver();
  d.poll(state({ activity: "resting" }));
  d.hold(state({ activity: "resting" }), MIN_DWELL_MS);
  assert.equal(d.poll(state({ activity: "resting", story: [...BASE_STORY, entry(3, "hostile")] })).scene, "normal");
  assert.equal(d.poll(state({ activity: "resting", story: [...BASE_STORY, entry(3, "hostile"), entry(4, "fight")] })).scene, "action");
});

test("building starting triggers action; staying on the build, or a short gap between slices, does not re-trigger", () => {
  const d = new Driver();
  d.poll(state({ activity: "gathering" }));
  d.hold(state(), MIN_DWELL_MS);
  const building = state({ activity: "building", build: { structure: "cottage", percent: 10 } });
  assert.equal(d.poll(building).scene, "action");
  // Still building after the hold: back to normal, and it stays there.
  const scenes = d.hold(building, ACTION_HOLD_MS + 20_000);
  assert.equal(scenes.at(-1), "normal");
  // A brief "working" between slices is the same session.
  d.hold(state({ activity: "working", build: { structure: "cottage", percent: 40 } }), 20_000);
  assert.deepEqual(d.hold(building, 5000), ["normal", "normal", "normal", "normal", "normal"]);
  // Away from building for longer than the re-arm window, then a new start.
  d.hold(state({ activity: "gathering" }), BUILD_REARM_MS + 2000);
  assert.equal(d.poll(building).scene, "action");
  // A page that opens mid-build doesn't treat it as a start.
  const late = new Driver();
  late.poll(building);
  assert.deepEqual(late.hold(building, 10_000).filter((scene) => scene !== "normal"), []);
});

test("scenes dwell at least MIN_DWELL_MS, so a trigger right after one ends waits instead of flapping", () => {
  const d = new Driver();
  d.poll(state());
  d.hold(state(), MIN_DWELL_MS);
  let story = [...BASE_STORY, entry(3, "fight")];
  d.poll(state({ story }));
  d.hold(state({ story }), ACTION_HOLD_MS);
  assert.equal(d.m.scene, "normal");
  const leftAt = d.m.sceneSince;
  // A new fight one second later: the frame holds normal for the dwell, then goes to action.
  story = [...story, entry(4, "fight")];
  const seen = d.hold(state({ story }), MIN_DWELL_MS + 2000);
  const back = seen.indexOf("action");
  assert(back > 0, "action resumes after the dwell");
  assert(d.m.sceneSince - leftAt >= MIN_DWELL_MS);
  // Scenes never switch more often than the dwell allows, however noisy the input.
  const noisy = new Driver();
  let id = 10, last = "normal", lastChange = noisy.now, changes = 0;
  noisy.poll(state({ story: [entry(id, "gather")] }));
  for (let i = 0; i < 400; i++) {
    const kind = i % 7 === 0 ? "fight" : "gather";
    const night = i % 50 < 25;
    const s = noisy.poll(state({ story: [entry(++id, kind)], activity: i % 3 ? "resting" : "building", timeOfDay: night ? 18_000 : 6000 }));
    if (s.scene !== last) { assert(noisy.now - lastChange >= MIN_DWELL_MS, `flap at ${i}`); last = s.scene; lastChange = noisy.now; changes++; }
  }
  assert(changes > 0);
});

test("night scene: night plus resting for a while, latched until dawn", () => {
  const d = new Driver();
  d.poll(state({ timeOfDay: 6000, activity: "resting" }));
  d.hold(state({ timeOfDay: 6000, activity: "resting" }), 20_000);
  assert.equal(d.m.scene, "normal", "resting in daylight is not the night scene");
  const night = state({ timeOfDay: 14_000, activity: "resting" });
  const entering = d.hold(night, NIGHT_ENTER_MS + 1000);
  assert.equal(entering[0], "normal");
  assert.equal(entering.at(-1), "night");
  // A short trip out (eating, a quick task) keeps the night scene.
  assert.deepEqual([...new Set(d.hold(state({ timeOfDay: 15_000, activity: "gathering" }), NIGHT_AWAY_MS - 5000))], ["night"]);
  assert.deepEqual([...new Set(d.hold(state({ timeOfDay: 15_000, activity: "recovering" }), NIGHT_AWAY_MS))], ["night"]);
  d.hold(night, 5000);
  // Dawn ends it.
  assert.equal(d.poll(state({ timeOfDay: 100, activity: "resting" })).scene, "normal");
  // The edge-triggered phase is used when there is no clock.
  const flag = new Driver();
  flag.hold(state({ timeOfDay: null, timePhase: "night", activity: "resting" }), NIGHT_ENTER_MS + 2000);
  assert.equal(flag.m.scene, "night");
  // No night in the Nether.
  const nether = new Driver();
  nether.hold(state({ timeOfDay: 18_000, activity: "resting", dimension: "minecraft:the_nether" }), 20_000);
  assert.equal(nether.m.scene, "normal");
});

test("night ends early once he is clearly back at work, and action interrupts it", () => {
  const d = new Driver();
  d.hold(state({ timeOfDay: 14_000, activity: "resting" }), NIGHT_ENTER_MS + 2000);
  assert.equal(d.m.scene, "night");
  const working = d.hold(state({ timeOfDay: 15_000, activity: "gathering" }), NIGHT_AWAY_MS + 2000);
  assert.equal(working.at(-1), "normal");
  // Back in the night scene, a death takes over, and night returns after the hold.
  d.hold(state({ timeOfDay: 16_000, activity: "resting" }), NIGHT_ENTER_MS + MIN_DWELL_MS);
  assert.equal(d.m.scene, "night");
  const story = [...BASE_STORY, entry(3, "death", true)];
  assert.equal(d.poll(state({ timeOfDay: 16_000, activity: "resting", story })).scene, "action");
  const after = d.hold(state({ timeOfDay: 16_000, activity: "resting", story }), ACTION_HOLD_MS + 2000);
  assert.equal(after.at(-1), "night");
  // Going offline drops straight to normal and forgets the night.
  assert.equal(d.poll(state({ connected: false })).scene, "normal");
  assert.equal(d.poll(state({ timeOfDay: 16_000, activity: "resting", story })).scene, "normal");
});

test("banners: deaths, completed builds, milestone unlocks and new tool or armor tiers", () => {
  const d = new Driver();
  const milestones = [{ id: "day-1", title: "First Night", unlocked: true }, { id: "iron-pickaxe", title: "Iron Age", description: "Craft an iron pickaxe", unlocked: false }];
  d.poll(state({ milestones, items: ["dirt", "stone_pickaxe"], equipment: { head: { name: "leather_helmet" } } }));
  d.poll(state({
    story: [...BASE_STORY, entry(3, "death", true, "Was killed by a skeleton"), entry(4, "build", true, "Finished building a cottage!"), entry(5, "build", false, "Started building a tower")],
    milestones: milestones.map((m) => ({ ...m, unlocked: true })),
    items: ["dirt", "iron_pickaxe"], equipment: { head: { name: "iron_helmet" } },
  }));
  const all = [d.m.banner, ...d.m.queue];
  assert.deepEqual(all.map((b) => b && [b.kind, b.label, b.text]), [
    ["death", "CobbleBob died", "Was killed by a skeleton"],
    ["build", "Build complete", "Finished building a cottage!"],
    ["milestone", "Milestone unlocked", "Iron Age"],
    ["tier", "New tool tier", "Iron Pickaxe"],
  ]);
  assert.equal(all[2]?.note, "Craft an iron pickaxe");
  assert.equal(all[3]?.item, "iron_pickaxe");
  // The queue is capped; the armor tier did not fit behind the other four.
  assert.equal(all.length, BANNER_QUEUE_MAX);
  // Ids are unique and increasing, so the page can restart its animation per banner.
  const ids = all.map((b) => b!.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});

test("gear tiers only go up: losing gear on a death and re-crafting it is not news", () => {
  assert.deepEqual(gearTiers({ inventory: { items: [{ name: "minecraft:diamond_sword" }, { name: "golden_pickaxe" }] }, equipment: { torso: { name: "chainmail_chestplate" } } }),
    { tool: { rank: 4, item: "diamond_sword" }, armor: { rank: 2, item: "chainmail_chestplate" } });
  assert.equal(gearTiers({ inventory: null, equipment: null }), null);
  // Look-alikes are not gear: an iron ingot, a golden apple, a turtle helmet, diamond horse armor.
  assert.deepEqual(gearTiers({ inventory: { items: [{ name: "iron_ingot" }, { name: "golden_apple" }, { name: "turtle_helmet" }, { name: "diamond_horse_armor" }] } }),
    { tool: { rank: 0, item: null }, armor: { rank: 0, item: null } });

  const d = new Driver();
  d.poll(state({ items: ["iron_pickaxe"] }));
  d.poll(state({ items: [] }));
  d.poll(state({ items: ["stone_pickaxe"] }));
  d.poll(state({ items: ["iron_pickaxe"] }));
  assert.equal(d.m.banner, null);
  // Gold is no step up from wood; stone is.
  const w = new Driver();
  w.poll(state({ items: ["wooden_pickaxe"] }));
  w.poll(state({ items: ["wooden_pickaxe", "golden_axe"] }));
  assert.equal(w.m.banner, null);
  w.poll(state({ items: ["stone_axe"] }));
  assert.equal(w.b()?.text, "Stone Axe");
  // Armor counts from what's worn or carried.
  const a = new Driver();
  a.poll(state({ equipment: { feet: { name: "diamond_boots" } }, items: [] }));
  a.poll(state({ equipment: { feet: { name: "diamond_boots" } }, items: ["leather_chestplate"] }));
  assert.equal(a.m.banner, null);
  a.poll(state({ equipment: { feet: { name: "netherite_boots" } }, items: [] }));
  assert.deepEqual([a.b()?.label, a.b()?.text, a.b()?.item], ["New armor tier", "Netherite Boots", "netherite_boots"]);
});

test("a build ending near done is a completed build, deduplicated against its story line", () => {
  const d = new Driver();
  d.poll(state({ activity: "building", build: { structure: "cottage", percent: 96 } }));
  d.poll(state({ activity: "resting", build: null }));
  assert.deepEqual([d.b()?.kind, d.b()?.text], ["build", "Finished the cottage"]);
  // The story line for the same build lands a poll later: no second banner.
  d.poll(state({ activity: "resting", story: [...BASE_STORY, entry(3, "build", true, "Finished building a cottage!")] }));
  assert.equal(d.m.queue.length, 0);
  // An abandoned build (far from done) is not a completion.
  const quit = new Driver();
  quit.poll(state({ activity: "building", build: { structure: "tower", percent: 30 } }));
  quit.poll(state({ build: null }));
  assert.equal(quit.m.banner, null);
  // Disconnecting mid-build is not a completion either.
  const lost = new Driver();
  lost.poll(state({ activity: "building", build: { structure: "tower", percent: 99 } }));
  lost.poll(state({ connected: false, build: null }));
  lost.poll(state({ build: null }));
  assert.equal(lost.m.banner, null);
});

test("milestones appearing after a poll without world stats are not news", () => {
  const d = new Driver();
  d.poll(state({ milestones: null }));
  d.poll(state({ milestones: [{ id: "day-1", title: "First Night", unlocked: true }] }));
  assert.equal(d.m.banner, null);
  d.poll(state({ milestones: null }));
  d.poll(state({ milestones: [{ id: "day-1", title: "First Night", unlocked: true }] }));
  assert.equal(d.m.banner, null, "a gap in world stats keeps the known set");
  d.poll(state({ milestones: [{ id: "day-1", title: "First Night", unlocked: true }, { id: "day-7", title: "One Week In", unlocked: true }] }));
  assert.equal(d.b()?.text, "One Week In");
});

test("banners show one at a time for 6 s each, with a gap, and stale ones are dropped", () => {
  const d = new Driver();
  d.poll(state());
  const story = [...BASE_STORY, entry(3, "death", true, "A"), entry(4, "death", true, "B")];
  d.poll(state({ story }));
  const first = d.m.banner!;
  assert.equal(first.text, "A");
  assert.equal(first.until, d.now + BANNER_MS);
  const shown: Array<[number, string | null]> = [];
  for (let i = 0; i < 16; i++) { d.poll(state({ story })); shown.push([d.now - first.until + BANNER_MS, d.b()?.text ?? null]); }
  // A for its 6 s, nothing during the gap, then B for its 6 s.
  const texts = shown.map(([, text]) => text);
  assert.equal(texts.filter((text) => text === "A").length, BANNER_MS / 1000 - 1);
  const firstB = shown.find(([, text]) => text === "B");
  assert(firstB && firstB[0] >= BANNER_MS + BANNER_GAP_MS, "B waits for A's exit");
  assert(texts.indexOf(null) < texts.indexOf("B"));
  assert.equal(texts.filter((text) => text === "B").length, BANNER_MS / 1000);
  // Banners that waited longer than BANNER_STALE_MS (a long queue on a stalled page) are dropped.
  const slow = new Driver();
  slow.poll(state());
  slow.poll(state({ story: [...BASE_STORY, entry(3, "death", true, "A"), entry(4, "death", true, "B")] }));
  slow.poll(state({ story: [...BASE_STORY, entry(3, "death", true, "A"), entry(4, "death", true, "B")] }), BANNER_STALE_MS + 1000);
  assert.equal(slow.m.banner, null);
  assert.equal(slow.m.queue.length, 0);
});

test("the lower-third runs every ~5 min for 12 s, never with a banner", () => {
  const d = new Driver();
  d.poll(state());
  // Off until its first slot, then on for LOWER_THIRD_MS.
  let onAt: number | null = null, offAt: number | null = null;
  while (d.now < T0 + LOWER_THIRD_FIRST_MS + LOWER_THIRD_MS + 5000) {
    const was = d.m.lowerThird;
    d.poll(state());
    if (!was && d.m.lowerThird) onAt = d.now;
    if (was && !d.m.lowerThird) offAt = d.now;
  }
  assert.equal(onAt, T0 + LOWER_THIRD_FIRST_MS);
  assert.equal(offAt! - onAt!, LOWER_THIRD_MS);
  // The next one, an interval after the last ended.
  while (!d.m.lowerThird) d.poll(state());
  assert.equal(d.now, offAt! + LOWER_THIRD_EVERY_MS);

  // A banner arriving mid-lower-third takes over; it never shares the screen.
  let story = [...BASE_STORY];
  const b = new Driver();
  b.poll(state({ story }));
  while (!b.m.lowerThird) b.poll(state({ story }));
  story = [...story, entry(3, "death", true)];
  b.poll(state({ story }));
  assert.equal(b.b()?.kind, "death");
  assert.equal(b.m.lowerThird, false);
  // And while banners are queued or showing, the lower-third waits.
  for (let i = 0; i < 200; i++) {
    if (i % 9 === 0) story = [...story, entry(story.length + 10, "death", true)];
    const m = b.poll(state({ story }));
    assert(!(m.lowerThird && (m.banner || m.queue.length)), `overlap at ${i}`);
  }
});

test("the lower-third's fixed sentence is in the page", async () => {
  const html = await readFile(new URL("./public/broadcast.html", import.meta.url), "utf8");
  assert.match(html, /CobbleBob is an autonomous AI playing Minecraft 24\/7 on a home server\./);
});
