/**
 * Deterministic item value policy (spec section 24, Phase 10).
 *
 * Configuration-driven, not hardcoded per-item decisions: `overrides` (from
 * the `items:` config section, spec 24.5) win over the built-in keyword
 * rules, which implement the suggested category contents of 24.1-24.4.
 *
 * The recovery skill (and any later sorting/discard logic) uses
 * `classify` + `rank` so pickup order is critical -> valuable -> useful ->
 * common -> expendable without the LLM ever touching item mechanics.
 */

export type ItemValue = "critical" | "valuable" | "useful" | "common" | "expendable";

/** Pickup/sorting priority, most valuable first (spec 26.1). */
export const ITEM_VALUE_ORDER: readonly ItemValue[] = [
  "critical",
  "valuable",
  "useful",
  "common",
  "expendable",
];

/** Item-name -> category overrides, from the `items:` config section. */
export type ItemPolicyOverrides = Record<string, ItemValue>;

/** Item traits a classifier may consult beyond the name (prismarine-item shape). */
export interface ItemSignals {
  enchants?: readonly { name?: string }[] | null;
  customName?: string | null;
}

/** Names carrying a tool/armor/weapon suffix ("diamond_pickaxe", "iron_helmet", ...). */
const EQUIPMENT_SUFFIX = /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots|bow|crossbow|trident|shield|fishing_rod|mace)$/;

/** Weapons with no material prefix ("bow", "trident", ...) are equipment too. */
const BARE_EQUIPMENT_NAMES: ReadonlySet<string> = new Set([
  "bow",
  "crossbow",
  "trident",
  "shield",
  "fishing_rod",
  "mace",
]);

/** Material prefixes that make equipment worth preserving (spec 24.2). */
const VALUABLE_MATERIALS = ["iron_", "gold_", "golden_", "chainmail_", "leather_"];

/** Obsolete low-tier tool materials (spec 24.4: "obsolete low-tier tools"). */
const LOW_TIER_MATERIALS = ["wooden_", "stone_"];

/** Spec 24.1: critical / never auto-discard. */
const CRITICAL_NAMES: ReadonlySet<string> = new Set([
  "diamond",
  "netherite_scrap",
  "netherite_ingot",
  "ancient_debris",
  "elytra",
  "totem_of_undying",
  "enchanted_golden_apple",
  "shulker_box",
  "dragon_egg",
  "nether_star",
  "beacon",
  "heart_of_the_sea",
]);

/** Enchants that make an enchanted book rare (spec 24.1 "rare enchanted books"). */
const RARE_ENCHANT_NAMES: ReadonlySet<string> = new Set(["mending", "silk_touch", "fortune"]);

/** Spec 24.2: valuable / preserve. */
const VALUABLE_NAMES: ReadonlySet<string> = new Set([
  "emerald",
  "gold_ingot",
  "iron_ingot",
  "lapis_lazuli",
  "redstone",
  "ender_pearl",
  "blaze_rod",
  "ghast_tear",
  "echo_shard",
  "nautilus_shell",
  "saddle",
  "name_tag",
  "obsidian",
]);

/** Spec 24.3: useful bulk, plus common food and crafting staples. */
const USEFUL_NAMES: ReadonlySet<string> = new Set([
  "coal",
  "charcoal",
  "cobblestone",
  "stone",
  "sand",
  "raw_iron",
  "raw_copper",
  "raw_gold",
  "iron_nugget",
  "gold_nugget",
  "leather",
  "string",
  "bone",
  "gunpowder",
  "arrow",
  "torch",
  "flint",
  "bread",
  "apple",
  "golden_carrot",
  "egg",
  "feather",
  "wheat",
  "carrot",
  "potato",
  "beetroot",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_chicken",
  "cooked_mutton",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "porkchop",
  "chicken",
  "mutton",
  "rabbit",
  "cod",
  "salmon",
  "melon_slice",
  "honey_bottle",
  "cookie",
  "paper",
  "book",
  "bucket",
  "glass_bottle",
]);

/** Spec 24.4: expendable / auto-discard candidates. */
const EXPENDABLE_NAMES: ReadonlySet<string> = new Set([
  "dirt",
  "gravel",
  "netherrack",
  "rotten_flesh",
]);

/** Common flowers (spec 24.4 "common flowers"). */
const COMMON_FLOWERS: ReadonlySet<string> = new Set([
  "poppy",
  "dandelion",
  "blue_orchid",
  "allium",
  "azure_bluet",
  "red_tulip",
  "orange_tulip",
  "white_tulip",
  "pink_tulip",
  "oxeye_daisy",
  "cornflower",
  "lily_of_the_valley",
  "wither_rose",
]);

/** Strip a leading "minecraft:" namespace; the policy is namespace-agnostic. */
function bareName(name: string): string {
  return name.replace(/^minecraft:/, "");
}

/** Is `name` a tool, armor, or weapon item ("…_sword", "…_chestplate", "bow")? */
export function isEquipmentName(name: string): boolean {
  const bare = bareName(name);
  return BARE_EQUIPMENT_NAMES.has(bare) || EQUIPMENT_SUFFIX.test(bare);
}

/**
 * Deterministic classification. `overrides` (config `items:`) are consulted
 * first, then name rules, then item traits (named/custom items are critical,
 * enchanted equipment is valuable). Unknown items default to `common`.
 */
export class ItemPolicy {
  constructor(private readonly overrides: ItemPolicyOverrides = {}) {}

  classify(name: string, signals?: ItemSignals): ItemValue {
    const bare = bareName(name);
    const override = this.overrides[bare];
    if (override !== undefined) return override;

    if (CRITICAL_NAMES.has(bare)) return "critical";
    // Spec 24.1: named/custom items are critical (player-made, never discard).
    if (signals?.customName !== null && signals?.customName !== undefined && signals.customName !== "") {
      return "critical";
    }
    if (
      bare === "enchanted_book" &&
      (signals?.enchants ?? []).some((enchant) => {
        const enchantName = enchant?.name;
        return enchantName !== undefined && RARE_ENCHANT_NAMES.has(enchantName);
      })
    ) {
      return "critical";
    }
    // Spec 24.2: diamond/netherite equipment is critical; iron and below is
    // "equipment worth preserving" (valuable). Prefix rules apply to actual
    // equipment only, so "netherite_smithing_template" stays valuable below.
    if ((bare.startsWith("diamond_") || bare.startsWith("netherite_")) && isEquipmentName(bare)) {
      return "critical";
    }
    if (VALUABLE_MATERIALS.some((material) => bare.startsWith(material)) && isEquipmentName(bare)) {
      return "valuable";
    }
    if (
      VALUABLE_NAMES.has(bare) ||
      /_smithing_template$/.test(bare) ||
      /^music_disc_/.test(bare) ||
      /_horse_armor$/.test(bare)
    ) {
      return "valuable";
    }
    if (
      USEFUL_NAMES.has(bare) ||
      /^[a-z_]+_log$/.test(bare) ||
      /_planks$/.test(bare) ||
      /_wool$/.test(bare) ||
      /^raw_/.test(bare)
    ) {
      return "useful";
    }
    if (LOW_TIER_MATERIALS.some((material) => bare.startsWith(material)) && isEquipmentName(bare)) {
      return "expendable";
    }
    if (EXPENDABLE_NAMES.has(bare) || /_seeds$/.test(bare) || COMMON_FLOWERS.has(bare)) {
      return "expendable";
    }
    // Spec 24.2: enchanted equipment is valuable (books with non-rare
    // enchantments stay common; rare ones were already critical).
    if (
      isEquipmentName(bare) &&
      signals?.enchants !== null &&
      signals?.enchants !== undefined &&
      signals.enchants.length > 0
    ) {
      return "valuable";
    }
    return "common";
  }

  /** 1 (critical) … 5 (expendable) — smaller means more valuable. */
  rank(value: ItemValue): number {
    return ITEM_VALUE_ORDER.indexOf(value) + 1;
  }
}