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
}

const MODEL_ID_PENDING = "local-model";
const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })).min(1) });

export class LlamaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onFailure?: LlmClientOptions["onFailure"];
  private readonly fetchImpl: typeof fetch;
  private modelId: string | null = null;

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.onFailure = options.onFailure;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get endpoint(): string { return this.baseUrl; }
  get modelName(): string { return this.modelId ?? MODEL_ID_PENDING; }

  async complete(messages: LlmMessage[]): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.chatOnce(messages);
      } catch (err) {
        lastError = err;
        const error = err instanceof Error ? err : new Error(String(err));
        const kind = error.name === "AbortError"
          ? "timeout"
          : error.message.startsWith("llama.cpp returned HTTP") || error.message.startsWith("llama.cpp /v1/models returned HTTP")
            ? "http_error"
            : "network_error";
        this.onFailure?.({ kind, attempt: attempt + 1, error: error.message });
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
