import assert from "node:assert/strict";
import { test } from "node:test";
import { FirewallNotReadyError, PublicFirewall, READINESS_PATH, readBounded, sameEndpoint, type FirewallReason } from "./public-firewall.js";

function readiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "aegis.readiness/1", service: "aegis-ml", version: "1.0.0", revision: "a".repeat(40), instance: "i1",
    ready: true, reasons: [], enforcement: "enforce", classifier: "cascade2", classifier_loaded: true, scan_roles: ["user"],
    input_guard_timeout_ms: 5000, require_enforcement_header: "x-aegis-require-enforcement", backend_redirects: false,
    cancel_on_disconnect: true, audit_prompt_text: false, audit_retention_days: 7, backend_inflight: 0, ...overrides,
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function firewall(reply: () => Response | Promise<Response>, extra: { now?: () => number; limits?: Record<string, number> } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fw = new PublicFirewall({ baseUrl: "http://aegis.test/", fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return reply(); }, sleep: async () => {}, ...extra });
  return { fw, calls };
}
async function reason(fw: PublicFirewall): Promise<FirewallReason | "ready"> {
  try { await fw.ensureReady(); return "ready"; } catch (error) { assert(error instanceof FirewallNotReadyError); return error.reason; }
}

test("an enforcing, compatible Aegis is ready; the probe refuses redirects and the result is cached", async () => {
  let now = 0;
  const { fw, calls } = firewall(() => json(readiness()), { now: () => now });
  assert.equal(await reason(fw), "ready");
  assert.equal(calls[0]!.url, `http://aegis.test${READINESS_PATH}`);
  assert.equal(calls[0]!.init!.redirect, "error");
  now = 29_000; assert.equal(await reason(fw), "ready"); assert.equal(calls.length, 1);
  now = 31_000; assert.equal(await reason(fw), "ready"); assert.equal(calls.length, 2, "stale readiness is probed again");
  assert.deepEqual({ state: fw.status().state, revision: fw.status().revision }, { state: "ready", revision: "a".repeat(40) });
});

test("monitor mode, missing classifier, unscanned user role, retained prompts, redirects or no cancellation are not ready", async () => {
  const cases: [Record<string, unknown>, FirewallReason][] = [
    [{ enforcement: "monitor", ready: false, reasons: ["monitor_mode"] }, "monitor_mode"],
    [{ classifier_loaded: false, ready: false }, "classifier_not_loaded"],
    [{ scan_roles: ["system"] }, "user_not_scanned"],
    [{ audit_prompt_text: true }, "prompt_text_retained"],
    [{ backend_redirects: true }, "redirects"],
    [{ cancel_on_disconnect: false }, "no_cancellation"],
    [{ ready: false, reasons: ["something_new"] }, "not_ready"],
    [{ schema: "aegis.readiness/2" }, "incompatible"],
    [{ service: "llama.cpp" }, "incompatible"],
    [{ require_enforcement_header: "x-other" }, "incompatible"],
    [{ backend_inflight: "0" }, "incompatible"],
  ];
  for (const [overrides, expected] of cases) assert.equal(await reason(firewall(() => json(readiness(overrides))).fw), expected, JSON.stringify(overrides));
});

test("direct llama.cpp, generic 200s, errors, oversized bodies and unreachable hosts are never ready", async () => {
  const replies: [() => Response | Promise<Response>, FirewallReason][] = [
    [() => json({ error: { code: 404, message: "File Not Found" } }, 404), "http_status"],
    [() => new Response("<!doctype html><title>llama.cpp</title>", { headers: { "content-type": "text/html" } }), "unreachable"],
    [() => json({ status: "ok" }), "incompatible"],
    [() => json({ status: "ok", classifier: "cascade2", classifier_loaded: true }), "incompatible"],
    [() => json(readiness(), 302, { location: "http://elsewhere/" }), "http_status"],
    [() => json({ ...readiness(), pad: "x".repeat(10_000) }), "unreachable"],
    [() => { throw new TypeError("fetch failed"); }, "unreachable"],
  ];
  for (const [reply, expected] of replies) assert.equal(await reason(firewall(reply).fw), expected);
});

test("losing readiness mid-session takes effect at the next probe and replies must be marked enforced", async () => {
  let report = readiness(), now = 0;
  const { fw } = firewall(() => json(report), { now: () => now });
  assert.equal(await reason(fw), "ready");
  report = readiness({ enforcement: "monitor", ready: false });
  fw.observe(Object.assign(new Error("llama.cpp returned HTTP 503"), { status: 503, code: "enforcement_unavailable" }));
  assert.equal(await reason(fw), "monitor_mode", "an enforcement refusal forces an immediate re-probe");
  report = readiness(); assert.equal(await reason(fw), "ready");
  assert.throws(() => fw.verifyReply(new Headers()), FirewallNotReadyError);
  assert.equal(fw.status().reason, "unverified_reply");
  assert.throws(() => fw.verifyReply(new Headers({ "x-aegis-enforcement": "monitor" })), FirewallNotReadyError);
  assert.doesNotThrow(() => fw.verifyReply(new Headers({ "x-aegis-enforcement": "enforce" })));
  now = 1; fw.observe(new TypeError("fetch failed")); assert.equal(fw.status().state, "not_ready");
});

test("settle waits for Aegis to report no open backend work, within its bound", async () => {
  const inflight = [2, 1, 0];
  const { fw, calls } = firewall(() => json(readiness({ backend_inflight: inflight.shift() ?? 0 })));
  assert.equal(await fw.settle(), true);
  assert.equal(calls.length, 3);
  assert.equal(fw.status().settleFailures, 0);
});

test("unsettled work keeps public model answers off until a later probe shows none open", async () => {
  let now = 0, open = 1;
  const fw = new PublicFirewall({ baseUrl: "http://aegis.test", fetchImpl: async () => json(readiness({ backend_inflight: open })), now: () => now, sleep: async ms => { now += ms; }, limits: { settleTimeoutMs: 1000 } });
  assert.equal(await fw.settle(), false);
  assert.equal(fw.status().state, "unsettled");
  assert.equal(await reason(fw), "unsettled");
  fw.invalidate("unreachable"); assert.equal(fw.status().state, "unsettled", "only zero open work clears it");
  open = 0; now += 60_000;
  assert.equal(await reason(fw), "ready", "zero open backend requests clears the unsettled state");
  assert.equal(fw.status().settleFailures, 1);
});

test("concurrent readiness checks share one probe", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { fw, calls } = firewall(async () => { await gate; return json(readiness()); });
  const both = Promise.all([fw.ensureReady(), fw.ensureReady()]);
  release(); await both;
  assert.equal(calls.length, 1);
});

test("an aborted readiness check rejects with the caller's reason", async () => {
  const { fw } = firewall(() => new Promise<Response>(() => {}));
  const controller = new AbortController();
  const pending = assert.rejects(fw.ensureReady(controller.signal));
  controller.abort(new Error("visitor left")); await pending;
});

test("loopback aliases and default ports of llm.base_url are the same endpoint", () => {
  for (const alias of ["http://127.0.0.1:8080", "http://localhost:8080/", "http://[::1]:8080", "http://0.0.0.0:8080", "http://127.0.0.2:8080/v1", "http://LOCALHOST:8080"]) {
    assert.equal(sameEndpoint(alias, "http://127.0.0.1:8080"), true, alias);
  }
  assert.equal(sameEndpoint("http://127.0.0.1:80", "http://localhost"), true);
  assert.equal(sameEndpoint("not a url", "http://127.0.0.1:8080"), true, "unparseable URLs fail closed");
  assert.equal(sameEndpoint("http://127.0.0.1:8000", "http://127.0.0.1:8080"), false);
});

test("bounded body reads refuse oversized replies by header and by stream", async () => {
  await assert.rejects(readBounded(new Response("x".repeat(100), { headers: { "content-length": "100" } }), 10), /too large/);
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(8)); c.close(); } });
  await assert.rejects(readBounded(new Response(stream), 16), /too large/);
  assert.equal(await readBounded(new Response("ok"), 16), "ok");
});
