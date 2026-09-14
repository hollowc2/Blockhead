import { z } from "zod";
import { ChatCompletionSchema } from "./schemas.js";

/** One chat message in the llama.cpp OpenAI-compatible request format. */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Retries for transient HTTP/network failures (schema retries live in the decider). */
  maxRetries: number;
}

/** Label shown on the dashboard until the server's real model id resolves. */
const MODEL_ID_PENDING = "local-model";

/** Minimal `/v1/models` response (OpenAI-compatible model list). */
const ModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })).min(1),
});

/**
 * HTTP client for a local llama.cpp OpenAI-compatible server.
 * Speaks `/v1/chat/completions` so the model stays swappable (spec 2.3).
 */
export class LlamaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  /** The server's advertised model id, resolved lazily from /v1/models. */
  private modelId: string | null = null;

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
  }

  /** Human-facing server endpoint (dashboard / observability). */
  get endpoint(): string {
    return this.baseUrl;
  }

  /**
   * The model id the server advertises, or the pending label before the
   * first successful resolution.
   */
  get modelName(): string {
    return this.modelId ?? MODEL_ID_PENDING;
  }

  /** Send a chat and return the assistant's raw text. */
  async complete(messages: LlmMessage[]): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.chatOnce(messages);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async chatOnce(messages: LlmMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const model = await this.resolveModelId(controller);
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: 512,
          stream: false,
          // The live server runs a Qwen3-style reasoning model that spends its
          // token budget on a "thinking" block by default, which empties
          // `content` under a small max_tokens. Disable thinking per request;
          // non-reasoning templates ignore the kwarg harmlessly (spec 2.3).
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`llama.cpp returned HTTP ${res.status}`);
      }
      const data = ChatCompletionSchema.parse(await res.json());
      return data.choices[0]!.message.content;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the model id to send, caching it for the process lifetime.
   * llama.cpp servers built with model presets validate the completion's
   * `model` field against /v1/models and reject unknown ids with HTTP 400,
   * so the advertised id must be used verbatim.
   */
  private async resolveModelId(controller: AbortController): Promise<string> {
    if (this.modelId !== null) return this.modelId;
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`llama.cpp /v1/models returned HTTP ${res.status}`);
    }
    const parsed = ModelsSchema.parse(await res.json());
    this.modelId = parsed.data[0]!.id;
    return this.modelId;
  }
}
