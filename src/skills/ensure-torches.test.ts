import assert from "node:assert/strict";
import { test } from "node:test";
import { torchCraftBatches } from "./ensure-torches.js";

test("torch crafts split by fuel type: the recipe never mixes coal and charcoal", () => {
  // 21:27: 11 crafts with 8 coal + 3 charcoal failed as one batch.
  assert.deepEqual(torchCraftBatches(11, 8, 3, 12), [8, 3]);
  assert.deepEqual(torchCraftBatches(11, 20, 3, 12), [11]);
  assert.deepEqual(torchCraftBatches(11, 0, 14, 12), [11]);
  assert.deepEqual(torchCraftBatches(11, 8, 3, 5), [5], "sticks cap the total");
  assert.deepEqual(torchCraftBatches(4, 0, 0, 5), []);
});

test("a torch run short of fuel explains the missing coal instead of the bare search error", async () => {
  const { EnsureTorchesRunner } = await import("./ensure-torches.js");
  const runner = new EnsureTorchesRunner({
    bot: { entity: null, inventory: { items: () => [] } }, config: {}, logger: { info() {}, warn() {} },
  } as unknown as ConstructorParameters<typeof EnsureTorchesRunner>[0]);
  const internal = runner as unknown as {
    failShort: (data: object, crafts: number, gap: { item: string; count: number; via: string }, code: string, reason: string) => { message?: string; data?: { blocker?: unknown } };
  };
  const result = internal.failShort({ quantity: 32 }, 8, { item: "coal", count: 8, via: "fuel" }, "RESOURCE_NOT_FOUND", "only 0/8 coal found nearby");
  assert.equal(result.message, "only 0/8 coal found nearby");
  assert.deepEqual(result.data?.blocker, { need: { item: "torch", count: 32 }, missing: [{ item: "coal", count: 8, via: "fuel" }], canFix: true, reason: "only 0/8 coal found nearby" });
});
