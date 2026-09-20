import { createHash } from "node:crypto";
import { BUILDING_SCHEMA_VERSION, BuildingDesignSchema, type BuildingComponent, type BuildingDesign } from "./schema.js";
import { DEFAULT_BUILDING_LIMITS, type BuildingLimits } from "./validation.js";
export const BUILDING_COMPILER_VERSION = "1.1.0";
export const DEFAULT_BLUEPRINT_CHUNK_SIZE = 50;
export type BuildPhase = "foundation" | "structural_shell" | "floors" | "roof" | "doors_windows" | "lighting" | "interior";
export interface BlueprintOperation { id: string; x: number; y: number; z: number; absolute?: { x: number; y: number; z: number; dimension: string }; material: string; phase: BuildPhase; replaceExisting: boolean; structural: boolean; componentId?: string; }
export interface BlueprintPhase { id: string; label: string; phase: BuildPhase; operationStart: number; operationEnd: number; }
export interface Blueprint { origin: { x: number; y: number; z: number; dimension: string }; operations: BlueprintOperation[]; phases?: BlueprintPhase[]; estimates: { blocks: number; materials: Record<string, number> }; footprint: { width: number; depth: number; height: number }; compilerVersion?: string; schemaVersion?: string; hash?: string; }
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
function rotate(x: number, z: number, rotation: number, mirror: boolean): [number, number] { if (mirror) x = -x; switch (rotation) { case 90: return [-z, x]; case 180: return [-x, -z]; case 270: return [z, -x]; default: return [x, z]; } }
function materialFor(c: BuildingComponent, d: BuildingDesign): string { return (c.material ?? (c.type === "floor" || c.type === "interior_zone" ? d.palette.floor : c.type === "roof" ? d.palette.roof : d.palette.primary)).replace(/^minecraft:/, ""); }
export function compileBuildingDesign(design: BuildingDesign, origin: { x: number; y: number; z: number; dimension: string }, limits: BuildingLimits = DEFAULT_BUILDING_LIMITS): Blueprint {
  // Normalize here as well as at tool boundaries so direct compiler callers
  // retain deterministic IDs for legacy designs that omit them.
  design = BuildingDesignSchema.parse(design);
  const ops = new Map<string, BlueprintOperation>(); const preservedStructural: BlueprintOperation[] = []; let maxX = 0, maxZ = 0, maxY = 0;
  const add = (c: BuildingComponent, x: number, y: number, z: number, phase: BuildPhase, structural = true, material = materialFor(c, design), replaceExisting = false) => {
    const t = { repeat: 1, rotation: 0 as 0, mirror: false, verticalStack: 1, ...(c.transform ?? {}) }; const [rx, rz] = rotate(x + (t.offset?.x ?? 0), z + (t.offset?.z ?? 0), t.rotation, t.mirror); const yy = y + (t.offset?.y ?? 0);
    for (let rep = 0; rep < t.repeat; rep++) for (let stack = 0; stack < t.verticalStack; stack++) { const px = rx + rep * (c.type === "wall" ? 0 : 0); const pz = rz + rep * (c.type === "wall" ? 0 : 0); const k = key(px, yy + stack, pz); const prior = ops.get(k); if (prior && prior.material !== material && structural) throw new Error(`conflicting components at ${k}`); if (!structural && replaceExisting && prior?.structural) preservedStructural.push(prior); if (!prior || (!structural && replaceExisting)) ops.set(k, { id: `op-${String(ops.size).padStart(5, "0")}`, x: px, y: yy + stack, z: pz, absolute: { x: origin.x + px, y: origin.y + yy + stack, z: origin.z + pz, dimension: origin.dimension }, material, phase, replaceExisting, structural, componentId: c.id }); maxX = Math.max(maxX, Math.abs(px)); maxZ = Math.max(maxZ, Math.abs(pz)); maxY = Math.max(maxY, yy + stack); }
  };
  const ring = (c: BuildingComponent, w: number, d: number, h: number, ox = 0, oz = 0) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) if (c.type === "cuboid" && c.mode === "solid" || x === 0 || z === 0 || x === w - 1 || z === d - 1) add(c, ox + x, y, oz + z, "structural_shell"); };
  for (const c of design.components) {
    switch (c.type) {
      case "cuboid": ring(c, c.width, c.depth, c.height); break;
      case "polygon_prism": for (let y = 0; y < c.height; y++) for (let x = -c.radius; x <= c.radius; x++) for (let z = -c.radius; z <= c.radius; z++) { const distance = Math.hypot(x, z); const angle = Math.atan2(z, x); const sector = ((angle + Math.PI * 2) % (Math.PI * 2 / c.sides)); const boundary = c.radius / Math.cos(sector - Math.PI / c.sides); if (distance <= boundary && (c.mode === "solid" || distance >= boundary - 1.5)) add(c, x, y, z, "structural_shell"); } break;
      case "tower": { const w = c.footprint.width ?? 9, d = c.footprint.depth ?? 9; ring(c, w, d, c.height); break; }
      case "bundled_towers": { const offsets = c.layout === "explicit" ? (c.offsets ?? []) : [-1, 0, 1].flatMap(ix => [-1, 0, 1].map(iz => ({ x: ix * c.width, y: 0, z: iz * c.depth }))); offsets.forEach((o, i) => ring(c, c.width, c.depth, c.heights[i % c.heights.length]!, o.x, o.z)); break; }
      case "wall": { const dx = Math.sign(c.end.x - c.start.x), dz = Math.sign(c.end.z - c.start.z), length = Math.max(Math.abs(c.end.x - c.start.x), Math.abs(c.end.z - c.start.z)) + 1; for (let y = 0; y < c.height; y++) for (let n = 0; n < length; n++) for (let t = 0; t < c.thickness; t++) add(c, c.start.x + dx * n + (dz ? t : 0), y, c.start.z + dz * n + (dx ? t : 0), "structural_shell"); break; }
      case "floor": for (let x = 0; x < c.width; x++) for (let z = 0; z < c.depth; z++) add(c, x, c.y, z, "floors", false); break;
      case "roof": for (let y = 0; y < c.height; y++) { const inset = c.style === "flat" ? 0 : y; for (let x = inset; x < c.width - inset; x++) for (let z = inset; z < c.depth - inset; z++) if (c.style !== "peaked" || x === inset || x === c.width - inset - 1 || z === inset || z === c.depth - inset - 1) add(c, x, y, z, "roof"); } break;
      case "window_pattern": for (let r = 0; r < c.rows; r++) for (let col = 0; col < c.columns; col++) add(c, c.margins + col * c.spacing, 1 + r * 2, 0, "doors_windows", false, design.palette.glass, true); break;
      case "door": for (let x = 0; x < c.width; x++) for (let y = 0; y < c.height; y++) add(c, x, y, 0, "doors_windows", false, "oak_door", true); break;
      case "column": for (let y = 0; y < c.height; y++) add(c, 0, y, 0, "structural_shell"); break;
      case "stair_step": for (let n = 0; n < c.steps; n++) for (let x = 0; x < c.width; x++) add(c, x, n, n, "interior", false, c.material ?? design.palette.floor); break;
      case "arch": for (let x = 0; x < c.width; x++) for (let y = 0; y < c.height; y++) if (x === 0 || x === c.width - 1 || y === c.height - 1) add(c, x, y, 0, "structural_shell"); break;
      case "interior_zone": for (let x = 1; x < c.width - 1; x++) for (let z = 1; z < c.depth - 1; z++) if ((x + z) % 3 === 0) add(c, x, 0, z, "interior", false, c.kind === "library" ? design.palette.furniture : design.palette.accent); break;
      case "decoration": for (let n = 0; n < c.count; n++) add(c, 1 + (n % 8), 1 + Math.floor(n / 8), 1, c.kind === "lighting" ? "lighting" : "interior", false, c.kind === "lighting" ? design.palette.lighting : c.kind === "carpets" ? "red_carpet" : c.kind === "bookshelves" ? design.palette.furniture : design.palette.accent); break;
    }
  }
  const phases: Record<BuildPhase, number> = { foundation: 0, structural_shell: 1, floors: 2, roof: 3, doors_windows: 4, lighting: 5, interior: 6 };
  // A replacement is a later world transition, not a compile-time overwrite.
  // Retaining the wall cell lets upper structural layers use it as support;
  // the door/window operation replaces it only after the shell is complete.
  const operations = [...preservedStructural, ...ops.values()].sort((a, b) => phases[a.phase] - phases[b.phase] || a.y - b.y || a.x - b.x || a.z - b.z);
  operations.forEach((operation, index) => { operation.id = `op-${String(index).padStart(5, "0")}`; });
  if (operations.length > limits.maxOperations || maxX * 2 + 1 > limits.maxWidth || maxZ * 2 + 1 > limits.maxDepth || maxY + 1 > limits.maxHeight) throw new Error("compiled design exceeds configured building limits");
  const materials: Record<string, number> = {}; for (const op of operations) materials[op.material] = (materials[op.material] ?? 0) + 1;
  const blueprintPhases = createBlueprintPhases(operations);
  const withoutHash = { origin, operations, phases: blueprintPhases, estimates: { blocks: operations.length, materials }, footprint: { width: maxX * 2 + 1, depth: maxZ * 2 + 1, height: maxY + 1 }, compilerVersion: BUILDING_COMPILER_VERSION, schemaVersion: BUILDING_SCHEMA_VERSION };
  const hash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return { ...withoutHash, hash };
}

/** Split each canonical compiler phase into fixed-size, deterministic chunks. */
export function createBlueprintPhases(operations: readonly BlueprintOperation[], chunkSize = DEFAULT_BLUEPRINT_CHUNK_SIZE): BlueprintPhase[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("blueprint chunk size must be a positive integer");
  const result: BlueprintPhase[] = [];
  let start = 0;
  while (start < operations.length) {
    const phase = operations[start]!.phase;
    let phaseEnd = start + 1;
    while (phaseEnd < operations.length && operations[phaseEnd]!.phase === phase) phaseEnd += 1;
    let ordinal = 1;
    for (let chunkStart = start; chunkStart < phaseEnd; chunkStart += chunkSize) {
      const operationEnd = Math.min(chunkStart + chunkSize, phaseEnd);
      const suffix = String(ordinal).padStart(3, "0");
      result.push({ id: `phase-${phase}-${suffix}`, label: `${phase}-${suffix}`, phase, operationStart: chunkStart, operationEnd });
      ordinal += 1;
    }
    start = phaseEnd;
  }
  return result;
}
