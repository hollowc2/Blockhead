import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PUBLIC_ACTIONS, type PublicActionController } from "../agent/public-actions.js";
import { answerPublicQuestion, publicFacts, type PublicFacts } from "./public-chat.js";
import { BLOCKED_ANSWER, type PublicModelAnswer } from "./public-model-chat.js";
import { clientAddress, addressKey, SHELL_SECURITY_HEADERS } from "./http-guard.js";

/** modelDeadlineMs: the model is shared with the bot's own decisions, so a question can queue behind one. */
export const PUBLIC_LIMITS = { bodyBytes: 1024, bodyMs: 5000, deadlineMs: 8000, modelDeadlineMs: 45_000, concurrent: 8, keys: 10_000 } as const;
export const questionSchema = z.object({ question: z.string().transform(s => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()).refine(s => [...s].length > 0 && [...s].length <= 200) }).strict();
export const actionSchema = z.object({ action: z.enum(PUBLIC_ACTIONS) }).strict();
const settingsSchema = z.object({ questions_enabled: z.boolean(), actions_enabled: z.boolean() }).strict();

export const interactionAddress = addressKey;

/** Exact rolling windows; active entries are never evicted to admit new keys. */
export class InteractionLimiter {
  private entries = new Map<string, number[]>();
  constructor(private now = Date.now, private maxKeys = PUBLIC_LIMITS.keys as number) {}
  take(key: string, count: number, window: number): boolean {
    const now = this.now();
    // All entries retain at most one hour, the longest policy window.
    if (!this.entries.has(key) && this.entries.size >= this.maxKeys) {
      for (const [k, times] of this.entries) if (times.at(-1)! <= now - 3600_000) this.entries.delete(k);
      if (this.entries.size >= this.maxKeys) return false;
    }
    const times = (this.entries.get(key) ?? []).filter(at => at > now - window);
    this.entries.set(key, times);
    if (times.length >= count) return false;
    times.push(now);
    return true;
  }
  /** Milliseconds until *take* with the same policy could succeed; never records an attempt. */
  wait(key: string, count: number, window: number): number {
    const now = this.now();
    const times = (this.entries.get(key) ?? []).filter(at => at > now - window);
    return times.length < count ? 0 : times[times.length - count]! + window - now;
  }
}

/** Why a public feature is unavailable: switched off, Bob busy (or answering someone else), or a shared cooldown. */
export type UnavailableReason = "disabled" | "busy" | "cooldown";
export interface PublicAvailability {
  questions: boolean;
  actions: boolean;
  questionsReason: UnavailableReason | null;
  actionsReason: UnavailableReason | null;
  /** Shared cooldowns every viewer is under; a visitor's own limit arrives with a refusal. */
  questionsCooldownMs: number;
  actionsCooldownMs: number;
  helloCooldownMs: number;
}

export type PublicResultCode = "ok" | "unavailable" | "cancelled" | "invalid" | "too_large" | "body_timeout" | "limited" | "capacity" | "origin" | "content_type" | "disabled" | "unconfirmed" | "action_timeout";
export interface PublicInteractionResponse { code: PublicResultCode; text: string; retryAfterMs?: number; helloRetryAfterMs?: number; answerKind?: "model" | "rules" | "refusal" }
class Refusal extends Error { constructor(readonly status: number, readonly code: PublicResultCode) { super(code); } }
async function readJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const cleanup = (): void => { clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", failed); signal.removeEventListener("abort", aborted); request.pause(); };
    const fail = (error: Refusal): void => { cleanup(); reject(error); };
    const aborted = (): void => fail(new Refusal(503, "cancelled"));
    const failed = (): void => fail(new Refusal(400, "invalid"));
    const data = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > PUBLIC_LIMITS.bodyBytes) fail(new Refusal(413, "too_large")); else chunks.push(chunk); };
    const end = (): void => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Refusal(400, "invalid")); } };
    const timer = setTimeout(() => fail(new Refusal(503, "body_timeout")), PUBLIC_LIMITS.bodyMs);
    request.on("data", data); request.once("end", end); request.once("error", failed); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
/** Resolves to null once *signal* aborts, so a slow model never outlives the request deadline. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let onAbort!: () => void;
  const aborted = new Promise<null>(resolve => { onAbort = () => resolve(null); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", onAbort); }
}
export class PublicInteractions {
  private questions: boolean;
  private actions: boolean;
  private limiter: InteractionLimiter;
  private active = new Map<AbortController, "question" | "action">();
  private questionBusy = false;
  private readonly modelWork = new Set<Promise<PublicModelAnswer>>();
  private stopped = false;
  private counters = { accepted: 0, rejected: 0, timeout: 0 };
  constructor(private options: {
    config: { questions_enabled: boolean; actions_enabled: boolean; allowed_origin?: string };
    facts: () => PublicFacts;
    gestures: PublicActionController;
    /** Model-backed answers (through the Aegis firewall); rules-based answers when absent or failing. */
    modelAnswer?: (question: string, facts: PublicFacts, signal: AbortSignal, deadline: number) => Promise<PublicModelAnswer>;
    now?: () => number;
    log?: (record: Record<string, unknown>) => void;
  }) {
    this.questions = options.config.questions_enabled;
    this.actions = options.config.actions_enabled;
    this.limiter = new InteractionLimiter(options.now);
  }
  availability(): PublicAvailability {
    const origin = !!this.options.config.allowed_origin;
    const questionsCooldownMs = Math.max(this.limiter.wait("question:global", 1, 15_000), this.limiter.wait("question:hour", 120, 3600_000));
    const actionsCooldownMs = this.limiter.wait("action:global", 1, 5000);
    const questionsReason: UnavailableReason | null = !this.questions || !origin ? "disabled" : (this.questionBusy || this.modelWork.size > 0) ? "busy" : questionsCooldownMs > 0 ? "cooldown" : null;
    const actionsReason: UnavailableReason | null = !this.actions || !origin ? "disabled" : !this.options.gestures.available() ? "busy" : actionsCooldownMs > 0 ? "cooldown" : null;
    // Cooldowns don't flip the flags: the countdown is advisory and the server re-checks on submit.
    return {
      questions: questionsReason === null, actions: actionsReason === null,
      questionsReason, actionsReason, questionsCooldownMs, actionsCooldownMs, helloCooldownMs: this.limiter.wait("action:hello", 1, 30_000),
    };
  }
  /** The longest wait among every limit *feature* passes through for this address. */
  private retryAfter(feature: "question" | "action", ip: string, action?: string): number {
    const waits = [this.limiter.wait("attempt:global", 120, 60_000), this.limiter.wait(`attempt:${ip}`, 10, 60_000)];
    if (feature === "question") waits.push(this.limiter.wait(`question:${ip}`, 1, 30_000), this.limiter.wait("question:global", 1, 15_000), this.limiter.wait("question:hour", 120, 3600_000));
    else waits.push(this.limiter.wait(`action:${ip}`, 1, 10_000), this.limiter.wait("action:global", 1, 5000), action === "hello" ? this.limiter.wait("action:hello", 1, 30_000) : 0);
    return Math.max(...waits);
  }
  diagnostics(): unknown { return { ...this.availability(), configuredActions: this.actions, modelQuestions: !!this.options.modelAnswer, gesture: this.options.gestures.diagnostics(), ...this.counters, modelOutstanding: this.modelWork.size, inFlight: this.active.size, questionsInFlight: [...this.active.values()].filter(feature => feature === "question").length, actionsInFlight: [...this.active.values()].filter(feature => feature === "action").length }; }
  configure(raw: unknown): unknown {
    const config = settingsSchema.parse(raw);
    if ((config.questions_enabled || config.actions_enabled) && !this.options.config.allowed_origin) throw new Error("origin required");
    this.questions = config.questions_enabled; this.actions = config.actions_enabled;
    if (!this.actions) this.options.gestures.invalidate();
    for (const [controller, feature] of this.active) if (feature === "question" ? !this.questions : !this.actions) controller.abort();
    return this.diagnostics();
  }
  /** Safety interrupts stop physical actions; questions never move the bot, so a model answer in flight is left to finish. */
  cancel(): void { this.options.gestures.invalidate(); for (const [c, feature] of this.active) if (feature === "action") c.abort(); }
  cancelAll(): void { this.options.gestures.invalidate(); for (const c of this.active.keys()) c.abort(); }
  shutdown(): void { this.stopped = true; this.cancelAll(); }
  async handle(feature: "question" | "action", request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now(), id = randomUUID(); let code: PublicResultCode = "unavailable"; let status = 503, text = "Bob is unavailable right now.";
    const controller = new AbortController(); let admitted = false, ownsQuestion = false;
    const disconnect = (): void => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", disconnect); response.once("close", disconnect);
    const deadline = Date.now() + (feature === "question" && this.options.modelAnswer ? PUBLIC_LIMITS.modelDeadlineMs : PUBLIC_LIMITS.deadlineMs);
    const timer = setTimeout(() => controller.abort(), deadline - Date.now());
    let actionId: string | undefined;
    let answeredBy: "rules" | "model" | "firewall" | undefined;
    let retryAfterMs: number | undefined, ip = "unknown";
    try {
      if (this.stopped) throw new Refusal(503, "disabled");
      ip = interactionAddress(clientAddress(request, true));
      if (!this.limiter.take("attempt:global", 120, 60_000) || !this.limiter.take(`attempt:${ip}`, 10, 60_000)) throw new Refusal(429, "limited");
      if (request.method !== "POST") throw new Refusal(400, "invalid");
      if (!this.options.config.allowed_origin || request.headers.origin !== this.options.config.allowed_origin || request.headers["sec-fetch-site"] === "cross-site") throw new Refusal(403, "origin");
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers["content-type"] ?? "")) || request.headers["content-encoding"] !== undefined) throw new Refusal(415, "content_type");
      if (Number(request.headers["content-length"] ?? 0) > PUBLIC_LIMITS.bodyBytes) throw new Refusal(413, "too_large");
      if (this.active.size >= PUBLIC_LIMITS.concurrent) throw new Refusal(429, "capacity");
      if (!(feature === "question" ? this.questions : this.actions)) throw new Refusal(503, "disabled");
      this.active.set(controller, feature); admitted = true;
      const raw = await readJson(request, controller.signal);
      if (controller.signal.aborted || !(feature === "question" ? this.questions : this.actions)) throw new Refusal(503, "cancelled");
      if (feature === "question") {
        const parsed = questionSchema.safeParse(raw); if (!parsed.success) throw new Refusal(400, "invalid");
        if (this.questionBusy || this.modelWork.size > 0 || !this.limiter.take(`question:${ip}`, 1, 30_000) || !this.limiter.take("question:global", 1, 15_000) || !this.limiter.take("question:hour", 120, 3600_000)) throw new Refusal(429, "limited");
        this.questionBusy = true; ownsQuestion = true;
        const facts = publicFacts(this.options.facts());
        text = answerPublicQuestion(parsed.data.question, facts); answeredBy = "rules";
        if (this.options.modelAnswer && facts.connected) {
          const work = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.options.modelAnswer!(parsed.data.question, facts, controller.signal, deadline); });
          this.modelWork.add(work);
          void work.then(() => this.modelWork.delete(work), () => this.modelWork.delete(work));
          const model = await untilAborted(work.catch(() => null), controller.signal);
          if (model?.kind === "answer") { text = model.text; answeredBy = "model"; }
          else if (model?.kind === "blocked") { text = BLOCKED_ANSWER; answeredBy = "firewall"; }
        }
      } else {
        const parsed = actionSchema.safeParse(raw); if (!parsed.success) throw new Refusal(400, "invalid");
        actionId = parsed.data.action;
        if (!this.options.gestures.available()) throw new Refusal(503, "unavailable");
        if (this.retryAfter("action", ip, actionId) > 0) throw new Refusal(429, "limited");
        if (!this.limiter.take(`action:${ip}`, 1, 10_000) || !this.limiter.take("action:global", 1, 5000) || (actionId === "hello" && !this.limiter.take("action:hello", 1, 30_000))) throw new Refusal(429, "limited");
        if (!await this.options.gestures.execute(parsed.data.action, controller.signal)) throw new Refusal(503, this.options.gestures.diagnostics().quarantined ? "action_timeout" : "unconfirmed");
        text = "Done!";
      }
      if (controller.signal.aborted) throw new Refusal(503, "cancelled");
      code = "ok"; status = 200;
      // The visitor's own next opening, so the page can count down without guessing.
      // The hello-only limit is left out so it never greys out the other gestures.
      const next = this.retryAfter(feature, ip);
      if (next > 0) retryAfterMs = next;
    } catch (error) {
      if (error instanceof Refusal) { status = error.status; code = error.code; }
      if (status === 429) { const wait = this.retryAfter(feature, ip); if (wait > 0) retryAfterMs = Math.max(1000, wait); }
      text = status === 429 ? "Please wait before trying again. Shared public limits apply." : (code === "unconfirmed" || code === "action_timeout") ? "Delivery could not be confirmed." : status === 400 ? "Invalid request." : "Public interaction unavailable.";
    } finally {
      clearTimeout(timer); request.off("aborted", disconnect); response.off("close", disconnect);
      if (admitted) this.active.delete(controller);
      if (ownsQuestion) this.questionBusy = false;
      this.counters[status === 200 ? "accepted" : "rejected"]++;
      if (code === "body_timeout" || code === "action_timeout" || controller.signal.aborted) this.counters.timeout++;
      this.options.log?.({ time: new Date().toISOString(), requestId: id, feature, action: actionId, answeredBy, outcome: status === 200 ? "accepted" : "refused", durationMs: Date.now() - started, reason: code });
    }
    if (!response.destroyed) {
      response.writeHead(status, { ...SHELL_SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...(status === 429 ? { "retry-after": String(Math.ceil((retryAfterMs ?? 30_000) / 1000)) } : {}), ...(status !== 200 ? { connection: "close" } : {}) });
      const result: PublicInteractionResponse = { ...(status === 200 && feature === "question" ? { answerKind: answeredBy === "model" ? "model" as const : answeredBy === "firewall" ? "refusal" as const : "rules" as const } : {}), ...(actionId === "hello" ? { helloRetryAfterMs: this.limiter.wait("action:hello", 1, 30_000) } : {}), code, text: [...text].slice(0, 500).join(""), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      response.end(JSON.stringify(result));
    }
  }
}
