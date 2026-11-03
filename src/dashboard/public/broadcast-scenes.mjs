/**
 * The broadcast's scene machine (/broadcast): which layout the frame shows,
 * which event banner is up, and when the "What is this?" lower-third runs.
 * Pure: it reads only public viewer state and the clock it is handed, so
 * src/dashboard/broadcast-scenes.test.ts can drive it poll by poll.
 *
 *   let scenes = createScenes(now);
 *   scenes = stepScenes(scenes, state, now);   // each poll; state null: page server unreachable
 *   scenes.scene, scenes.banner, scenes.queue, scenes.lowerThird
 *
 * Nothing fires on the first poll, after a reconnect or after a bot restart:
 * those polls only take a baseline, so a page load never replays history.
 */
import { itemLabel } from "./broadcast-panels.mjs";

/** An action scene lasts this long after its latest trigger. */
export const ACTION_HOLD_MS = 30_000;
/** A scene stays up at least this long, so triggers can't make it flap. */
export const MIN_DWELL_MS = 8_000;
/** Night and resting must both hold this long before the night scene. */
export const NIGHT_ENTER_MS = 8_000;
/** Out and about (not resting or recovering) this long at night ends the night scene early. */
export const NIGHT_AWAY_MS = 60_000;
/** Building again within this long of the last build poll is the same session, not a new start. */
export const BUILD_REARM_MS = 60_000;
export const BANNER_MS = 6_000;
/** Room for the previous banner's exit transition. */
export const BANNER_GAP_MS = 800;
export const BANNER_QUEUE_MAX = 4;
/** A queued banner older than this is old news and is dropped. */
export const BANNER_STALE_MS = 60_000;
/** One build, one banner: its story line and the build field ending are the same news. */
const BUILD_BANNER_DEDUPE_MS = 120_000;
/** The build field ending this close to done counts as a finished build. */
const BUILD_DONE_PERCENT = 90;
export const LOWER_THIRD_MS = 12_000;
export const LOWER_THIRD_EVERY_MS = 300_000;
export const LOWER_THIRD_FIRST_MS = 60_000;
/** A banner cut the lower-third short; try again this much later. */
const LOWER_THIRD_RETRY_MS = 60_000;

const bare = (name) => String(name ?? "").replace(/^minecraft:/, "");
const TOOL = /^(wooden|stone|golden|iron|diamond|netherite)_(?:pickaxe|axe|shovel|hoe|sword)$/;
const ARMOR = /^(leather|chainmail|golden|iron|diamond|netherite)_(?:helmet|chestplate|leggings|boots)$/;
// Gold mines like wood and armors like chainmail, so neither counts as a step up from them.
const TOOL_RANK = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };

/** The best tool and armor tier carried or worn, as a rank and the item that holds it; null when both lists are missing. */
export function gearTiers(state) {
  const inventory = state?.inventory?.items, equipment = state?.equipment;
  if (!Array.isArray(inventory) && (equipment === null || typeof equipment !== "object")) return null;
  const names = [...(Array.isArray(inventory) ? inventory : []), ...Object.values(equipment ?? {})].filter(Boolean).map((item) => bare(item.name));
  const best = (pattern, ranks) => {
    let top = { rank: 0, item: null };
    for (const name of names) {
      const material = pattern.exec(name)?.[1];
      if (material && ranks[material] > top.rank) top = { rank: ranks[material], item: name };
    }
    return top;
  };
  return { tool: best(TOOL, TOOL_RANK), armor: best(ARMOR, ARMOR_RANK) };
}

export function createScenes(now) {
  return {
    scene: "normal", sceneSince: now,
    /** The showing banner ({ id, kind, label, text, note, item, icon, until }) and those waiting. */
    banner: null, queue: [], lowerThird: false,
    // Memory: what the last connected poll looked like (null: take a fresh baseline next).
    seen: null,
    /** Highest tool/armor rank this page has seen; survives reconnects so a death and re-craft isn't news. */
    best: { tool: null, armor: null },
    actionUntil: 0, lastBuildingAt: null, nightSince: null, awaySince: null, night: false,
    bannerFreeAt: 0, nextBannerId: 1, lastBuildBannerAt: null,
    lowerThirdUntil: 0, nextLowerThirdAt: now + LOWER_THIRD_FIRST_MS,
  };
}

// The facts each poll is compared on, read defensively: any field may be missing.
function read(state) {
  const story = Array.isArray(state.story) ? state.story.filter((entry) => entry && Number.isFinite(entry.id)) : [];
  const milestones = Array.isArray(state.world?.milestones) ? state.world.milestones.filter((m) => m?.unlocked && typeof m.id === "string") : null;
  const build = state.build && typeof state.build.structure === "string" ? { structure: state.build.structure, percent: Number(state.build.percent) || 0 } : null;
  const dimension = bare(state.self?.dimension);
  const ticks = state.self?.timeOfDay;
  // The clock decides the phase, as on the dial; the edge-triggered flag is the fallback.
  const night = typeof ticks === "number" && Number.isFinite(ticks) ? ((ticks % 24_000) + 24_000) % 24_000 >= 13_000 : state.self?.timePhase === "night";
  return {
    story, storyId: story.length ? Math.max(...story.map((entry) => entry.id)) : 0,
    milestones, build, gear: gearTiers(state),
    activity: typeof state.status?.activity === "string" ? state.status.activity : null,
    // The Nether and the End have no night to sit out.
    night: night && (dimension === "" || dimension === "overworld"),
  };
}

function enqueue(m, banner, now) {
  if (m.queue.length >= BANNER_QUEUE_MAX) return;
  m.queue.push({ ...banner, id: m.nextBannerId++, queuedAt: now });
}

/** News since the previous connected poll: action triggers and banners. */
function compare(m, before, facts, now) {
  let trigger = false;
  for (const entry of facts.story) {
    if (entry.id <= before.storyId) continue;
    const icon = typeof entry.icon === "string" ? entry.icon : "";
    const text = typeof entry.text === "string" ? entry.text : "";
    // Sightings are routine while he sits out the night or a break; the rest is always news.
    if (icon === "fight" || icon === "death" || entry.highlight === true || (icon === "hostile" && facts.activity !== "resting")) trigger = true;
    if (icon === "death") enqueue(m, { kind: "death", label: "CobbleBob died", text: text || "Died", note: null, item: null, icon: "death" }, now);
    else if (icon === "build" && entry.highlight === true && buildBannerDue(m, now)) enqueue(m, { kind: "build", label: "Build complete", text: text || "Finished a build", note: null, item: null, icon: "build" }, now);
  }
  // A build that stops near the top without its story line still finished.
  if (before.build && !facts.build && before.build.percent >= BUILD_DONE_PERCENT && buildBannerDue(m, now)) {
    enqueue(m, { kind: "build", label: "Build complete", text: `Finished the ${before.build.structure}`, note: null, item: null, icon: "build" }, now);
  }
  if (before.milestones && facts.milestones) {
    const had = new Set(before.milestones.map((milestone) => milestone.id));
    for (const milestone of facts.milestones) {
      if (had.has(milestone.id)) continue;
      enqueue(m, { kind: "milestone", label: "Milestone unlocked", text: typeof milestone.title === "string" ? milestone.title : "Milestone", note: typeof milestone.description === "string" ? milestone.description : null, item: null, icon: "milestone" }, now);
    }
  }
  if (facts.gear) for (const [slot, label] of [["tool", "New tool tier"], ["armor", "New armor tier"]]) {
    const { rank, item } = facts.gear[slot];
    if (m.best[slot] !== null && rank > m.best[slot]) enqueue(m, { kind: "tier", label, text: itemLabel(item), note: null, item, icon: "tool" }, now);
  }
  if (facts.activity === "building" && (m.lastBuildingAt === null || now - m.lastBuildingAt > BUILD_REARM_MS)) trigger = true;
  return trigger;
}

function buildBannerDue(m, now) {
  if (m.lastBuildBannerAt !== null && now - m.lastBuildBannerAt < BUILD_BANNER_DEDUPE_MS) return false;
  m.lastBuildBannerAt = now;
  return true;
}

/**
 * The machine after one poll at `now`. `state` is the /api/state answer, or
 * null when the page's server is unreachable (treated as disconnected).
 */
export function stepScenes(previous, state, now) {
  const m = { ...previous, queue: previous.queue.slice(), best: { ...previous.best } };
  const connected = state?.connection?.connected === true;

  if (!connected) {
    // Forget the baseline so the reconnect poll is quiet; old news never queues up.
    m.seen = null; m.queue = []; m.actionUntil = 0; m.night = false; m.nightSince = null; m.awaySince = null;
  } else {
    const facts = read(state);
    const fresh = m.seen === null || facts.storyId < m.seen.storyId;
    if (!fresh && compare(m, m.seen, facts, now)) m.actionUntil = now + ACTION_HOLD_MS;
    if (facts.gear) for (const slot of ["tool", "armor"]) m.best[slot] = Math.max(m.best[slot] ?? 0, facts.gear[slot].rank);
    if (facts.activity === "building") m.lastBuildingAt = now;
    m.seen = {
      storyId: facts.storyId, build: facts.build,
      // A poll without world stats keeps the last known set, so they reappearing is not news.
      milestones: facts.milestones ?? (fresh ? null : m.seen.milestones),
    };

    // Night: entered after night + resting holds, then latched until dawn,
    // unless he has clearly gone back to work.
    const resting = facts.activity === "resting";
    m.nightSince = facts.night && resting ? m.nightSince ?? now : null;
    if (!facts.night) { m.night = false; m.awaySince = null; }
    if (m.night) {
      m.awaySince = resting || facts.activity === "recovering" ? null : m.awaySince ?? now;
      if (m.awaySince !== null && now - m.awaySince >= NIGHT_AWAY_MS) { m.night = false; m.awaySince = null; }
    } else if (m.nightSince !== null && now - m.nightSince >= NIGHT_ENTER_MS) {
      m.night = true; m.awaySince = null;
    }
  }

  const wanted = connected && now < m.actionUntil ? "action" : m.night ? "night" : "normal";
  // Going offline is immediate (the veil covers the game); anything else waits out the dwell.
  if (wanted !== m.scene && (!connected || now - m.sceneSince >= MIN_DWELL_MS)) { m.scene = wanted; m.sceneSince = now; }

  // Banners: one at a time, each for BANNER_MS, with a short gap between them.
  if (m.banner && now >= m.banner.until) { m.bannerFreeAt = m.banner.until + BANNER_GAP_MS; m.banner = null; }
  m.queue = m.queue.filter((banner) => now - banner.queuedAt <= BANNER_STALE_MS);
  if (!m.banner && m.queue.length && now >= m.bannerFreeAt) {
    const { queuedAt: _queuedAt, ...next } = m.queue.shift();
    m.banner = { ...next, until: now + BANNER_MS };
    // A banner always wins; the lower-third steps aside and tries again later.
    if (m.lowerThird) { m.lowerThird = false; m.nextLowerThirdAt = now + LOWER_THIRD_RETRY_MS; }
  }

  // The lower-third, never on top of (or between) banners.
  if (m.lowerThird && now >= m.lowerThirdUntil) { m.lowerThird = false; m.nextLowerThirdAt = m.lowerThirdUntil + LOWER_THIRD_EVERY_MS; }
  if (!m.lowerThird && !m.banner && !m.queue.length && now >= m.bannerFreeAt && now >= m.nextLowerThirdAt) {
    m.lowerThird = true; m.lowerThirdUntil = now + LOWER_THIRD_MS;
  }
  return m;
}
