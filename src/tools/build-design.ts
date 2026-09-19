import { z } from "zod";
import { TaskPriority } from "../agent/task.js";
import type { Scheduler } from "../agent/scheduler.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import { BuildingDesignSchema } from "../building/schema.js";
import { landmarkTemplate, type LandmarkTemplate } from "../building/templates.js";
import { validateBuildingDesign } from "../building/validation.js";
export const BuildDesignArgsSchema = z.object({ template: z.enum(["pentagon_complex", "bundled_tube_skyscraper", "castle", "cathedral", "mansion", "greenhouse", "bridge", "museum"]).optional(), scale: z.enum(["small", "medium", "large"]).default("medium"), anchor: z.enum(["owner", "current", "home"]).default("owner"), design: BuildingDesignSchema.optional() }).refine((v) => v.template !== undefined || v.design !== undefined, "template or design is required");
export function registerBuildDesignTool(registry: ToolRegistry, scheduler: Scheduler): void {
  const def: ToolDefinition = { name: "build_design", description: "Build a validated composed architectural design or landmark template. Use for Pentagon, Sears/Willis Tower-inspired skyscrapers, castles, cathedrals, museums, and other multi-component buildings. Use build_structure for a basic room, wall, tower, or pyramid. Never emit code, raw coordinates, or unsupported primitive names; prefer medium scale and include doors, windows, lighting, and a navigable interior.", args: { template: "pentagon_complex | bundled_tube_skyscraper | castle | cathedral | mansion | greenhouse | bridge | museum", scale: "small | medium | large (default medium)", anchor: "owner | current | home", design: "complete BuildingDesign object" }, argsSchema: BuildDesignArgsSchema, handler: (raw, ctx): ToolResult => {
    const args = BuildDesignArgsSchema.parse(raw); let design = args.design ?? landmarkTemplate(args.template as LandmarkTemplate, args.scale); design = { ...design, anchor: args.anchor } as typeof design;
    let origin = ctx.state.home; if (origin === null) return "I cannot build a design because no home anchor is configured."; if (args.anchor === "current" && ctx.bot.entity) origin = { x: ctx.bot.entity.position.x, y: ctx.bot.entity.position.y, z: ctx.bot.entity.position.z, dimension: String(ctx.bot.game.dimension ?? "overworld") }; else if (args.anchor === "owner") { const owner = ctx.config.agent?.owner ?? "Corey"; const entity = ctx.bot.players[owner]?.entity; if (!entity) return `I cannot anchor at ${owner}: the owner is not currently visible.`; origin = { x: Math.floor(entity.position.x) + 4, y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) + 4, dimension: String(ctx.bot.game.dimension ?? "overworld") }; }
    try { design = validateBuildingDesign(design); } catch (err) { return `I rejected that design: ${String(err instanceof Error ? err.message : err)}`; }
    scheduler.enqueue({ type: "build_design", priority: TaskPriority.FOREGROUND, source: "user", objective: `Build ${design.name}.`, parameters: { design, origin } }); scheduler.claim(); return `Building ${design.name} at ${origin.x},${origin.y},${origin.z} (${design.scale} scale).`;
  } };
  registry.register(def);
}
