import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Vec3 } from "vec3";
import { BuildingDesignSchema } from "./schema.js";
import { validateBuildingDesign } from "./validation.js";
import { compileBuildingDesign } from "./compiler.js";

const Point = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const SavedPlan = z.object({
  home: Point.extend({ dimension: z.string() }),
  design: BuildingDesignSchema,
  preconditions: z.array(Point.extend({ names: z.array(z.string()).min(1) })).min(1).max(1024),
});

/** Owner-installed, surveyed plans use the ordinary validated project runner. */
export async function loadSavedBuildPlan(
  name: string,
  home: { x: number; y: number; z: number; dimension: string } | null,
  blockAt: (position: Vec3) => { name: string } | null,
  directory = fileURLToPath(new URL("../../config/build-plans/", import.meta.url)),
): Promise<{ anchor: "home"; design: z.output<typeof BuildingDesignSchema> }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("use a saved plan name containing letters, numbers and hyphens");
  const raw = await readFile(resolve(directory, `${name}.json`), "utf8");
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("saved plan is too large");
  const plan = SavedPlan.parse(JSON.parse(raw));
  if (home === null || ["x", "y", "z", "dimension"].some((key) => home[key as keyof typeof home] !== plan.home[key as keyof typeof plan.home])) {
    throw new Error("home no longer matches the surveyed plan");
  }
  if (plan.design.anchor !== "home") throw new Error("saved plans must use the surveyed home anchor");
  const design = validateBuildingDesign(plan.design);
  compileBuildingDesign(design, home);
  for (const cell of plan.preconditions) {
    const at = new Vec3(home.x + cell.x, home.y + cell.y, home.z + cell.z);
    const actual = blockAt(at)?.name;
    if (actual === undefined || !cell.names.includes(actual)) throw new Error(`survey changed at ${at.x},${at.y},${at.z}: ${actual ?? "unloaded"}`);
  }
  return { anchor: "home", design };
}
