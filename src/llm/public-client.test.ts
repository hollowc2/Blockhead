import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { LlamaClient, LlmHttpError, type CompletionGuard, type LlmMessage } from "./client.js";
import { FirewallNotReadyError, PublicFirewall, REQUIRE_ENFORCEMENT_HEADER } from "./public-firewall.js";
import { createPublicModel } from "./public-model.js";

/**
 * The public client against a counting fake backend: what reaches inference,
 * on which URL, and when model ownership is released after abandoned work.
 */
const FIREWALL = "http://aegis.test", DIRECT = "http://llama.test";
const messages: LlmMessage[] = [{ role: "system", content: "facts" }, { role: "user", content: "question" }];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const reply = (content: string, enforced = true) => json({ choices: [{ message: { content } }] }, 200, enforced ? { "x-aegis-enforcement": "enforce" } : {});
const models = () => json({ data: [{ id: "m" }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
const hang = (signal: AbortSignal | null | undefined) => new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));

interface Call { url: string; init: RequestInit | undefined }
function publicClient(fetchImpl: (call: Call) => Response | Promise<Response>, guard: Partial<CompletionGuard> = {}, timeoutMs = 5000) {
  const calls: Call[] = [];
  const counts = { before: 0, settle: 0 };
  const client = new LlamaClient({
    baseUrl: FIREWALL, timeoutMs, maxRetries: 0, headers: { [REQUIRE_ENFORCEMENT_HEADER]: "enforce" }, maxResponseBytes: 2048,
    guard: {
      before: async signal => { counts.before++; await guard.before?.(signal); },
      verify: headers => { if (guard.verify) guard.verify(headers); else if (headers.get("x-aegis-enforcement") !== "enforce") throw new FirewallNotReadyError("unverified_reply"); },
      settle: async () => { counts.settle++; return guard.settle ? guard.settle() : true; },
    },
    fetchImpl: async (url, init) => { const call = { url: String(url), init }; calls.push(call); return fetchImpl(call); },
  });
  return { client, calls, counts, inference: () => calls.filter(c => c.url.endsWith("/chat/completions")).length };
}
function ownerClient(log: string[]) {
  return new LlamaClient({ baseUrl: DIRECT, timeoutMs: 5000, maxRetries: 0, fetchImpl: async url => {
    if (String(url).endsWith("/models")) return models();
    log.push("owner"); return json({ choices: [{ message: { content: "owner" } }] });
  } });
}

test("a firewall that is not ready gets no request at all; owner inference is unaffected", async () => {
  const firewall = new PublicFirewall({ baseUrl: FIREWALL, fetchImpl: async () => json({ schema: "aegis.readiness/1", service: "aegis-ml", revision: "r", instance: "i", ready: false, enforcement: "monitor", classifier_loaded: true, scan_roles: ["user"], require_enforcement_header: REQUIRE_ENFORCEMENT_HEADER, backend_redirects: false, cancel_on_disconnect: true, audit_prompt_text: false, backend_inflight: 0 }) });
  const pub = publicClient(() => reply("never"), { before: signal => firewall.ensureReady(signal) });
  await assert.rejects(pub.client.complete(messages, { priority: "public" }), (e: unknown) => e instanceof FirewallNotReadyError && e.reason === "monitor_mode");
  assert.equal(pub.calls.length, 0);
  const log: string[] = [];
  assert.equal(await ownerClient(log).complete(messages), "owner");
});

test("public requests carry the enforcement header, refuse redirects, never retry and never leave the firewall URL", async () => {
  let fail = false;
  const pub = publicClient(({ url }) => url.endsWith("/models") ? models() : fail ? json({}, 502) : reply("hi"));
  assert.equal(await pub.client.complete(messages, { priority: "public" }), "hi");
  fail = true;
  await assert.rejects(pub.client.complete(messages, { priority: "public" }), (e: unknown) => e instanceof LlmHttpError && e.status === 502);
  assert.equal(pub.inference(), 2, "one attempt per question: no retry after a failure");
  for (const call of pub.calls) {
    assert(call.url.startsWith(`${FIREWALL}/`), call.url);
    assert.equal(call.init!.redirect, "error");
    assert.equal((call.init!.headers as Record<string, string>)[REQUIRE_ENFORCEMENT_HEADER], "enforce");
  }
  const sent = JSON.parse(String(pub.calls.find(c => c.url.endsWith("/chat/completions"))!.init!.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["chat_template_kwargs", "max_tokens", "messages", "model", "stream", "temperature"], "no tools or tool_choice");
  assert.deepEqual((sent.messages as LlmMessage[]).map(m => m.role), ["system", "user"]);
});

test("a reply not marked as enforced is discarded", async () => {
  const pub = publicClient(({ url }) => url.endsWith("/models") ? models() : reply("unguarded answer", false));
  await assert.rejects(pub.client.complete(messages, { priority: "public" }), (e: unknown) => e instanceof FirewallNotReadyError && e.reason === "unverified_reply");
});

test("error replies contribute only a short fixed code, never their message text", async () => {
  const bodies = [
    { error: { code: "prompt_injection_detected", message: "PRIVATE_CANARY" } },
    { error: { code: "Not A Code PRIVATE_CANARY", message: "x" } },
    "PRIVATE_CANARY not json",
  ];
  for (const body of bodies) {
    const pub = publicClient(({ url }) => url.endsWith("/models") ? models() : new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 403 }));
    const error = await pub.client.complete(messages, { priority: "public" }).then(() => null, (e: unknown) => e);
    assert(error instanceof LlmHttpError);
    assert.equal(error.code, body === bodies[0] ? "prompt_injection_detected" : null);
    assert(!error.message.includes("PRIVATE_CANARY"));
  }
});

test("oversized or malformed replies fail without being read whole", async () => {
  const big = publicClient(({ url }) => url.endsWith("/models") ? models() : reply("x".repeat(4096)));
  await assert.rejects(big.client.complete(messages, { priority: "public" }), /too large/);
  const malformed = publicClient(({ url }) => url.endsWith("/models") ? models() : new Response("{not json", { headers: { "x-aegis-enforcement": "enforce" } }));
  await assert.rejects(malformed.client.complete(messages, { priority: "public" }));
});

test("abandoned public work keeps model ownership until the firewall settles", async () => {
  let started!: () => void, settled!: (ok: boolean) => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const settling = new Promise<boolean>(resolve => { settled = resolve; });
  const pub = publicClient(({ url, init }) => {
    if (url.endsWith("/models")) return models();
    started(); return hang(init!.signal);
  }, { settle: () => settling });
  const log: string[] = [];
  const visitor = new AbortController();
  const question = pub.client.complete(messages, { priority: "public", signal: visitor.signal });
  const refused = assert.rejects(question);
  await begun;
  const owner = ownerClient(log).complete(messages);
  visitor.abort();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(log, [], "owner inference waits while the abandoned request is settling");
  assert.equal(pub.counts.settle, 1);
  settled(true);
  await refused;
  assert.equal(await owner, "owner");
  assert.deepEqual(log, ["owner"]);
});

test("a request cut off by its own transport timeout is settled too", async () => {
  const pub = publicClient(({ url, init }) => url.endsWith("/models") ? models() : hang(init!.signal), {}, 30);
  await assert.rejects(pub.client.complete(messages, { priority: "public" }));
  assert.equal(pub.counts.settle, 1);
});

test("cancelled while queued: no readiness probe, no inference, nothing to settle", async () => {
  let release!: () => void;
  const holding = new LlamaClient({ baseUrl: DIRECT, timeoutMs: 5000, maxRetries: 0, fetchImpl: async url => {
    if (String(url).endsWith("/models")) return models();
    await new Promise<void>(resolve => { release = resolve; }); return json({ choices: [{ message: { content: "held" } }] });
  } });
  const held = holding.complete(messages); await tick(); await tick();
  const pub = publicClient(() => reply("never"));
  const visitor = new AbortController();
  const queued = assert.rejects(pub.client.complete(messages, { priority: "public", signal: visitor.signal }));
  visitor.abort(); await queued;
  release(); assert.equal(await held, "held");
  assert.deepEqual({ ...pub.counts, calls: pub.calls.length }, { before: 0, settle: 0, calls: 0 });
});

test("cancelled during the readiness check: no inference and nothing to settle", async () => {
  let checking!: () => void;
  const inCheck = new Promise<void>(resolve => { checking = resolve; });
  const pub = publicClient(() => reply("never"), { before: signal => { checking(); return hang(signal).then(() => undefined); } });
  const visitor = new AbortController();
  const question = assert.rejects(pub.client.complete(messages, { priority: "public", signal: visitor.signal }));
  await inCheck; visitor.abort(); await question;
  assert.deepEqual({ settle: pub.counts.settle, calls: pub.calls.length }, { settle: 0, calls: 0 });
});

test("work that never settles turns public answers off; the owner continues", async () => {
  let now = 0;
  const firewall = new PublicFirewall({ baseUrl: FIREWALL, now: () => now, sleep: async ms => { now += ms; }, limits: { settleTimeoutMs: 500 }, fetchImpl: async () => json({ schema: "aegis.readiness/1", service: "aegis-ml", revision: "r", instance: "i", ready: true, enforcement: "enforce", classifier_loaded: true, scan_roles: ["user"], require_enforcement_header: REQUIRE_ENFORCEMENT_HEADER, backend_redirects: false, cancel_on_disconnect: true, audit_prompt_text: false, backend_inflight: 1 }) });
  const pub = publicClient(({ url, init }) => url.endsWith("/models") ? models() : hang(init!.signal), { before: signal => firewall.ensureReady(signal), settle: () => firewall.settle() });
  const visitor = new AbortController();
  const first = pub.client.complete(messages, { priority: "public", signal: visitor.signal });
  const refused = assert.rejects(first);
  while (pub.inference() === 0) await tick();
  visitor.abort(); await refused;
  assert.equal(firewall.status().state, "unsettled");
  await assert.rejects(pub.client.complete(messages, { priority: "public" }), (e: unknown) => e instanceof FirewallNotReadyError && e.reason === "unsettled");
  assert.equal(pub.inference(), 1);
  assert.equal(await ownerClient([]).complete(messages), "owner");
});

test("repeated abandon cycles leave no queued work or abort listeners behind", async () => {
  const pub = publicClient(({ url, init }) => url.endsWith("/models") ? models() : hang(init!.signal));
  const signals: AbortSignal[] = [];
  for (let i = 0; i < 20; i++) {
    const visitor = new AbortController(); signals.push(visitor.signal);
    const question = assert.rejects(pub.client.complete(messages, { priority: "public", signal: visitor.signal }));
    while (pub.inference() <= i) await tick();
    visitor.abort(); await question;
  }
  assert.equal(pub.counts.settle, 20);
  assert.deepEqual(pub.client.queueState, { queued: 0, running: 0, publicQueued: 0, publicRunning: 0 });
  for (const signal of signals) assert.equal(getEventListeners(signal, "abort").length, 0);
  const live = new AbortController();
  assert.equal(await publicClient(({ url }) => url.endsWith("/models") ? models() : reply("fine")).client.complete(messages, { priority: "public", signal: live.signal }), "fine");
  assert.equal(getEventListeners(live.signal, "abort").length, 0);
});

test("the production wiring refuses llm.base_url aliases and answers only through an enforcing firewall", async () => {
  assert.equal(createPublicModel({ baseUrl: "http://localhost:8080/", directBaseUrl: "http://127.0.0.1:8080", timeoutMs: 1000 }), null);
  const urls: string[] = [];
  let enforcement = "enforce";
  const facts = { connected: true, health: 20, hunger: 20, time: "day" as const, activity: "idle" as const, actions: false };
  const model = createPublicModel({ baseUrl: "http://127.0.0.1:8000", directBaseUrl: "http://127.0.0.1:8080", timeoutMs: 1000, fetchImpl: async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith("/aegis/readiness")) return json({ schema: "aegis.readiness/1", service: "aegis-ml", revision: "r", instance: "i", ready: enforcement === "enforce", enforcement, classifier_loaded: true, scan_roles: ["user"], require_enforcement_header: REQUIRE_ENFORCEMENT_HEADER, backend_redirects: false, cancel_on_disconnect: true, audit_prompt_text: false, backend_inflight: 0 });
    if (String(url).endsWith("/models")) return models();
    assert.equal((init!.headers as Record<string, string>)[REQUIRE_ENFORCEMENT_HEADER], "enforce");
    return enforcement === "enforce" ? reply("Mining!") : json({ error: { code: "enforcement_unavailable" } }, 503);
  } })!;
  const ask = () => model.answer("what's up", facts, new AbortController().signal, Date.now() + 5000);
  assert.deepEqual(await ask(), { kind: "answer", text: "Mining!" });
  enforcement = "monitor";
  assert.deepEqual(await ask(), { kind: "unavailable", reason: "not_ready" }, "Aegis refuses inside the cached-ready window");
  assert.equal(model.firewall.status().state, "not_ready");
  const before = urls.length;
  assert.deepEqual(await ask(), { kind: "unavailable", reason: "not_ready" });
  assert.deepEqual(urls.slice(before).map(u => new URL(u).pathname), ["/aegis/readiness"], "the next question re-probes and sends nothing else");
  assert(urls.every(u => u.startsWith("http://127.0.0.1:8000/")));
});
