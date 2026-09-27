import type { Scheduler } from "../agent/scheduler.js";
import { TaskPriority } from "../agent/task.js";
import type { BuildProjectManager } from "../agent/build-projects.js";
import type { BuildingDesign } from "../building/schema.js";
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Register the centralized-stockpile tool (spec 4.3 "improve basic
 * infrastructure"). `build_base` builds (or repairs) the plank shed at home —
 * walls, roof, and door — so the chest row and stations stockpile at one
 * centralized location instead of a scatter pile. The handler enqueues a
 * scheduler task exactly like the storage tools: deterministic skill code
 * behind one user-picked tool name.
 */
export function registerBaseTools(registry: ToolRegistry, scheduler: Scheduler, projects: BuildProjectManager): void {
  /** True when a base-build task is already queued or active (no stacking). */
  const baseTaskActive = (): boolean => {
    if (scheduler.active?.type === "build_base") return true;
    return scheduler.queued.some((task) => task.type === "build_base");
  };

  const tools: ToolDefinition[] = [
    {
      name: "build_base",
      description:
        "Build (or repair) the stockpile shed at home: plank walls, a flat roof, and an oak door. The chest row, crafting table, and furnace each have a fixed slot inside, so storage and stations stay at one centralized location. Uses planks from gathered logs; a partially built shed is finished, never rebuilt.",
      args: {},
      handler: (_args, _ctx): ToolResult => {
        if (baseTaskActive()) return "Already building the base.";
        scheduler.enqueue({
          type: "build_base",
          priority: TaskPriority.FOREGROUND,
          source: "user",
          objective: "Build the base structure at home.",
          parameters: {},
        });
        scheduler.claim();
        return "Building the base.";
      },
    },
    {
      name: "build_structure",
      description:
        "Build a deterministic bounded structure from approved wood planks. Shapes: rectangular room, wall, tower, or hollow stepped pyramid. Dimensions are validated (1-15 blocks, height 1-12, at most 1024 blueprint blocks). Anchor may be owner, current bot position, or home; the chosen world coordinate is frozen into the persisted task so reconnects resume the same build.",
      args: {
        shape: '"room" | "wall" | "tower" | "pyramid"',
        width: "integer 1-15",
        height: "integer 1-12",
        length: "integer 1-15",
        material: '"planks" (approved wood-plank family)',
        anchor: '"owner" | "current" | "home"',
      },
      argsSchema: z.object({
        shape: z.enum(["room", "wall", "tower", "pyramid"]),
        width: z.number().int().min(1).max(15),
        height: z.number().int().min(1).max(12),
        length: z.number().int().min(1).max(15),
        material: z.literal("planks").default("planks"),
        anchor: z.enum(["owner", "current", "home"]).default("owner"),
      }).superRefine((value, ctx) => {
        if (value.shape === "wall" && value.length !== 1) {
          ctx.addIssue({ code: "custom", message: "wall length must be 1; width controls its span" });
        }
        if (value.shape === "pyramid") {
          if (value.width % 2 === 0 || value.length % 2 === 0) {
            ctx.addIssue({ code: "custom", message: "pyramid width and length must be odd" });
          }
          const maxHeight = Math.ceil(Math.min(value.width, value.length) / 2);
          if (value.height > maxHeight) {
            ctx.addIssue({ code: "custom", message: `pyramid height ${value.height} exceeds ${maxHeight} for that footprint` });
          }
        }
      }),
      handler: (args, ctx): ToolResult => {
        const shape = String(args.shape);
        const width = Number(args.width);
        const height = Number(args.height);
        const length = Number(args.length);
        const anchorKind = String(args.anchor ?? "owner");
        const self = ctx.bot.entity;
        if (self === null) return "I cannot start a structure build until I am spawned.";
        let point: { x: number; y: number; z: number; dimension: string } | null = null;
        if (anchorKind === "home") point = ctx.state.home;
        else if (anchorKind === "current") point = { ...self.position, dimension: String(ctx.bot.game.dimension ?? "overworld") };
        else {
          const owner = ctx.config.agent?.owner ?? "Corey";
          const entity = ctx.bot.players[owner]?.entity;
          if (!entity) return `I cannot anchor at ${owner}: the owner is not currently visible.`;
          // Offset the footprint so construction never starts inside the owner.
          point = { x: entity.position.x + 3, y: entity.position.y, z: entity.position.z + 3, dimension: String(ctx.bot.game.dimension ?? "overworld") };
        }
        if (point === null) return "I cannot anchor at home because no home is configured.";
        const parameters = {
          shape, width, height, length, material: "planks", anchor: anchorKind,
          origin: { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z), dimension: point.dimension.replace(/^minecraft:/, "") },
        };
        // Asking again for the same build at the same spot resumes it, even
        // if the wood the bot carries has changed since it was started.
        const previous = projects.findUnfinishedAt(`simple_${shape}`, parameters.origin);
        const previousPlank = previous?.design.palette?.primary;
        const plank = typeof previousPlank === "string" && previousPlank.endsWith("_planks") ? previousPlank : preferredPlank(ctx.bot);
        const design = simpleStructureDesign(shape as SimpleStructureShape, width, height, length, parameters.origin, plank);
        const result = projects.createOrResume({
          userGoal: `Build a ${width}x${height}x${length} ${shape}.`,
          structureType: `simple_${shape}`,
          source: "user",
          design,
          origin: parameters.origin,
        });
        scheduler.claim();
        const action = result.resumed ? "Resuming" : "Building";
        return `${action} a ${width} wide, ${height} tall, ${length} long ${plank.replace(/_planks$/, "").replace(/_/g, " ")}-plank ${shape}.`;
      },
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}

/**
 * Translate the bounded legacy shape vocabulary into the shared immutable
 * building-design representation. Each generated component is deterministic
 * and uses the same origin captured by the tool, so reconnects and repeated
 * requests produce the same project hash and operation ranges.
 */
export function simpleStructureDesign(
  shape: SimpleStructureShape,
  width: number,
  height: number,
  length: number,
  origin: { x: number; y: number; z: number; dimension: string },
  plank = "oak_planks",
): BuildingDesign {
  const components: BuildingDesign["components"] = [];
  const component = (value: BuildingDesign["components"][number]): void => { components.push(value); };
  const base = {
    name: `Simple ${shape}`,
    description: `Deterministic ${shape} built from approved ${plank.replace(/_/g, " ")}.`,
    anchor: origin,
    orientation: "north" as const,
    scale: "small" as const,
    palette: {
      foundation: plank, primary: plank, secondary: plank,
      frame: plank, glass: "glass", roof: plank, floor: plank,
      accent: plank, lighting: "torch", furniture: plank,
    },
    decoration: { interior: false, colorful: false, lighting: false },
  };

  if (shape === "wall") {
    component({ type: "wall", id: "simple-wall", start: { x: 0, y: 0, z: 0 }, end: { x: width - 1, y: 0, z: 0 }, height, thickness: 1, material: plank });
  } else if (shape === "pyramid") {
    for (let level = 0; level < height; level += 1) {
      component({
        type: "cuboid", id: `simple-pyramid-ring-${String(level + 1).padStart(2, "0")}`,
        width: width - level * 2, depth: length - level * 2, height: 1, mode: "hollow", material: plank,
        transform: { offset: { x: level, y: level, z: level } },
      });
    }
  } else if (shape === "room" && width >= 3 && length >= 3 && height >= 2) {
    // Four walls with a real doorway gap. A solid shell whose door later
    // *replaces* a wall block cannot be finished in survival: the builder
    // would have to break its own planks inside the protected home region.
    const door = Math.floor(width / 2);
    const front = length - 1;
    component({ type: "wall", id: "simple-wall-back", start: { x: 0, y: 0, z: 0 }, end: { x: width - 1, y: 0, z: 0 }, height, thickness: 1, material: plank });
    component({ type: "wall", id: "simple-wall-left", start: { x: 0, y: 0, z: 1 }, end: { x: 0, y: 0, z: front - 1 }, height, thickness: 1, material: plank });
    component({ type: "wall", id: "simple-wall-right", start: { x: width - 1, y: 0, z: 1 }, end: { x: width - 1, y: 0, z: front - 1 }, height, thickness: 1, material: plank });
    component({ type: "wall", id: "simple-wall-front-a", start: { x: 0, y: 0, z: front }, end: { x: door - 1, y: 0, z: front }, height, thickness: 1, material: plank });
    component({ type: "wall", id: "simple-wall-front-b", start: { x: door + 1, y: 0, z: front }, end: { x: width - 1, y: 0, z: front }, height, thickness: 1, material: plank });
    if (height > 2) {
      component({ type: "wall", id: "simple-wall-lintel", start: { x: door, y: 0, z: front }, end: { x: door, y: 0, z: front }, height: height - 2, thickness: 1, material: plank, transform: { offset: { x: 0, y: 2, z: 0 } } });
    }
    component({ type: "cuboid", id: "simple-roof", width, depth: length, height: 1, mode: "solid", material: plank, transform: { offset: { x: 0, y: height, z: 0 } } });
    component({ type: "door", id: "simple-door", width: 1, height: 2, transform: { offset: { x: door, y: 0, z: front } } });
  } else {
    component({ type: "cuboid", id: "simple-shell", width, depth: length, height, mode: "hollow", material: plank });
    component({ type: "cuboid", id: "simple-roof", width, depth: length, height: 1, mode: "solid", material: plank, transform: { offset: { x: 0, y: height, z: 0 } } });
  }

  return { ...base, components };
}

const WOOD_TYPES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"] as const;

/**
 * The plank family the bot can supply most of (planks carried plus four per
 * log), so a birch-forest bot builds in birch instead of stalling on oak.
 */
export function preferredPlank(bot: { inventory?: { items(): { name: string; count: number }[] } }): string {
  const items = bot.inventory?.items() ?? [];
  let best = { plank: "oak_planks", supply: 0 };
  for (const wood of WOOD_TYPES) {
    const supply = items.reduce((total, item) => {
      const name = item.name.replace(/^minecraft:/, "");
      if (name === `${wood}_planks`) return total + item.count;
      if (name === `${wood}_log` || name === `${wood}_wood` || name === `stripped_${wood}_log`) return total + item.count * 4;
      return total;
    }, 0);
    if (supply > best.supply) best = { plank: `${wood}_planks`, supply };
  }
  return best.plank;
}

type SimpleStructureShape = "room" | "wall" | "tower" | "pyramid";
