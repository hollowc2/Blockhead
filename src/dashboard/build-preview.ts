import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { MinecraftConfig } from "../config/schema.js";
import type { AgentState } from "../agent/state.js";
import type { BuildProjectManager } from "../agent/build-projects.js";
import { compileBuildingDesign, type BlueprintOperation } from "../building/compiler.js";
import type { BuildingDesign } from "../building/schema.js";
import { parseDeterministicBuildCommand } from "../minecraft/events.js";
import { planSimpleStructure } from "../tools/base.js";
import { planDesignBuild } from "../tools/build-design.js";

/**
 * Build previews for the private viewer: compile a build command exactly as
 * the build tool would (same anchor, plot search, plank choice and
 * compiler), without creating a project, and report the footprint, the way
 * it faces, the materials it needs against what CobbleBob carries and has
 * stored, and every block for a translucent ghost in the 3D view.
 */

export interface PreviewMaterial { material: string; needed: number; carried: number; stored: number; missing: number }
export interface BuildPreview {
  command: string;
  name: string;
  structureType: string;
  /** Asking for this build would resume an unfinished project at the same spot. */
  resumes: boolean;
  origin: { x: number; y: number; z: number; dimension: string };
  orientation: string;
  /** The side the entrance is on, when the design has a door. */
  facing: "north" | "south" | "east" | "west" | null;
  footprint: { width: number; depth: number; height: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  blocks: number;
  /** Cells already holding the planned block, and cells holding something else (loaded chunks only). */
  site: { placed: number; obstructed: number; unloaded: number };
  materials: readonly PreviewMaterial[];
  phases: readonly { phase: string; blocks: number }[];
  /** Flat [x, y, z, paletteIndex, ...] in world coordinates, for the 3D ghost. */
  ghost: { palette: readonly string[]; blocks: readonly number[]; truncated: boolean };
  notes: string[];
}

export type PreviewResult = { ok: true; preview: BuildPreview } | { ok: false; status: 400 | 503; error: string };

const MAX_GHOST_BLOCKS = 12_000;
const MAX_SITE_CHECKS = 20_000;
const MAX_COMMAND_CHARS = 500;
const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"];

export interface BuildPreviewOptions {
  bot: () => Bot | null;
  state: AgentState;
  config: MinecraftConfig;
  projects: Pick<BuildProjectManager, "findUnfinishedAt">;
  /** Validates arguments with the registered tool's schema (bounds, pyramid rules). */
  validateArgs: (tool: string, args: unknown) => Record<string, unknown>;
  /** Name → count over the home chests as last opened. */
  stored: () => Readonly<Record<string, number>>;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/^(cobblebob|cobble|bob)[\s,!?.]+/i, "").replace(/[!?.,]+$/, "").replace(/\s+/g, " ").trim();
}

export function createBuildPreview(options: BuildPreviewOptions): (raw: unknown) => Promise<PreviewResult> {
  return async (raw) => {
    const body = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const text = typeof body.command === "string" ? body.command.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
    if (!text || text.length > MAX_COMMAND_CHARS) return { ok: false, status: 400, error: "Type a build request to preview, like “build a tower at home”." };
    const bot = options.bot();
    if (bot === null || bot.entity === null || bot.entity === undefined) return { ok: false, status: 503, error: "CobbleBob is offline, so the build site can't be checked." };
    const parsed = parseDeterministicBuildCommand(normalize(text));
    if (parsed === null) return { ok: false, status: 400, error: "Previews work for rooms, houses, walls, towers, pyramids and landmark designs (castle, cathedral, museum…). Try “build a house at home”." };
    if (parsed.error) return { ok: false, status: 400, error: `That build isn't allowed: ${parsed.error}.` };
    if (parsed.tool === "build_base") return { ok: false, status: 400, error: "The stockpile shed has a fixed layout at home; ask for it directly." };
    let args: Record<string, unknown>;
    try { args = options.validateArgs(parsed.tool, parsed.args); } catch (error) { return { ok: false, status: 400, error: `That build isn't allowed: ${String(error instanceof Error ? error.message : error).replace(/^invalid arguments for \w+: /, "")}` }; }
    const ctx = { bot, state: options.state, config: options.config };
    const refuse = (reason: string): PreviewResult => ({ ok: false, status: 400, error: /not currently visible/.test(reason) ? `${reason} Add “at home” or “at current” to the request to preview it.` : reason });
    let design: BuildingDesign;
    let origin: BuildPreview["origin"];
    let structureType: string;
    if (parsed.tool === "build_structure") {
      const plan = planSimpleStructure(args, ctx, options.projects);
      if (typeof plan === "string") return refuse(plan);
      ({ design, origin, structureType } = plan);
    } else {
      const plan = planDesignBuild(args, ctx);
      if (typeof plan === "string") return refuse(plan);
      ({ design, origin } = plan);
      structureType = design.name;
    }
    let operations: BlueprintOperation[];
    try { operations = compileBuildingDesign(design, origin).operations; } catch (error) {
      return { ok: false, status: 400, error: `That design can't be built: ${String(error instanceof Error ? error.message : error)}` };
    }
    const preview = describePreview({ text, design, origin, structureType, operations, bot, stored: options.stored(), resumes: options.projects.findUnfinishedAt(structureType, origin) !== null });
    // Only a home anchor is fixed; the others are measured again when the build starts.
    if (args.anchor === "current") preview.notes = [...preview.notes, "Anchored where CobbleBob stands now; if he moves before it starts, it moves with him."];
    else if (args.anchor === "owner") preview.notes = [...preview.notes, "Anchored beside you; if you move before it starts, it moves with you."];
    return { ok: true, preview };
  };
}

interface DescribeInput {
  text: string;
  design: BuildingDesign;
  origin: BuildPreview["origin"];
  structureType: string;
  operations: readonly BlueprintOperation[];
  bot: Pick<Bot, "blockAt" | "inventory">;
  stored: Readonly<Record<string, number>>;
  resumes: boolean;
}

export function describePreview(input: DescribeInput): BuildPreview {
  const { operations, origin } = input;
  const at = (op: BlueprintOperation) => op.absolute ?? { x: origin.x + op.x, y: origin.y + op.y, z: origin.z + op.z };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const op of operations) {
    const p = at(op);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  if (operations.length === 0) minX = maxX = origin.x, minY = maxY = origin.y, minZ = maxZ = origin.z;

  const needed: Record<string, number> = {};
  const phases: Record<string, number> = {};
  for (const op of operations) {
    needed[op.material] = (needed[op.material] ?? 0) + 1;
    phases[op.phase] = (phases[op.phase] ?? 0) + 1;
  }
  const carried: Record<string, number> = {};
  for (const item of input.bot.inventory.items()) {
    const name = item.name.replace(/^minecraft:/, "");
    carried[name] = (carried[name] ?? 0) + item.count;
  }
  const notes: string[] = [];
  const materials = Object.entries(needed).sort((a, b) => b[1] - a[1]).map(([material, count]) => {
    const have = carried[material] ?? 0;
    const stock = input.stored[material] ?? 0;
    let missing = Math.max(0, count - have - stock);
    // Planks come from logs at four per log; count logs of the same wood.
    const wood = WOODS.find((name) => material === `${name}_planks`);
    if (wood !== undefined && missing > 0) {
      const logs = (carried[`${wood}_log`] ?? 0) + (input.stored[`${wood}_log`] ?? 0);
      if (logs > 0) notes.push(`${Math.min(missing, logs * 4)} ${material.replace(/_/g, " ")} can be crafted from ${logs} logs on hand.`);
      missing = Math.max(0, missing - logs * 4);
    }
    return { material, needed: count, carried: have, stored: stock, missing };
  });

  // Door cells sit in the entrance wall: whichever side of the footprint they touch.
  const door = operations.find((op) => /_door$/.test(op.material));
  let facing: BuildPreview["facing"] = null;
  if (door !== undefined) {
    const p = at(door);
    facing = p.z === maxZ ? "south" : p.z === minZ ? "north" : p.x === maxX ? "east" : p.x === minX ? "west" : null;
  }

  const site = { placed: 0, obstructed: 0, unloaded: 0 };
  for (const op of operations.slice(0, MAX_SITE_CHECKS)) {
    const p = at(op);
    let block: { name: string } | null = null;
    try { block = input.bot.blockAt(new Vec3(p.x, p.y, p.z)); } catch { block = null; }
    if (block === null) site.unloaded += 1;
    else if (block.name === op.material || (/_door$/.test(op.material) && /_door$/.test(block.name))) site.placed += 1;
    else if (!/^(?:air|cave_air|void_air|water|short_grass|grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy)$/.test(block.name)) site.obstructed += 1;
  }
  if (site.obstructed > 0) notes.push(`${site.obstructed} planned cells hold other blocks that would need clearing.`);
  if (site.unloaded > 0) notes.push(`${site.unloaded} cells are in chunks CobbleBob hasn't loaded, so they weren't checked.`);
  if (input.resumes) notes.push("An unfinished build already sits here; starting it resumes that build.");

  const palette = Object.keys(needed);
  const index = new Map(palette.map((material, i) => [material, i]));
  const ghost: number[] = [];
  for (const op of operations.slice(0, MAX_GHOST_BLOCKS)) {
    const p = at(op);
    ghost.push(p.x, p.y, p.z, index.get(op.material)!);
  }
  return {
    command: input.text,
    name: input.design.name,
    structureType: input.structureType,
    resumes: input.resumes,
    origin,
    orientation: input.design.orientation,
    facing,
    footprint: { width: maxX - minX + 1, depth: maxZ - minZ + 1, height: maxY - minY + 1, minX, maxX, minY, maxY, minZ, maxZ },
    blocks: operations.length,
    site,
    materials,
    phases: Object.entries(phases).map(([phase, blocks]) => ({ phase, blocks })),
    ghost: { palette, blocks: ghost, truncated: operations.length > MAX_GHOST_BLOCKS },
    notes,
  };
}
