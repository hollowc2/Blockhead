import assert from "node:assert/strict";
import test from "node:test";
import { ModelQueue } from "./request-queue.js";

test("owner priority has an explicit three-private fairness bound for waiting public work", async () => {
  const queue = new ModelQueue(), calls: string[] = [];
  let release!: () => void;
  const first = queue.add(async () => { calls.push("first"); await new Promise<void>(resolve => { release = resolve; }); return "first"; }, new AbortController().signal, false);
  await new Promise(resolve => setImmediate(resolve));
  const run = (name: string, isPublic = false) => queue.add(async () => { calls.push(name); return name; }, new AbortController().signal, isPublic);
  const publicJob = run("public", true);
  const owners = [run("private0"), run("private1"), run("private2")];
  release(); await Promise.all([first, publicJob, ...owners]);
  assert.deepEqual(calls, ["first", "private0", "private1", "public", "private2"]);
});

test("queue limits are global and cancelled successors cannot release a running predecessor", async () => {
  const queue = new ModelQueue(); let finish!: () => void;
  const active = queue.add(() => new Promise(resolve => { finish = () => resolve("done"); }), new AbortController().signal, false);
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const publicJob = queue.add(async () => "never public", controller.signal, true);
  const publicResult = assert.rejects(publicJob);
  await assert.rejects(queue.add(async () => "second public", new AbortController().signal, true), /full/);
  const privateControllers = Array.from({ length: 63 }, () => new AbortController());
  const results = privateControllers.map(c => assert.rejects(queue.add(async () => "never private", c.signal, false)));
  assert.equal(queue.stats().queued, 64);
  await assert.rejects(queue.add(async () => "overflow", new AbortController().signal, false), /full/);
  controller.abort(); privateControllers.forEach(c => c.abort()); await Promise.all([publicResult, ...results]);
  assert.equal(queue.stats().queued, 0); assert.equal(queue.stats().running, 1);
  finish(); assert.equal(await active, "done");
});
