/**
 * Bootstrap mode state machine (spec section 7).
 *
 * CobbleBob bootstraps a brand-new world through a known sequence of stages
 * instead of an LLM-invented plan. The full stage list is declared here so
 * persisted progress stays forward-compatible as later phases implement more
 * stages; the runner executes only the stages a build implements.
 */

export enum BootstrapStage {
  HOME = "home",
  WOOD = "wood",
  CRAFTING = "crafting",
  STONE_TOOLS = "stone_tools",
  FOOD = "food",
  WOOL = "wool",
  BED = "bed",
  STORAGE = "storage",
  FURNACE = "furnace",
  FUEL = "fuel",
  TORCHES = "torches",
  IRON = "iron",
  IRON_TOOLS = "iron_tools",
  NORMAL_OPERATION = "normal_operation",
}

/** Canonical stage order; persistence stores the last completed stage. */
export const BOOTSTRAP_STAGE_ORDER: readonly BootstrapStage[] = [
  BootstrapStage.HOME,
  BootstrapStage.WOOD,
  BootstrapStage.CRAFTING,
  BootstrapStage.STONE_TOOLS,
  BootstrapStage.FOOD,
  BootstrapStage.STORAGE,
  BootstrapStage.FURNACE,
  BootstrapStage.FUEL,
  BootstrapStage.TORCHES,
  // Wool and a bed are useful but not load-bearing for autonomous operation.
  BootstrapStage.WOOL,
  BootstrapStage.BED,
  BootstrapStage.IRON,
  BootstrapStage.IRON_TOOLS,
  BootstrapStage.NORMAL_OPERATION,
];

/**
 * Stages implemented by this build (Phase 5.6: HOME -> WOOD -> CRAFTING ->
 * STONE_TOOLS -> FOOD -> STORAGE -> FURNACE -> FUEL -> TORCHES -> WOOL ->
 * BED -> IRON -> IRON_TOOLS). NORMAL_OPERATION is the terminal marker,
 * not an executable stage; persisting it signals bootstrap is done.
 */
export const BOOTSTRAP_STAGES: readonly BootstrapStage[] = [
  BootstrapStage.HOME,
  BootstrapStage.WOOD,
  BootstrapStage.CRAFTING,
  BootstrapStage.STONE_TOOLS,
  BootstrapStage.FOOD,
  BootstrapStage.STORAGE,
  BootstrapStage.FURNACE,
  BootstrapStage.FUEL,
  BootstrapStage.TORCHES,
  BootstrapStage.WOOL,
  BootstrapStage.BED,
  BootstrapStage.IRON,
  BootstrapStage.IRON_TOOLS,
];

/** The stage to execute after `completed`, or null when bootstrap is finished. */
export function nextBootstrapStage(completed: BootstrapStage | null): BootstrapStage | null {
  if (completed === null) return BOOTSTRAP_STAGE_ORDER[0] ?? null;
  const index = BOOTSTRAP_STAGE_ORDER.indexOf(completed);
  if (index < 0) return null;
  return BOOTSTRAP_STAGE_ORDER[index + 1] ?? null;
}
