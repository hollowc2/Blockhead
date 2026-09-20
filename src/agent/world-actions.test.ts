import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldActionExecutor, abortError, registerWorldActionTeardown, requireWorldActionLease, stopWorldPrimitives } from "./world-actions.js";

test("abortError does not mutate errors with a read-only name", () => {
  const reason = Object.freeze(new DOMException("cancelled", "OperationError"));
  const error = abortError(reason);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "cancelled");
  assert.equal(error.cause, reason);
  assert.equal(reason.name, "OperationError");
});

test("window primitives require a scheduler lease context", () => {
  assert.throws(() => requireWorldActionLease(), /active scheduler lease/);
});

test("lease context is visible across awaited primitive work", async () => {
  const executor = new WorldActionExecutor();
  await executor.run("storage", new AbortController().signal, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requireWorldActionLease().owner, "storage");
  });
  assert.equal(executor.activeOwner, null);
});

test("teardown calls are serialized and invalidate registered stale state", async () => {
  const events: string[] = [];
  const releases: Array<() => void> = [];
  const bot = {
    collectBlock: { cancelTask: () => new Promise<void>((resolve) => { events.push("collect-start"); releases.push(() => { events.push("collect-end"); resolve(); }); }) },
  };
  let invalidated = false;
  registerWorldActionTeardown(bot, () => { invalidated = true; });
  const first = stopWorldPrimitives(bot);
  const second = stopWorldPrimitives(bot);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invalidated, true);
  assert.deepEqual(events, ["collect-start"]);
  releases.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases.shift()!();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["collect-start", "collect-end", "collect-start", "collect-end"]);
});

test("world actions serialize and a cancelled waiter never acquires the lease", async () => {
  const executor = new WorldActionExecutor();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const order: string[] = [];
  const first = executor.run("first", firstController.signal, async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first-end");
  });
  const second = executor.run("second", secondController.signal, async () => {
    order.push("second-start");
  });
  const secondRejected = assert.rejects(second, /cancelled/);
  secondController.abort(new Error("cancelled"));
  await first;
  await secondRejected;
  assert.deepEqual(order, ["first-start", "first-end"]);
  assert.equal(executor.activeOwner, null);
});

test("duplicate owner identities are rejected while active and pending", async () => {
  const executor = new WorldActionExecutor();
  const firstController = new AbortController();
  const first = executor.run("same-owner", firstController.signal, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await assert.rejects(
    executor.run("same-owner", new AbortController().signal, async () => undefined),
    /already active or pending/,
  );
  firstController.abort(new Error("done"));
  await assert.rejects(first, /done/);
  assert.equal(executor.activeOwner, null);
});

test("empty owner identities are rejected before mutation", async () => {
  const executor = new WorldActionExecutor();
  let mutated = false;
  await assert.rejects(
    executor.run("   ", new AbortController().signal, async () => { mutated = true; }),
    /owner must be non-empty/,
  );
  assert.equal(mutated, false);
});

test("a failed world action releases ownership and cleanup stops every primitive", async () => {
  const executor = new WorldActionExecutor();
  await assert.rejects(executor.run("broken", new AbortController().signal, async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(executor.activeOwner, null);

  const calls: string[] = [];
  await stopWorldPrimitives({
    pathfinder: { stop: () => calls.push("path-stop"), setGoal: () => calls.push("goal-clear") },
    collectBlock: { cancelTask: () => { calls.push("collect-cancel"); } },
    pvp: { stop: () => { calls.push("pvp-stop"); } },
    currentWindow: { close: () => calls.push("window-close") },
  });
  assert.deepEqual(calls, ["path-stop", "goal-clear", "collect-cancel", "pvp-stop", "window-close"]);
});

test("cleanup completes before a replacement can observe the old task owner", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  let cleanupFinished = false;
  const bot = {
    collectBlock: {
      cancelTask: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        cleanupFinished = true;
      },
    },
  } as any;
  const first = executor.run("requeued-task", controller.signal, async (lease) => {
    await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
  }, { onCancel: () => stopWorldPrimitives(bot) });
  const replacement = executor.run("replacement-task", new AbortController().signal, async () => {
    assert.equal(cleanupFinished, true);
  });
  controller.abort(new Error("requeue"));
  await assert.rejects(first, /requeue|aborted/i);
  await replacement;
  assert.equal(executor.activeOwner, null);
});

test("lease cancellation aborts the primitive and acknowledges before ownership is released", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  let observedAbort = false;
  let acknowledged = false;
  const run = executor.run("timed", controller.signal, async (lease) => {
    await new Promise<void>((resolve) => {
      lease.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "done";
  }, { timeoutMs: 5 });
  await assert.rejects(run, /timed out|aborted/);
  acknowledged = observedAbort && executor.activeOwner === null;
  assert.equal(acknowledged, true);
});

test("an already-aborted lease never invokes its action", async () => {
  const executor = new WorldActionExecutor();
  const controller = new AbortController();
  controller.abort(new Error("already disconnected"));
  let mutated = false;
  await assert.rejects(executor.run("already-aborted", controller.signal, async () => { mutated = true; }), /already disconnected|aborted/i);
  assert.equal(mutated, false);
  assert.equal(executor.activeOwner, null);
  assert.equal(executor.pendingCount, 0);
});

test("a timed-out lease settles before its queued replacement starts", async () => {
  const executor = new WorldActionExecutor();
  let replacementStarted = false;
  const first = executor.run("timed-out", new AbortController().signal, async (lease) => {
    await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
  }, { timeoutMs: 5 });
  const replacement = executor.run("after-timeout", new AbortController().signal, async () => {
    replacementStarted = true;
  });
  await assert.rejects(first, /timed out|aborted/i);
  await replacement;
  assert.equal(replacementStarted, true);
  assert.equal(executor.activeOwner, null);
  assert.equal(executor.pendingCount, 0);
});

test("external cancellation cannot let a replacement action overlap the old primitive", async () => {
  const executor = new WorldActionExecutor();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let firstSettled = false;
  const first = executor.run("first", firstController.signal, async (lease) => {
    await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstSettled = true;
  });
  const second = executor.run("second", secondController.signal, async () => {
    assert.equal(firstSettled, true);
  });
  // Let the first primitive install its cancellation handler before replacing
  // it; cancellation before a primitive starts is covered by the lease guard.
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstController.abort(new Error("replace"));
  await assert.rejects(first, /replace/);
  await second;
  assert.equal(executor.activeOwner, null);
});

test("disconnect cleanup is awaited before a replacement becomes idle-owned", async () => {
  const executor = new WorldActionExecutor();
  const firstController = new AbortController();
  let releaseCleanup!: () => void;
  let cleanupStarted = false;
  let replacementStarted = false;
  const bot = {
    collectBlock: {
      cancelTask: () => new Promise<void>((resolve) => {
        cleanupStarted = true;
        releaseCleanup = resolve;
      }),
    },
  } as any;
  const first = executor.run("disconnecting", firstController.signal, async (lease) => {
    await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
  }, { onCancel: () => stopWorldPrimitives(bot) });
  const replacement = executor.run("replacement", new AbortController().signal, async () => {
    replacementStarted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstController.abort(new Error("disconnect"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupStarted, true);
  assert.equal(replacementStarted, false);
  releaseCleanup();
  await assert.rejects(first, /disconnect/);
  await replacement;
  assert.equal(replacementStarted, true);
  assert.equal(executor.activeOwner, null);
  assert.equal(executor.pendingCount, 0);
});

test("recovery runs after a rejected primitive and diagnostics identify the owner", async () => {
  const executor = new WorldActionExecutor();
  const recovered: unknown[] = [];
  await assert.rejects(executor.run("broken", new AbortController().signal, async () => {
    assert.equal(executor.diagnostics.owner, "broken");
    throw new Error("plugin rejected");
  }, { onRecovery: (reason) => { recovered.push(reason); } }), /plugin rejected/);
  assert.equal(recovered.length, 1);
  assert.equal(executor.diagnostics.owner, null);
  assert.equal(executor.diagnostics.pending, 0);
});

test("recovery completes before a queued replacement receives ownership", async () => {
  const executor = new WorldActionExecutor();
  let cleaned = false;
  const first = executor.run("stale", new AbortController().signal, async () => {
    throw new Error("plugin rejected");
  }, {
    onRecovery: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleaned = true;
    },
  });
  const second = executor.run("replacement", new AbortController().signal, async () => {
    assert.equal(cleaned, true);
  });
  await assert.rejects(first, /plugin rejected/);
  await second;
});

test("a lease policy rejection happens before the mutation callback", async () => {
  const executor = new WorldActionExecutor();
  let mutated = false;
  await assert.rejects(executor.run("policy-rejected", new AbortController().signal, async (lease) => {
    lease.beforeMutation?.({ action: "container", point: { x: 0, y: 64, z: 0 } });
    mutated = true;
  }, {
    beforeMutation: () => { throw new Error("explicit policy rejection"); },
  }), /explicit policy rejection/);
  assert.equal(mutated, false);
  assert.equal(executor.activeOwner, null);
});
