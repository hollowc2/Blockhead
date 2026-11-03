/**
 * Pure helpers for the broadcast page (/broadcast). No DOM and no clock of
 * their own, so src/dashboard/broadcast-panels.test.ts can drive them.
 * Everything here reads only fields of the public viewer state.
 */

/** mineflayer's isDay is timeOfDay < 13000 of a 24000-tick day at 20 ticks/s. */
export const DAY_SECONDS = 650;
export const NIGHT_SECONDS = 550;
const CYCLE_SECONDS = DAY_SECONDS + NIGHT_SECONDS;
/** An anchor older than its phase plus this is a frozen clock, a skipped night or a missed flip. */
const ANCHOR_GRACE_SECONDS = 60;

const bare = (name) => String(name ?? "").replace(/^minecraft:/, "");

export function itemLabel(name) {
  return bare(name).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function compact(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

export function ago(iso, now) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** Names whose count went up since the previous poll. No baseline (first poll, reconnect) means nothing is new. */
export function gainedItems(previous, items) {
  const gained = new Set();
  if (!previous) return gained;
  for (const item of items) if (item.count > (previous.get(item.name) ?? 0)) gained.add(item.name);
  return gained;
}

export const TIERS = Object.freeze([
  { id: "wood", label: "Wood", texture: "items/wooden_pickaxe.png" },
  { id: "stone", label: "Stone", texture: "items/stone_pickaxe.png" },
  { id: "iron", label: "Iron", texture: "items/iron_pickaxe.png" },
  { id: "diamond", label: "Diamond", texture: "items/diamond.png" },
  { id: "nether", label: "Nether", texture: "blocks/netherrack.png" },
]);
const TIER_ITEMS = {
  wood: /^(?:wooden_[a-z_]+|crafting_table|stick|[a-z_]+_(?:log|planks))$/,
  stone: /^(?:stone_(?:pickaxe|axe|shovel|sword|hoe)|cobblestone|cobbled_deepslate|furnace)$/,
  iron: /^(?:iron_[a-z_]+|raw_iron|bucket|water_bucket|lava_bucket|shears)$/,
  diamond: /^diamond(?:_[a-z_]+)?$/,
  nether: /^(?:netherrack|quartz|nether_[a-z_]+|blaze_(?:rod|powder)|soul_(?:sand|soil)|crimson_[a-z_]+|warped_[a-z_]+|magma_cream|ghast_tear|glowstone_dust|netherite_[a-z_]+|ancient_debris|blackstone|gilded_blackstone)$/,
};
/** Lifetime evidence from world-stats milestones; carried items alone can be lost on death. */
const TIER_MILESTONES = { wood: ["logs-100"], stone: ["stone-1000"], iron: ["iron-pickaxe"], diamond: ["diamond"], nether: [] };

/**
 * Wood → stone → iron → diamond → nether. A tier is reached from a lifetime
 * milestone, a carried or worn item of that tier, or (nether) being there.
 * A tool tier implies the ones below it; the Nether takes at least iron
 * (a bucket for the portal), so it implies wood, stone and iron.
 */
export function progression(state) {
  const unlocked = new Set((state?.world?.milestones ?? []).filter((m) => m?.unlocked).map((m) => m.id));
  const items = [...(state?.inventory?.items ?? []), ...Object.values(state?.equipment ?? {})].filter(Boolean).map((item) => bare(item.name));
  const own = TIERS.map(({ id }) => TIER_MILESTONES[id].some((m) => unlocked.has(m)) || items.some((name) => TIER_ITEMS[id].test(name)));
  if (bare(state?.self?.dimension) === "the_nether") own[4] = true;
  const reached = own.map((value, index) => value || (index < 4 && own.slice(index + 1, 4).some(Boolean)) || (index < 3 && own[4]));
  const current = reached.lastIndexOf(true);
  return { tiers: TIERS.map((tier, index) => ({ ...tier, reached: reached[index] })), current: current < 0 ? null : TIERS[current].id };
}

const MATERIALS = [["leather_", "leather"], ["chainmail_", "chainmail"], ["iron_", "iron"], ["golden_", "gold"], ["diamond_", "diamond"], ["netherite_", "netherite"], ["turtle_", "turtle"]];
/** The armor material for tinting the paper doll, or null. */
export function armorMaterial(name) {
  const key = bare(name);
  return key ? MATERIALS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? "other" : null;
}

/**
 * Where the world clock is. The public state only has the phase, so the
 * position comes from the latest sunrise/sunset: a story entry or a flip
 * this page saw itself. Without a believable anchor the dial sits mid-phase
 * and gives no countdown.
 * @returns {{ phase: "day"|"night"|null, angle: number, remaining: number|null, label: string }}
 */
export function dayDial({ phase, story = [], observedFlipAt = null, now }) {
  if (phase !== "day" && phase !== "night") return { phase: null, angle: 0, remaining: null, label: "" };
  const length = phase === "day" ? DAY_SECONDS : NIGHT_SECONDS;
  let anchor = observedFlipAt;
  for (const entry of story) {
    const at = Date.parse(entry?.at);
    if (entry?.icon === phase && Number.isFinite(at) && (anchor === null || at > anchor)) anchor = at;
  }
  const elapsed = anchor === null ? NaN : (now - anchor) / 1000;
  const anchored = elapsed >= 0 && elapsed <= length + ANCHOR_GRACE_SECONDS;
  const into = anchored ? Math.min(length, elapsed) : length / 2;
  const cycle = (phase === "day" ? 0 : DAY_SECONDS) + into;
  // 0° is noon at the top; sunrise sits left of it, sunset right.
  const angle = (cycle / CYCLE_SECONDS) * 360 - (DAY_SECONDS / CYCLE_SECONDS) * 180;
  const remaining = anchored ? Math.max(0, Math.round(length - elapsed)) : null;
  const next = phase === "day" ? "Night" : "Dawn";
  const label = remaining === null ? (phase === "day" ? "Daytime" : "Nighttime")
    : remaining < 60 ? `${next} soon` : `${next} in ~${Math.ceil(remaining / 60)} min`;
  return { phase, angle: Math.round(angle * 10) / 10, remaining, label };
}

/** Minecraft-style row of 10 icons, each worth 2 points: "full" | "half" | "empty". */
export function iconRow(value) {
  const points = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(20, Math.round(value))) : 0;
  return Array.from({ length: 10 }, (_, i) => points - i * 2 >= 2 ? "full" : points - i * 2 === 1 ? "half" : "empty");
}
