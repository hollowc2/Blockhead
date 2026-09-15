import { z } from "zod";
import { ChatCompletionSchema } from "./schemas.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Retries for transient HTTP/network failures. */
  maxRetries: number;
  onFailure?: (failure: { kind: "timeout" | "http_error" | "network_error"; attempt: number; error: string }) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const MODEL_ID_PENDING = "local-model";
const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })).min(1) });

export class LlamaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onFailure?: LlmClientOptions["onFailure"];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private modelId: string | null = null;
  private _lastSuccessAt: number | null = null;
  private _consecutiveFailures = 0;
  private _lastFailure: { at: number; kind: "timeout" | "http_error" | "network_error"; error: string } | null = null;

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.onFailure = options.onFailure;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  get endpoint(): string { return this.baseUrl; }
  get modelName(): string { return this.modelId ?? MODEL_ID_PENDING; }
  get lastSuccessAt(): number | null { return this._lastSuccessAt; }
  get consecutiveFailures(): number { return this._consecutiveFailures; }
  get lastFailure(): typeof this._lastFailure { return this._lastFailure; }
  get healthState(): "unknown" | "ok" | "failing" {
    if (this._lastSuccessAt === null && this._consecutiveFailures === 0) return "unknown";
    return this._consecutiveFailures === 0 ? "ok" : "failing";
  }

  async probe(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { method: "GET", signal: controller.signal });
        if (!res.ok) return false;
        ModelsSchema.parse(await res.json());
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** Record a successful transport-level response for diagnostics. */
  noteSuccess(): void {
    this._lastSuccessAt = this.now();
    this._consecutiveFailures = 0;
    this._lastFailure = null;
  }

  /** Record a failed transport-level attempt for diagnostics. */
  noteFailure(failure: { kind: "timeout" | "http_error" | "network_error"; error: string }): void {
    this._consecutiveFailures += 1;
    this._lastFailure = { at: this.now(), ...failure };
  }

  async complete(messages: LlmMessage[]): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.chatOnce(messages);
        this.noteSuccess();
        return response;
      } catch (err) {
        lastError = err;
        const error = err instanceof Error ? err : new Error(String(err));
        const kind = error.name === "AbortError"
          ? "timeout"
          : error.message.startsWith("llama.cpp returned HTTP") || error.message.startsWith("llama.cpp /v1/models returned HTTP")
            ? "http_error"
            : "network_error";
        this.noteFailure({ kind, error: error.message });
        this.onFailure?.({ kind, attempt: attempt + 1, error: error.message });
        if (attempt < this.maxRetries && isRetryable(error)) {
          const base = Math.min(5000, 250 * 2 ** attempt);
          await this.sleep(Math.round(base * (0.75 + this.random() * 0.5)));
        } else if (attempt < this.maxRetries) {
          break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async chatOnce(messages: LlmMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const model = await this.resolveModelId(controller);
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 512, stream: false, chat_template_kwargs: { enable_thinking: false } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`llama.cpp returned HTTP ${res.status}`);
      const data = ChatCompletionSchema.parse(await res.json());
      return data.choices[0]!.message.content;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveModelId(controller: AbortController): Promise<string> {
    if (this.modelId !== null) return this.modelId;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { method: "GET", signal: controller.signal });
    if (!res.ok) throw new Error(`llama.cpp /v1/models returned HTTP ${res.status}`);
    const parsed = ModelsSchema.parse(await res.json());
    this.modelId = parsed.data[0]!.id;
    return this.modelId;
  }
}

function isRetryable(error: Error): boolean {
  if (error.name === "AbortError" || error.message === "connection refused" || error.message.includes("fetch failed")) return true;
  const match = error.message.match(/HTTP (\d{3})/);
  if (match === null) return false;
  const status = Number(match[1]);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
