import { Vec3 } from "vec3";
import type { SuccessCriterionInput } from "../llm/schemas.js";
import { findHomeChest, isChestBlock } from "../minecraft/containers.js";
import { normalizeDimension } from "../minecraft/protection.js";
import { terrainPlan } from "../tools/terrain.js";
import type { ToolContext } from "../tools/types.js";
import type { ClearAreaSpec } from "../terrain/schema.js";
import type { GoalBlockRef, SuccessCriterion } from "./goal.js";

/** How far from the owner (or the bot) "this chest" may stand. */
const NEAR_CHEST_RADIUS = 5;

/**
 * Freeze an owner-named criterion against the world at the moment the goal
 * is created. "This chest" and "this area" mean what was in front of the
 * owner when they said it — not wherever they stand when a queued goal
 * finally starts — so chests and areas resolve to coordinates now. Build
 * projects bind later (the house may not have been started yet).
 *
 * Returns the frozen criterion, or a short reason the owner hears instead.
 */
export function resolveCriterion(input: SuccessCriterionInput, ctx: ToolContext): SuccessCriterion | string {
  switch (input.kind) {
    case "stockpile":
    case "inventory":
      return input;
    case "building_verified":
      if (input.target === "base") return { kind: "building_verified", target: "base" };
      return input.project === undefined
        ? { kind: "building_verified", target: "project" }
        : { kind: "building_verified", target: "project", match: input.project };
    case "chest_contains": {
      const chest = resolveChest(input.chest, ctx);
      if (typeof chest === "string") return chest;
      return { kind: "chest_contains", item: input.item.replace(/^minecraft:/, ""), min: input.min, chest: chest.at, ...(chest.label === undefined ? {} : { label: chest.label }) };
    }
    case "area_cleared": {
      const plan = terrainPlan(ctx, "clear", { width: input.width, length: input.length, height: input.height, anchor: input.anchor });
      if (typeof plan === "string") return `cannot pin down the area: ${plan}`;
      const spec = plan.specification as ClearAreaSpec;
      return {
        kind: "area_cleared",
        dimension: plan.dimension,
        bounds: plan.bounds,
        anchor: { x: plan.anchor.x, y: plan.anchor.y, z: plan.anchor.z },
        anchorKind: spec.anchor,
        width: spec.width,
        length: spec.length,
        height: spec.height,
      };
    }
  }
}

function resolveChest(which: string, ctx: ToolContext): { at: GoalBlockRef; label?: string } | string {
  const dimension = normalizeDimension(String(ctx.bot.game?.dimension ?? "overworld"));
  const key = which.trim().toLowerCase();
  if (key === "home") {
    if (ctx.storage === undefined) return "no storage registry to find the home chest";
    const block = findHomeChest(ctx.bot, ctx.state, ctx.storage);
    if (block === null) return "there is no home chest";
    return { at: { x: block.position.x, y: block.position.y, z: block.position.z, dimension }, label: "home" };
  }
  if (key === "owner" || key === "this" || key === "bot" || key === "here") {
    const owner = ctx.config.agent?.owner ?? "Corey";
    const entity = key === "bot" || key === "here" ? ctx.bot.entity : ctx.bot.players[owner]?.entity;
    if (entity === undefined || entity === null) return `I can't see ${owner} to find the chest by them`;
    const near = nearestChest(ctx, entity.position);
    if (near === null) return `there is no chest within ${NEAR_CHEST_RADIUS} blocks of ${key === "bot" || key === "here" ? "me" : owner}`;
    return { at: { ...near, dimension } };
  }
  // A registered storage label or category ("food", "home_main_chest").
  const worldId = ctx.state.worldId;
  if (ctx.storage === undefined || worldId === null) return `no registered chest called "${which}"`;
  const match = ctx.storage.list(worldId).find((location) => location.label?.toLowerCase() === key)
    ?? ctx.storage.listByCategory(worldId, key)[0];
  if (match === undefined) return `no registered chest called "${which}"`;
  return { at: { x: match.x, y: match.y, z: match.z, dimension: normalizeDimension(match.dimension) }, label: match.label ?? match.category };
}

function nearestChest(ctx: ToolContext, from: Vec3): { x: number; y: number; z: number } | null {
  const origin = from.floored();
  let best: { x: number; y: number; z: number; distance: number } | null = null;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dz = -NEAR_CHEST_RADIUS; dz <= NEAR_CHEST_RADIUS; dz += 1) {
      for (let dx = -NEAR_CHEST_RADIUS; dx <= NEAR_CHEST_RADIUS; dx += 1) {
        const at = origin.offset(dx, dy, dz);
        const block = ctx.bot.blockAt(new Vec3(at.x, at.y, at.z));
        if (block === null || !isChestBlock(block)) continue;
        const distance = Math.hypot(dx, dy, dz);
        if (best === null || distance < best.distance) best = { x: at.x, y: at.y, z: at.z, distance };
      }
    }
  }
  return best === null ? null : { x: best.x, y: best.y, z: best.z };
}
