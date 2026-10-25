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
  /** Where the build is measured from; "current" and "owner" move until the build starts. */
  anchor: "home" | "current" | "owner";
  /** When the server planned this preview (ISO). */
  generatedAt: string;
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

/** What the viewer saw: echoed back so a later check can say what changed since. */
export interface PreviewBaseline {
  origin: BuildPreview["origin"];
  structureType: string;
  resumes: boolean;
  site: BuildPreview["site"];
  materials: readonly { material: string; missing: number }[];
}
/** Placement changes make a preview unsafe to start; condition changes only make it stale. */
export interface PreviewChanges { placement: string[]; conditions: string[] }

export type PreviewResult = { ok: true; preview: BuildPreview; changes?: PreviewChanges } | { ok: false; status: 400 | 503; error: string };

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
    const preview = describePreview({ text, anchor: args.anchor === "current" || args.anchor === "home" ? args.anchor : "owner", design, origin, structureType, operations, bot, stored: options.stored(), resumes: options.projects.findUnfinishedAt(structureType, origin) !== null });
    // Only a home anchor is fixed; the others are measured again when the
    // build starts, and starting from the preview refuses if they moved.
    if (args.anchor === "current") preview.notes = [...preview.notes, "Anchored where CobbleBob stands now. It moves with him, so it's checked again before it starts."];
    else if (args.anchor === "owner") preview.notes = [...preview.notes, "Anchored beside you. It moves with you, so it's checked again before it starts."];
    const baseline = parseBaseline(body.baseline);
    return baseline === null ? { ok: true, preview } : { ok: true, preview, changes: previewChanges(baseline, preview) };
  };
}

interface DescribeInput {
  text: string;
  anchor?: BuildPreview["anchor"];
  now?: Date;
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
    anchor: input.anchor ?? "owner",
    generatedAt: (input.now ?? new Date()).toISOString(),
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

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** The baseline a viewer echoes back, or null when it is absent or malformed. */
export function parseBaseline(raw: unknown): PreviewBaseline | null {
  if (raw === null || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const o = b.origin as Record<string, unknown> | null | undefined;
  const site = b.site as Record<string, unknown> | null | undefined;
  if (o === null || typeof o !== "object" || ![o.x, o.y, o.z].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (typeof b.structureType !== "string" || !Array.isArray(b.materials)) return null;
  return {
    origin: { x: o.x as number, y: o.y as number, z: o.z as number, dimension: typeof o.dimension === "string" ? o.dimension : "overworld" },
    structureType: b.structureType.slice(0, 200),
    resumes: b.resumes === true,
    site: { placed: count(site?.placed), obstructed: count(site?.obstructed), unloaded: count(site?.unloaded) },
    materials: b.materials.slice(0, 200).flatMap((m) => m !== null && typeof m === "object" && typeof (m as Record<string, unknown>).material === "string"
      ? [{ material: String((m as Record<string, unknown>).material).slice(0, 80), missing: count((m as Record<string, unknown>).missing) }] : []),
  };
}

const label = (material: string) => material.replace(/_/g, " ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What differs between the preview a viewer saw and a fresh one for the same request. */
export function previewChanges(before: PreviewBaseline, after: BuildPreview): PreviewChanges {
  const placement: string[] = [];
  const conditions: string[] = [];
  const a = before.origin, b = after.origin;
  if (a.dimension.replace(/^minecraft:/, "") !== b.dimension.replace(/^minecraft:/, "")) placement.push(`The site is now in the ${b.dimension.replace(/_/g, " ")}.`);
  else if (a.x !== b.x || a.y !== b.y || a.z !== b.z) {
    const moved = Math.round(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    const why = after.anchor === "current" ? " with CobbleBob" : after.anchor === "owner" ? " with you" : "";
    placement.push(`The site moved ${plural(Math.max(1, moved), "block")}${why}, to ${b.x}, ${b.y}, ${b.z}.`);
  }
  if (before.structureType !== after.structureType) placement.push(`The request now plans a ${label(after.structureType)}.`);
  if (before.resumes !== after.resumes) placement.push(after.resumes ? "An unfinished build now sits here; starting resumes it." : "The unfinished build here is gone; starting begins a new one.");
  if (after.site.obstructed > before.site.obstructed) placement.push(`${plural(after.site.obstructed - before.site.obstructed, "more cell")} ${after.site.obstructed - before.site.obstructed === 1 ? "is" : "are"} now blocked.`);
  else if (after.site.obstructed < before.site.obstructed) conditions.push(`${plural(before.site.obstructed - after.site.obstructed, "blocked cell")} cleared.`);
  if (after.site.placed !== before.site.placed) conditions.push(`${plural(after.site.placed, "block")} already in place (was ${before.site.placed}).`);
  const was = new Map(before.materials.map((m) => [m.material, m.missing]));
  for (const m of after.materials) {
    const old = was.get(m.material) ?? 0;
    if (m.missing === old) continue;
    conditions.push(m.missing === 0 ? `No longer short of ${label(m.material)}.` : old === 0 ? `Now short ${m.missing} ${label(m.material)}.` : `Short ${m.missing} ${label(m.material)} (was ${old}).`);
  }
  return { placement, conditions };
}

export interface PreviewStartOptions {
  preview: (raw: unknown) => Promise<PreviewResult>;
  /** Sends the command exactly as the dock's Send would. */
  send: (command: string) => Promise<{ ok: true; answer: string } | { ok: false; status: number; error: string }>;
}

/**
 * Start a previewed build only if it would still go where the viewer saw it:
 * plan it again against the viewer's baseline and refuse (409, with the fresh
 * preview) when the placement moved, a project appeared or vanished there, or
 * new blocks are in the way. Delivery follows the check in the same tick, and
 * the build tool freezes its origin on delivery, so a moving anchor can't
 * drift between the check and the start.
 */
export function createPreviewStart(options: PreviewStartOptions): (raw: unknown) => Promise<{ status: number; body: unknown }> {
  return async (raw) => {
    const body = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (parseBaseline(body.baseline) === null) return { status: 400, body: { error: "Preview the build again before starting it." } };
    const result = await options.preview(body);
    if (!result.ok) return { status: result.status === 503 ? 503 : 409, body: { error: `Nothing started: ${result.error}` } };
    const changes = result.changes ?? { placement: [], conditions: [] };
    if (changes.placement.length > 0) {
      return { status: 409, body: { error: "The placement changed since this preview, so nothing started. Check the updated preview, then start it again.", preview: result.preview, changes } };
    }
    const sent = await options.send(result.preview.command);
    if (!sent.ok) return { status: sent.status, body: { error: sent.error, preview: result.preview, changes } };
    return { status: 200, body: { answer: sent.answer, preview: result.preview, changes } };
  };
}
