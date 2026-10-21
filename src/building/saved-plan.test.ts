import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadSavedBuildPlan } from "./saved-plan.js";
import { compileBuildingDesign } from "./compiler.js";

const home = { x: 65, y: 100, z: 51, dimension: "overworld" };
async function fixture(name: string) {
  const plan = JSON.parse(await readFile(`config/build-plans/${name}.json`, "utf8"));
  const cells = new Map<string, string>(plan.preconditions.map((p: { x: number; y: number; z: number; names: string[] }) =>
    [`${home.x + p.x},${home.y + p.y},${home.z + p.z}`, p.names[0]!]));
  return { plan, cells, blockAt: (p: { x: number; y: number; z: number }) => ({ name: cells.get(`${p.x},${p.y},${p.z}`) ?? "air" }) };
}

test("saved house plans retain supports and compile into connected, bottom-up placements", async () => {
  for (const name of ["house-roof-access", "house-upstairs"]) {
    const f = await fixture(name);
    const args = await loadSavedBuildPlan(name, home, f.blockAt);
    const bp = compileBuildingDesign(args.design, home);
    for (const op of bp.operations) {
      const p = op.absolute!;
      // Existing masonry in the surveyed house is preserved by the upstairs plan.
      if (op.material === "cobblestone") f.cells.set(`${p.x},${p.y},${p.z}`, "cobblestone");
    }
    for (const op of bp.operations) {
      const p = op.absolute!, key = `${p.x},${p.y},${p.z}`;
      if (f.cells.get(key) === op.material) continue;
      const supported = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([dx,dy,dz]) => f.cells.has(`${p.x+dx!},${p.y+dy!},${p.z+dz!}`));
      assert.ok(supported, `${name}: unsupported ${key}`);
      f.cells.set(key, op.material);
    }
    if (name === "house-roof-access") {
      assert.equal(bp.operations.length, 15);
      for (let i = 0; i < 5; i++) {
        assert.equal(f.cells.get(`67,${101+i},${59-i}`), "oak_planks");
        assert.equal(f.cells.has(`67,${102+i},${59-i}`), false, "step has headroom");
      }
    } else {
      assert.equal(bp.operations.filter(op => op.material === "cobblestone").length, 2);
      assert.equal(f.cells.get("67,106,54"), "oak_door", "entry meets top stair at 67,105,55");
      assert.equal(f.cells.has("67,108,54"), true, "doorway has lintel");
      assert.equal(f.cells.has("65,106,51"), false, "new interior remains open");
    }
  }
});

test("saved plans reject traversal, a changed home, unloaded blocks, and changed roof supports", async () => {
  const f = await fixture("house-upstairs");
  await assert.rejects(loadSavedBuildPlan("../minecraft", home, f.blockAt), /saved plan name/);
  await assert.rejects(loadSavedBuildPlan("house-upstairs", { ...home, y: 97 }, f.blockAt), /home no longer matches/);
  await assert.rejects(loadSavedBuildPlan("house-upstairs", null, f.blockAt), /home no longer matches/);
  await assert.rejects(loadSavedBuildPlan("house-upstairs", home, () => null), /unloaded/);
  await assert.rejects(loadSavedBuildPlan("house-upstairs", home, () => ({ name: "chest" })), /survey changed/);
});
