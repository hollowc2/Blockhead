import { z } from "zod";

/**
 * Trust gate for public model answers. A public question may reach inference
 * only through an Aegis that reports, on its versioned readiness endpoint,
 * that input blocking is enforced, the classifier is loaded, the user message
 * is scanned, prompt text is not retained, redirects are refused and caller
 * disconnects cancel backend work. A generic 200 (llama.cpp's own /health or
 * /v1/models) or a differing URL string proves none of that.
 *
 * Each public request also carries REQUIRE_ENFORCEMENT_HEADER, so an Aegis
 * that drops to monitor mode or loses its classifier between probes refuses
 * the request (503) before classifying or forwarding it. Replies must carry
 * ENFORCEMENT_HEADER=enforce or they are discarded.
 *
 * After public work is abandoned mid-request, settle() keeps the caller's
 * model ownership until Aegis reports no open backend request. If that cannot
 * be shown within settleTimeoutMs, public model answers stay off ("unsettled")
 * until a later probe sees zero open backend requests.
 */
export const READINESS_PATH = "/aegis/readiness";
export const READINESS_SCHEMA = "aegis.readiness/1";
export const REQUIRE_ENFORCEMENT_HEADER = "x-aegis-require-enforcement";
export const ENFORCEMENT_HEADER = "x-aegis-enforcement";
/** Aegis 403 codes that are verified guard verdicts; anything else is not a verified block. */
export const FIREWALL_BLOCK_CODES = new Set(["prompt_injection_detected", "canary_leak", "harmful_content"]);

export const FIREWALL_LIMITS = { probeTimeoutMs: 2000, readyTtlMs: 30_000, settleTimeoutMs: 15_000, settlePollMs: 250, probeBytes: 8192 };
type FirewallLimits = typeof FIREWALL_LIMITS;

const ReadinessSchema = z.object({
  schema: z.literal(READINESS_SCHEMA),
  service: z.literal("aegis-ml"),
  revision: z.string().max(64),
  instance: z.string().max(64),
  ready: z.boolean(),
  enforcement: z.enum(["enforce", "monitor"]),
  classifier_loaded: z.boolean(),
  scan_roles: z.array(z.string().max(16)).max(8),
  require_enforcement_header: z.string().max(64),
  backend_redirects: z.boolean(),
  cancel_on_disconnect: z.boolean(),
  audit_prompt_text: z.boolean(),
  backend_inflight: z.number().int().min(0),
});

/** Fixed reason codes; never upstream text. */
export type FirewallReason =
  | "unknown" | "unreachable" | "http_status" | "incompatible" | "monitor_mode" | "classifier_not_loaded"
  | "user_not_scanned" | "prompt_text_retained" | "redirects" | "no_cancellation" | "not_ready"
  | "unsettled" | "enforcement_lost" | "unverified_reply";
export type FirewallState = "unknown" | "ready" | "not_ready" | "unsettled";

export class FirewallNotReadyError extends Error {
  constructor(readonly reason: FirewallReason) { super(`public firewall not ready: ${reason}`); this.name = "FirewallNotReadyError"; }
}

export interface PublicFirewallOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<FirewallLimits>;
}

type Probe = { ok: true; inflight: number; revision: string; instance: string } | { ok: false; reason: FirewallReason; inflight?: number };

export class PublicFirewall {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limits: FirewallLimits;
  private state: FirewallState = "unknown";
  private reason: FirewallReason = "unknown";
  private checkedAt: number | null = null;
  private identity: { revision: string; instance: string } | null = null;
  private pending: Promise<Probe> | null = null;
  private readonly counts = { probes: 0, probeFailures: 0, settles: 0, settleFailures: 0, maxSettleMs: 0 };

  constructor(options: PublicFirewallOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.limits = { ...FIREWALL_LIMITS, ...options.limits };
  }

  /** Private diagnostics: fixed codes, counts and the firewall's revision; no URLs or text. */
  status(): { state: FirewallState; reason: FirewallReason | null; checkedAt: number | null; revision: string | null; instance: string | null } & PublicFirewall["counts"] {
    return { state: this.state, reason: this.state === "ready" ? null : this.reason, checkedAt: this.checkedAt, revision: this.identity?.revision ?? null, instance: this.identity?.instance ?? null, ...this.counts };
  }

  /** Resolves when public inference may start now; throws FirewallNotReadyError otherwise. */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.state === "ready" && this.checkedAt !== null && this.now() - this.checkedAt < this.limits.readyTtlMs) return;
    const probe = await this.probe(signal);
    signal?.throwIfAborted();
    if (!probe.ok) throw new FirewallNotReadyError(probe.reason);
    if (this.state !== "ready") throw new FirewallNotReadyError(this.reason);
  }

  /** Forget a cached "ready": the next public request probes again. */
  invalidate(reason: FirewallReason): void {
    if (this.state === "unsettled") return;
    this.state = "not_ready"; this.reason = reason;
  }

  /** A failed public request: lost enforcement or an unreachable firewall forces a fresh probe. */
  observe(error: unknown): void {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
    if (code === "enforcement_unavailable") this.invalidate("enforcement_lost");
    else if (error instanceof TypeError) this.invalidate("unreachable");
  }

  /** Accept a reply only if Aegis says its input passed an enforcing guard. */
  verifyReply(headers: Headers): void {
    if (headers.get(ENFORCEMENT_HEADER) === "enforce") return;
    this.invalidate("unverified_reply");
    throw new FirewallNotReadyError("unverified_reply");
  }

  /**
   * Called while still owning the model, after a public request was abandoned
   * mid-flight. Waits (bounded) until Aegis reports no open backend request.
   */
  async settle(): Promise<boolean> {
    const started = this.now();
    this.counts.settles++;
    for (;;) {
      const probe = await this.probe();
      if (probe.ok && probe.inflight === 0 || !probe.ok && probe.inflight === 0) {
        this.counts.maxSettleMs = Math.max(this.counts.maxSettleMs, this.now() - started);
        return true;
      }
      if (this.now() - started >= this.limits.settleTimeoutMs) break;
      await this.sleep(this.limits.settlePollMs);
    }
    this.counts.settleFailures++;
    this.state = "unsettled"; this.reason = "unsettled"; this.checkedAt = this.now();
    return false;
  }

  private probe(signal?: AbortSignal): Promise<Probe> {
    // One probe at a time; concurrent callers share its result.
    this.pending ??= this.probeOnce(signal).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async probeOnce(parent?: AbortSignal): Promise<Probe> {
    this.counts.probes++;
    const result = await this.read(parent);
    this.checkedAt = this.now();
    if (!result.ok) {
      this.counts.probeFailures++;
      // An unsettled firewall stays unsettled until it shows zero open work.
      if (this.state !== "unsettled" || result.inflight === 0) { this.state = "not_ready"; this.reason = result.reason; }
      return result;
    }
    this.state = "ready"; this.reason = "unknown";
    return result;
  }

  private async read(parent?: AbortSignal): Promise<Probe> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.probeTimeoutMs);
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
    let raw: unknown;
    let onAbort!: () => void;
    // Bounded even if the transport ignores its signal.
    const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
    aborted.catch(() => undefined);
    if (signal.aborted) onAbort();
    try {
      const status = await Promise.race([aborted, (async () => {
        const res = await this.fetchImpl(`${this.baseUrl}${READINESS_PATH}`, { method: "GET", redirect: "error", signal, headers: { accept: "application/json" } });
        if (!res.ok) { await res.body?.cancel().catch(() => undefined); return res.status; }
        raw = JSON.parse(await readBounded(res, this.limits.probeBytes));
        return res.status;
      })()]);
      if (status < 200 || status > 299) return { ok: false, reason: "http_status" };
    } catch {
      return { ok: false, reason: "unreachable" };
    } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
    const parsed = ReadinessSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "incompatible" };
    const r = parsed.data;
    const inflight = r.backend_inflight;
    if (r.require_enforcement_header !== REQUIRE_ENFORCEMENT_HEADER) return { ok: false, reason: "incompatible", inflight };
    if (r.enforcement !== "enforce") return { ok: false, reason: "monitor_mode", inflight };
    if (!r.classifier_loaded) return { ok: false, reason: "classifier_not_loaded", inflight };
    if (!r.scan_roles.includes("user")) return { ok: false, reason: "user_not_scanned", inflight };
    if (r.audit_prompt_text) return { ok: false, reason: "prompt_text_retained", inflight };
    if (r.backend_redirects) return { ok: false, reason: "redirects", inflight };
    if (!r.cancel_on_disconnect) return { ok: false, reason: "no_cancellation", inflight };
    if (!r.ready) return { ok: false, reason: "not_ready", inflight };
    if (this.state === "unsettled" && inflight > 0) return { ok: false, reason: "unsettled", inflight };
    this.identity = { revision: r.revision, instance: r.instance };
    return { ok: true, inflight, revision: r.revision, instance: r.instance };
  }
}

/** Read at most *limit* bytes of a response body as UTF-8; larger bodies are an error. */
export async function readBounded(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) { await res.body?.cancel().catch(() => undefined); throw new Error("response too large"); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel().catch(() => undefined); throw new Error("response too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "[::]", "::"]);
/**
 * True when two base URLs reach the same listener as far as can be told from
 * the strings: loopback aliases (localhost, 127.x, ::1, 0.0.0.0) and default
 * ports are folded together. A false result proves nothing about the far side.
 */
export function sameEndpoint(a: string, b: string): boolean {
  const key = (value: string): string | null => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const loop = LOOPBACK.has(host) || /^127\./.test(host) || /^\[?::ffff:127\./.test(host) || /^\[?::ffff:7f/.test(host);
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${loop ? "loopback" : host}:${port}`;
    } catch { return null; }
  };
  const ka = key(a), kb = key(b);
  return ka === null || kb === null || ka === kb;
}
