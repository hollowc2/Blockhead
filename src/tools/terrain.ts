import { z } from "zod";
import type { Bot } from "mineflayer";
import type { WorldProjectManager } from "../agent/world-projects.js";
import type { Scheduler } from "../agent/scheduler.js";
import { normalizeDimension } from "../minecraft/protection.js";
import { resolveFootprintBounds, resolveOwnerFrontAnchor, snapCardinalYaw } from "../terrain/geometry.js";
import { createFrozenTerrainPlan, MineshaftSpecSchema, type BlockBounds, type CardinalDirection, type TerrainAnchor, type TerrainSpec } from "../terrain/schema.js";
import type { ToolContext, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";

const AnchorSchema = z.enum(["owner", "owner_front", "current", "home"]);
export const ClearAreaArgsSchema = z.object({ width: z.number().int().min(1).max(32), length: z.number().int().min(1).max(32), height: z.number().int().min(1).max(16).default(4), anchor: AnchorSchema.default("owner") });
export const FlattenAreaArgsSchema = z.object({ width: z.number().int().min(1).max(32), length: z.number().int().min(1).max(32), anchor: AnchorSchema.default("owner") });
export const ExcavateVolumeArgsSchema = z.object({ width: z.number().int().min(1).max(32), length: z.number().int().min(1).max(32), depth: z.number().int().min(1).max(32), anchor: AnchorSchema.default("owner") }).refine((v) => v.width * v.length * v.depth <= 8192, "excavation volume must not exceed 8192 blocks");
export const DigMineshaftArgsSchema = z.object({ width: z.union([z.literal(1), z.literal(2)]).default(1), height: z.union([z.literal(2), z.literal(3)]).default(2), targetY: z.number().int().optional(), depth: z.number().int().min(1).optional(), direction: z.enum(["north", "south", "east", "west"]).optional(), anchor: AnchorSchema.default("owner_front") }).superRefine((v, ctx) => { if ((v.targetY === undefined) === (v.depth === undefined)) ctx.addIssue({ code: "custom", path: ["targetY"], message: "exactly one of targetY or depth is required" }); });

type TerrainToolArgs = z.infer<typeof ClearAreaArgsSchema> | z.infer<typeof FlattenAreaArgsSchema> | z.infer<typeof ExcavateVolumeArgsSchema> | z.infer<typeof DigMineshaftArgsSchema>;
export type TerrainToolName = "clear_area" | "flatten_area" | "excavate_volume" | "dig_mineshaft";

function ownerName(ctx: ToolContext): string { return ctx.config.agent?.owner ?? "Corey"; }
function visibleOwner(bot: Bot, name: string): { x: number; y: number; z: number; dimension: string; yaw: number } | null {
  const entity = bot.players[name]?.entity;
  if (entity === undefined) return null;
  return { x: entity.position.x, y: entity.position.y, z: entity.position.z, dimension: normalizeDimension(String(bot.game.dimension ?? "overworld")), yaw: entity.yaw };
}

function anchorFor(ctx: ToolContext, anchor: TerrainAnchor): { x: number; y: number; z: number; dimension: string; yaw?: number } | string {
  const dimension = normalizeDimension(String(ctx.bot.game.dimension ?? "overworld"));
  if (anchor === "home") {
    if (ctx.state.home === null) return "no home anchor is configured";
    return { ...ctx.state.home, dimension: normalizeDimension(ctx.state.home.dimension) };
  }
  if (anchor === "current") {
    if (ctx.bot.entity === null || ctx.bot.entity === undefined) return "the bot has no current position";
    return { x: Math.floor(ctx.bot.entity.position.x), y: Math.floor(ctx.bot.entity.position.y), z: Math.floor(ctx.bot.entity.position.z), dimension };
  }
  const owner = visibleOwner(ctx.bot, ownerName(ctx));
  if (owner === null) return `the owner ${ownerName(ctx)} is not currently visible`;
  if (anchor === "owner_front") {
    const front = resolveOwnerFrontAnchor({ position: { x: owner.x, y: owner.y, z: owner.z, dimension: owner.dimension }, yaw: owner.yaw });
    return { ...front, yaw: owner.yaw };
  }
  return { x: Math.floor(owner.x), y: Math.floor(owner.y), z: Math.floor(owner.z), dimension: owner.dimension, yaw: owner.yaw };
}

function terrainPlan(ctx: ToolContext, kind: "clear" | "flatten" | "excavate" | "mineshaft", args: TerrainToolArgs): ReturnType<typeof createFrozenTerrainPlan> | string {
  const anchorKind = args.anchor;
  const resolved = anchorFor(ctx, anchorKind);
  if (typeof resolved === "string") return resolved;
  const { x, y, z, dimension } = resolved;
  let bounds: BlockBounds;
  let specification: TerrainSpec;
  if (kind === "clear") {
    const value = args as z.infer<typeof ClearAreaArgsSchema>;
    bounds = resolveFootprintBounds({ x, y, z }, value.width, value.length, y, y + value.height - 1);
    specification = { kind, anchor: anchorKind, width: value.width, length: value.length, height: value.height };
  } else if (kind === "flatten") {
    const value = args as z.infer<typeof FlattenAreaArgsSchema>;
    bounds = resolveFootprintBounds({ x, y, z }, value.width, value.length, y - 16, y + 16);
    specification = { kind, anchor: anchorKind, width: value.width, length: value.length };
  } else if (kind === "excavate") {
    const value = args as z.infer<typeof ExcavateVolumeArgsSchema>;
    bounds = resolveFootprintBounds({ x, y, z }, value.width, value.length, y - value.depth, y - 1);
    specification = { kind, anchor: anchorKind, width: value.width, length: value.length, depth: value.depth };
  } else {
    const value = args as z.infer<typeof DigMineshaftArgsSchema>;
    const direction: CardinalDirection = value.direction ?? (anchorKind === "owner_front" && resolved.yaw !== undefined ? snapCardinalYaw(resolved.yaw) : "south");
    const segments = value.depth ?? Math.max(1, y - (value.targetY ?? y - 1));
    if (value.targetY !== undefined && value.targetY >= y) return "targetY must be below the entrance";
    const endX = x + (direction === "east" ? segments : direction === "west" ? -segments : 0);
    const endZ = z + (direction === "south" ? segments : direction === "north" ? -segments : 0);
    bounds = { minX: Math.min(x, endX) - Math.floor(value.width / 2), maxX: Math.max(x, endX) + Math.ceil(value.width / 2) - 1, minY: y - segments - 1, maxY: y + value.height, minZ: Math.min(z, endZ) - Math.floor(value.width / 2), maxZ: Math.max(z, endZ) + Math.ceil(value.width / 2) - 1 };
    specification = MineshaftSpecSchema.parse({ kind, anchor: anchorKind, width: value.width, height: value.height, targetY: value.targetY, depth: value.depth, direction });
  }
  return createFrozenTerrainPlan({ world: ctx.config.server.world_key, dimension, anchor: { x, y, z, dimension }, bounds, specification });
}

function register(registry: ToolRegistry, scheduler: Scheduler, projects: WorldProjectManager, name: string, schema: typeof ClearAreaArgsSchema | typeof FlattenAreaArgsSchema | typeof ExcavateVolumeArgsSchema | typeof DigMineshaftArgsSchema, kind: "clear" | "flatten" | "excavate" | "mineshaft", description: string): void {
  registry.register({ name, description, args: {}, argsSchema: schema, handler: (raw, ctx): ToolResult => {
    const args = schema.parse(raw) as TerrainToolArgs;
    const plan = terrainPlan(ctx, kind, args);
    if (typeof plan === "string") return `I cannot start ${kind}: ${plan}.`;
    try {
      const result = projects.createTerrainProject({ userGoal: `${kind} terrain project`, source: "user", plan });
      scheduler.claim();
      const verb = result.resumed ? "Resuming" : "Starting";
      return `${verb} ${kind} in ${plan.dimension}: bounds ${plan.bounds.minX},${plan.bounds.minY},${plan.bounds.minZ} to ${plan.bounds.maxX},${plan.bounds.maxY},${plan.bounds.maxZ} (plan ${plan.geometryHash.slice(0, 12)}).`;
    } catch (error) { return `I could not start ${kind}: ${error instanceof Error ? error.message : String(error)}.`; }
  } });
}

export function registerTerrainTools(registry: ToolRegistry, scheduler: Scheduler, projects: WorldProjectManager): void {
  register(registry, scheduler, projects, "clear_area", ClearAreaArgsSchema, "clear", "Clear a bounded above-ground rectangular area while preserving its ground plane and fixtures.");
  register(registry, scheduler, projects, "flatten_area", FlattenAreaArgsSchema, "flatten", "Flatten a bounded rectangular area to the owner-relative walking plane with verified support.");
  register(registry, scheduler, projects, "excavate_volume", ExcavateVolumeArgsSchema, "excavate", "Excavate a bounded rectangular volume; hazards, fixtures, and unobserved cells are refused.");
  register(registry, scheduler, projects, "dig_mineshaft", DigMineshaftArgsSchema, "mineshaft", "Dig a bounded traversable staircase mineshaft to a target Y or depth; never a vertical shaft.");
}
