import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { HomeLocation } from "../minecraft/movement.js";
import {
  BASE_INTERIOR_RADIUS,
  BASE_WALL_HEIGHT,
  baseLayoutFor,
  DOOR_PLANK_COST,
  freeChestSlotSpot,
  isPlacementWithinReach,
  measureStructure,
  stationSlotSpot,
  simpleStructureCells,
  simpleStructureDecorations,
  simpleStructureDoorCells,
  type BaseLayout,
  BaseBuilderRunner,
} from "./base.js";
import type { Blueprint } from "../building/compiler.js";

/**
 * The centralized stockpile base: placement must be deterministic and
 * collision-free even though every skill shares the blueprint. These tests
 * pin the layout math — wall/roof/door cells, the chest-slot row (spaced so
 * chests never merge into a double chest), the station slots, and the
 * reachability order that lets each block lean on an already-placed one.
 * The Minecraft placement mechanics are exercised live.
 */

const HOME: HomeLocation = { x: 10.5, y: 64, z: 20.5, dimension: "overworld" };
/** The floored home column (10, 64, 20), which all layout positions use. */
const CX = 10;
const CZ = 20;
const FY = 64;

function layout(): BaseLayout {
  return baseLayoutFor(HOME);
}

/** A stub bot whose world map marks specific cells; everything else unloaded. */
function stubBot(map: Record<string, "air" | "solid" | "planks" | "chest" | "oak_door">): Bot {
  const key = (v: Vec3): string => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
  return {
    blockAt: (v: Vec3): Block | null => {
      switch (map[key(v)]) {
        case undefined:
          return null;
        case "air":
          return { name: "air", boundingBox: "empty" } as Block;
        case "oak_door":
          return { name: "oak_door", boundingBox: "block" } as Block;
        case "planks":
          return { name: "oak_planks", boundingBox: "block" } as Block;
        default:
          return { name: "stone", boundingBox: "block" } as Block;
      }
    },
  } as unknown as Bot;
}

const airWorld = (): Record<string, "air" | "solid" | "planks" | "chest" | "oak_door"> => {
  const world: Record<string, "air" | "solid" | "planks" | "chest" | "oak_door"> = {};
  const l = layout();
  // Mark every layout cell itself as air first; the below-solid pass must
  // not clobber a layout cell (top wall cells sit directly above bottom
  // wall cells).
  const cells = [...l.wallCells, ...l.roofCells, ...l.doorCells, ...l.chestSlots, l.tableSlot, l.furnaceSlot];
  const asKey = (cell: { x: number; y: number; z: number }): string => `${cell.x},${cell.y},${cell.z}`;
  const cellSet = new Set(cells.map(asKey));
  for (const cell of cells) world[asKey(cell)] = "air";
  for (const cell of cells) {
    const below = `${cell.x},${cell.y - 1},${cell.z}`;
    if (!cellSet.has(below)) world[below] = "solid";
  }
  return world;
};

test("layout is anchored on the floored home column and sized by the constants", () => {
  const l = layout();
  assert.equal(l.floorY, FY);
  // Interior pad is (2 * INTERIOR_RADIUS + 1)^2; the wall ring sits one block
  // outside it, two layers high, minus the 2-cell door gap.
  const extent = BASE_INTERIOR_RADIUS + 1;
  const ringCellsPerLayer = (2 * extent + 1) ** 2 - (2 * BASE_INTERIOR_RADIUS + 1) ** 2;
  assert.equal(l.wallCells.length, ringCellsPerLayer * BASE_WALL_HEIGHT - 2);
  assert.equal(l.wallCells.length, 46);
  assert.equal(l.roofCells.length, (2 * extent + 1) ** 2);
  assert.equal(l.roofCells.length, 49);
  assert.equal(l.doorCells.length, 2);
});

test("walls stand on the ground and top walls stand on bottom walls", () => {
  const l = layout();
  assert.ok(l.wallCells.every((cell) => cell.y === FY || cell.y === FY + 1));
  for (const cell of l.wallCells.filter((c) => c.y === FY + 1)) {
    assert.ok(
      l.wallCells.some((w) => w.equals(cell.offset(0, -1, 0))),
      `top wall ${cell} has no bottom wall below`,
    );
  }
});

test("the door gap is the front face center, excluded from the walls", () => {
  const l = layout();
  const [lower, upper] = l.doorCells;
  assert.deepEqual(lower, new Vec3(CX, FY, CZ + 3));
  assert.deepEqual(upper, new Vec3(CX, FY + 1, CZ + 3));
  assert.ok(!l.wallCells.some((cell) => cell.equals(lower!)));
  assert.ok(!l.wallCells.some((cell) => cell.equals(upper!)));
  // The gap sits in the front wall (only +Z cells at the door column).
  assert.ok(l.wallCells.every((cell) => !(cell.x === CX && cell.z === CZ + 3)));
});

test("every roof cell has support: a wall top below or an earlier-placed neighbor", () => {
  const l = layout();
  const isWall = (v: Vec3): boolean => l.wallCells.some((w) => w.equals(v));
  const earlier: Vec3[] = [];
  for (const cell of l.roofCells) {
    const onWallTop = isWall(cell.offset(0, -1, 0));
    const leansOnEarlier = earlier.some((e) => e.distanceTo(cell) === 1);
    assert.ok(onWallTop || leansOnEarlier, `roof cell ${cell} has no support`);
    earlier.push(cell);
  }
  // The ring goes first: every inner cell leans on a ring cell or an earlier
  // inner cell, so placement never depends on a not-yet-placed neighbor.
  const ring = l.roofCells.slice(0, 24);
  assert.ok(ring.every((c) => Math.max(Math.abs(c.x - CX), Math.abs(c.z - CZ)) === 3));
  // Every ring cell leans on a wall top except the one directly over the
  // door gap (the gap has no wall); that one leans on its earlier ring
  // neighbor (-1, z) already placed by the ring's west-to-east order.
  const overDoor = ring.find((c) => c.x === CX && c.z === CZ + 3)!;
  assert.ok(ring.every((c) => c === overDoor || isWall(c.offset(0, -1, 0))));
  assert.ok(ring.some((c) => c.x === CX - 1 && c.z === CZ + 3 && c.y === overDoor.y));
  const inner = l.roofCells.slice(24);
  assert.equal(inner.length, 25);
  assert.ok(inner.every((c) => Math.max(Math.abs(c.x - CX), Math.abs(c.z - CZ)) <= BASE_INTERIOR_RADIUS));
});

test("chest slots form a centered back-wall row, never orthogonally adjacent", () => {
  const l = layout();
  assert.deepEqual(
    l.chestSlots,
    [
      new Vec3(CX, FY, CZ - 2),
      new Vec3(CX - 2, FY, CZ - 2),
      new Vec3(CX + 2, FY, CZ - 2),
    ],
    "center slot first, then the two outer slots",
  );
  // Adjacent chest cells would merge into a double chest; spaced 2 apart is
  // the invariant that keeps every chest a single registry row.
  for (let i = 0; i < l.chestSlots.length; i++) {
    for (let j = i + 1; j < l.chestSlots.length; j++) {
      assert.notEqual(l.chestSlots[i]!.distanceTo(l.chestSlots[j]!), 1);
    }
  }
  assert.ok(l.chestSlots.every((s) => Math.abs(s.z - CZ) === BASE_INTERIOR_RADIUS));
});

test("station slots are inside the pad, distinct from every other slot", () => {
  const l = layout();
  assert.deepEqual(l.tableSlot, new Vec3(CX - 1, FY, CZ + 1));
  assert.deepEqual(l.furnaceSlot, new Vec3(CX + 1, FY, CZ + 1));
  const all = [...l.chestSlots, ...l.doorCells, l.tableSlot, l.furnaceSlot];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.ok(!all[i]!.equals(all[j]!), `duplicate slot ${all[i]}`);
    }
  }
});

test("measurement: a virgin pad needs 46 wall + 49 roof + 6 door = 101 planks", () => {
  const m = measureStructure(stubBot(airWorld()), layout());
  assert.equal(m.missingWalls, 46);
  assert.equal(m.missingRoof, 49);
  assert.equal(m.doorMissing, true);
  assert.equal(m.blocked, 0);
  assert.equal(m.planksNeeded, 46 + 49 + DOOR_PLANK_COST);
  assert.equal(m.planksNeeded, 101);
  assert.equal(m.needsWork, true);
});

test("measurement: a complete shell needs no work", () => {
  const world = airWorld();
  const l = layout();
  for (const cell of l.wallCells) world[`${cell.x},${cell.y},${cell.z}`] = "planks";
  for (const cell of l.roofCells) world[`${cell.x},${cell.y},${cell.z}`] = "planks";
  world[`${l.doorCells[0]!.x},${l.doorCells[0]!.y},${l.doorCells[0]!.z}`] = "oak_door";
  world[`${l.doorCells[1]!.x},${l.doorCells[1]!.y},${l.doorCells[1]!.z}`] = "oak_door";
  const m = measureStructure(stubBot(world), l);
  assert.equal(m.missingWalls, 0);
  assert.equal(m.missingRoof, 0);
  assert.equal(m.doorMissing, false);
  assert.equal(m.planksNeeded, 0);
  assert.equal(m.needsWork, false);
});

test("measurement: a partial build counts only what is still air", () => {
  const world = airWorld();
  const l = layout();
  // The whole bottom wall layer is up; roof, top wall, and door are not.
  for (const cell of l.wallCells.filter((c) => c.y === FY)) {
    world[`${cell.x},${cell.y},${cell.z}`] = "planks";
  }
  const m = measureStructure(stubBot(world), l);
  assert.equal(m.missingWalls, 23);
  assert.equal(m.missingRoof, 49);
  assert.equal(m.planksNeeded, 23 + 49 + DOOR_PLANK_COST);
});

test("measurement detects wrong non-air materials instead of treating them as complete", () => {
  const world = airWorld();
  const l = layout();
  for (const cell of l.wallCells) world[`${cell.x},${cell.y},${cell.z}`] = "planks";
  for (const cell of l.roofCells) world[`${cell.x},${cell.y},${cell.z}`] = "planks";
  world[`${l.doorCells[0]!.x},${l.doorCells[0]!.y},${l.doorCells[0]!.z}`] = "oak_door";
  world[`${l.doorCells[1]!.x},${l.doorCells[1]!.y},${l.doorCells[1]!.z}`] = "oak_door";
  world[`${l.wallCells[0]!.x},${l.wallCells[0]!.y},${l.wallCells[0]!.z}`] = "chest";
  const m = measureStructure(stubBot(world), l);
  assert.equal(m.missingWalls, 0);
  assert.equal(m.missingRoof, 0);
  assert.equal(m.doorMissing, false);
  assert.equal(m.blocked, 1);
  assert.equal(m.needsWork, true);
});

test("freeChestSlotSpot fills center first, then the outer slots, then none", () => {
  // All free: the center slot wins.
  const first = freeChestSlotSpot(stubBot(airWorld()), HOME);
  assert.deepEqual(first!.position, new Vec3(CX, FY, CZ - 2));
  // Center occupied by an existing chest: the left outer slot.
  const world = airWorld();
  world[`${CX},${FY},${CZ - 2}`] = "chest";
  const second = freeChestSlotSpot(stubBot(world), HOME);
  assert.deepEqual(second!.position, new Vec3(CX - 2, FY, CZ - 2));
  // Only the right slot free.
  world[`${CX - 2},${FY},${CZ - 2}`] = "chest";
  const third = freeChestSlotSpot(stubBot(world), HOME);
  assert.deepEqual(third!.position, new Vec3(CX + 2, FY, CZ - 2));
  // Everything occupied: null (callers fall back to scatter).
  world[`${CX + 2},${FY},${CZ - 2}`] = "chest";
  assert.equal(freeChestSlotSpot(stubBot(world), HOME), null);
});

test("stationSlotSpot returns a slot only when its cell is air with solid floor", () => {
  const table = stationSlotSpot(stubBot(airWorld()), HOME, "crafting_table");
  assert.deepEqual(table!.position, new Vec3(CX - 1, FY, CZ + 1));
  const furnace = stationSlotSpot(stubBot(airWorld()), HOME, "furnace");
  assert.deepEqual(furnace!.position, new Vec3(CX + 1, FY, CZ + 1));

  const world = airWorld();
  world[`${CX - 1},${FY},${CZ + 1}`] = "solid"; // occupied table slot
  assert.equal(stationSlotSpot(stubBot(world), HOME, "crafting_table"), null);
  assert.notEqual(stationSlotSpot(stubBot(world), HOME, "furnace"), null);

  const occupyingBot = stubBot(airWorld());
  (occupyingBot as unknown as Bot).entity = { position: new Vec3(CX - 1, FY, CZ + 1) } as never;
  assert.equal(stationSlotSpot(occupyingBot, HOME, "crafting_table"), null);
});

test("simple structure blueprints are bounded and deterministic", () => {
  const origin = { x: 0, y: 64, z: 0, dimension: "overworld" };
  const wall = simpleStructureCells({ shape: "wall", width: 5, height: 3, length: 1, material: "planks", anchor: "current", origin });
  assert.equal(wall.length, 15);
  assert.deepEqual(wall[0], new Vec3(0, 64, 0));
  assert.deepEqual(wall.at(-1), new Vec3(4, 66, 0));

  const pyramid = simpleStructureCells({ shape: "pyramid", width: 15, height: 8, length: 15, material: "planks", anchor: "owner", origin });
  assert.ok(pyramid.length > 0);
  assert.ok(pyramid.every((cell) => cell.y >= 64 && cell.y <= 71));
  assert.throws(
    () => simpleStructureCells({ shape: "pyramid", width: 15, height: 9, length: 15, material: "planks", anchor: "owner", origin }),
    /height 9 exceeds 8/,
  );
  assert.throws(
    () => simpleStructureCells({ shape: "room", width: 16, height: 3, length: 4, material: "planks", anchor: "home", origin }),
    /width\/length 1-15/,
  );
});

test("room blueprints reserve a two-block centered doorway", () => {
  const origin = { x: 0, y: 64, z: 0, dimension: "overworld" };
  const spec = { shape: "room" as const, width: 7, height: 4, length: 7, material: "planks" as const, anchor: "current" as const, origin };
  assert.deepEqual(simpleStructureDoorCells(spec), [new Vec3(3, 64, 6), new Vec3(3, 65, 6)]);
  const cells = simpleStructureCells(spec);
  assert.ok(!cells.some((cell) => cell.equals(new Vec3(3, 64, 6)) || cell.equals(new Vec3(3, 65, 6))));
  assert.equal(cells.length + simpleStructureDoorCells(spec).length, 145);
});

test("house decorations are bounded, colorful, and avoid the doorway", () => {
  const origin = { x: 0, y: 64, z: 0, dimension: "overworld" };
  const spec = { shape: "room" as const, width: 7, height: 4, length: 7, material: "planks" as const, anchor: "current" as const, origin };
  const decorations = simpleStructureDecorations(spec);
  assert.ok(decorations.some((item) => item.itemNames.includes("glass_pane")));
  assert.ok(decorations.some((item) => item.itemNames.includes("torch")));
  assert.ok(decorations.some((item) => item.itemNames.includes("red_bed")));
  assert.ok(decorations.some((item) => item.itemNames.includes("magenta_carpet")));
  assert.ok(!decorations.some((item) => item.position.equals(new Vec3(3, 64, 6))));
});

test("placement reach is checked from the bot eye to the reference face", () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) } } as unknown as Bot;
  const reference = { position: new Vec3(0, 64, 0) } as Block;
  assert.equal(isPlacementWithinReach(bot, reference, new Vec3(0, 1, 0)), true);
  const distant = { position: new Vec3(0, 64, 6) } as Block;
  assert.equal(isPlacementWithinReach(bot, distant, new Vec3(0, 1, 0)), false);
});

function designTestRunner(world: Record<string, string>): BaseBuilderRunner {
  const key = (v: Vec3): string => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: "overworld" },
    blockAt: (v: Vec3) => {
      const name = world[key(v)];
      return name === undefined ? null : { name, position: v, boundingBox: name === "air" ? "empty" : "block" } as Block;
    },
    inventory: { items: () => [{ name: "stone", count: 1 }] },
  } as unknown as Bot;
  const runner = Object.create(BaseBuilderRunner.prototype) as BaseBuilderRunner;
  const mutable = runner as unknown as { opts: { bot: Bot; config: { building?: object }; state: object }; travelToSimpleAnchor: () => Promise<{ status: "already_there" }> };
  mutable.opts = { bot, config: {}, state: {} };
  mutable.travelToSimpleAnchor = async () => ({ status: "already_there" });
  return runner;
}

test("design verification checks an exact range and reports corrupted cells", () => {
  const blueprint: Blueprint = {
    origin: { x: 0, y: 64, z: 0, dimension: "overworld" },
    operations: [
      { id: "op-0", x: 0, y: 0, z: 0, material: "stone", phase: "structural_shell", replaceExisting: false, structural: true },
      { id: "op-1", x: 1, y: 0, z: 0, material: "stone", phase: "structural_shell", replaceExisting: false, structural: true },
      { id: "op-2", x: 2, y: 0, z: 0, material: "stone", phase: "structural_shell", replaceExisting: false, structural: true },
    ],
    estimates: { blocks: 3, materials: { stone: 3 } },
    footprint: { width: 3, depth: 1, height: 1 },
  };
  const runner = designTestRunner({ "0,64,0": "stone", "1,64,0": "dirt", "2,64,0": "stone" });
  const result = runner.verifyDesignOperations(blueprint, 0, 2);
  assert.deepEqual(result, {
    operationStart: 0,
    operationEnd: 2,
    inspected: 2,
    verified: 1,
    mismatches: [{ operationId: "op-1", expected: "stone", actual: "dirt" }],
  });
});

test("design slices stop at their operation budget and resume from the checkpoint cursor", async () => {
  const blueprint: Blueprint = {
    origin: { x: 0, y: 64, z: 0, dimension: "overworld" },
    operations: [0, 1, 2].map((x) => ({ id: `op-${x}`, x, y: 0, z: 0, material: "stone", phase: "structural_shell" as const, replaceExisting: false, structural: true })),
    estimates: { blocks: 3, materials: { stone: 3 } },
    footprint: { width: 3, depth: 1, height: 1 },
  };
  const runner = designTestRunner({ "0,64,0": "stone", "1,64,0": "stone", "2,64,0": "stone" });
  const first = await runner.runDesignSlice(blueprint, { phaseId: "phase-1", operationStart: 0, operationEnd: 3, maxOperations: 2 });
  assert.equal(first.status, "partial");
  assert.equal(first.data?.currentOperationIndex, 2);
  assert.equal(first.data?.remaining, 1);
  const resumed = await runner.runDesignSlice(blueprint, {
    phaseId: "phase-1",
    operationStart: 0,
    operationEnd: 3,
    resumeState: {
      interruptions: 0,
      operationStart: 0,
      operationEnd: 3,
      currentOperationIndex: first.data!.currentOperationIndex,
      inspected: first.data!.inspected,
      verified: first.data!.verified,
      placed: first.data!.placed,
    },
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.data?.verified, 3);
  assert.equal(resumed.data?.remaining, 0);
});

test("an operation with no authoritative support is blocked, not reported as progress", async () => {
  const blueprint: Blueprint = {
    origin: { x: 0, y: 64, z: 0, dimension: "overworld" },
    operations: [{ id: "op-00450", x: 0, y: 0, z: 0, material: "stone", phase: "structural_shell", replaceExisting: false, structural: true }],
    estimates: { blocks: 1, materials: { stone: 1 } },
    footprint: { width: 1, depth: 1, height: 1 },
  };
  const runner = designTestRunner({ "0,64,0": "air" });
  (runner as unknown as { placeSimpleTarget: () => Promise<boolean> }).placeSimpleTarget = async () => false;
  const result = await runner.runDesignSlice(blueprint, { phaseId: "phase-unsupported", operationStart: 0, operationEnd: 1 });

  assert.equal(result.status, "blocked");
  assert.equal(result.errorCode, "UNSUPPORTED_OPERATION");
  assert.equal(result.retryable, false);
  assert.equal(result.data?.firstUnresolvedOperationId, "op-00450");
  assert.equal(result.data?.currentOperationIndex, 0, "the unresolved operation remains resumable");
  assert.equal(result.data?.verified, 0, "an unplaced block is never counted as verified");
});

test("a frozen op-00450 installs deferred door supports bottom-up without claiming them as verified", async () => {
  const world: Record<string, string> = { "0,61,0": "stone", "0,62,0": "air", "0,63,0": "air", "0,64,0": "air" };
  const blueprint: Blueprint = {
    origin: { x: 0, y: 62, z: 0, dimension: "overworld" },
    operations: [
      { id: "op-00450", x: 0, y: 2, z: 0, material: "stone", phase: "structural_shell", replaceExisting: false, structural: true },
      { id: "op-door-lower", x: 0, y: 0, z: 0, material: "oak_door", phase: "doors_windows", replaceExisting: true, structural: false },
      { id: "op-door-upper", x: 0, y: 1, z: 0, material: "oak_door", phase: "doors_windows", replaceExisting: true, structural: false },
    ],
    estimates: { blocks: 3, materials: { stone: 1, oak_door: 2 } },
    footprint: { width: 1, depth: 1, height: 3 },
    compilerVersion: "1.0.0",
  };
  const runner = designTestRunner(world);
  (runner as unknown as { placeSimpleTarget: (cell: Vec3) => Promise<boolean> }).placeSimpleTarget = async (cell) => {
    const below = `${cell.x},${cell.y - 1},${cell.z}`;
    if (world[below] === undefined || world[below] === "air") return false;
    world[`${cell.x},${cell.y},${cell.z}`] = "stone";
    return true;
  };
  const result = await runner.runDesignSlice(blueprint, { phaseId: "structural_shell-010", operationStart: 0, operationEnd: 1 });

  assert.equal(result.status, "completed");
  assert.equal(result.data?.verified, 1, "only op-00450 is verified");
  assert.equal(world["0,62,0"], "stone");
  assert.equal(world["0,63,0"], "stone");
  assert.equal(world["0,64,0"], "stone");
});

test("final verification observes only the last operation at a replaced coordinate", () => {
  const blueprint: Blueprint = {
    origin: { x: 0, y: 64, z: 0, dimension: "overworld" },
    operations: [
      { id: "wall", x: 0, y: 0, z: 0, material: "stone", phase: "structural_shell", replaceExisting: false, structural: true },
      { id: "door", x: 0, y: 0, z: 0, material: "oak_door", phase: "doors_windows", replaceExisting: true, structural: false },
    ],
    estimates: { blocks: 2, materials: { stone: 1, oak_door: 1 } },
    footprint: { width: 1, depth: 1, height: 1 },
  };
  const result = designTestRunner({ "0,64,0": "oak_door" }).verifyDesignOperations(blueprint);
  assert.deepEqual(result, { operationStart: 0, operationEnd: 2, inspected: 1, verified: 1, mismatches: [] });
});
