import { answerWithModel, type PublicModelAnswer } from "../dashboard/public-model-chat.js";
import type { PublicFacts } from "../dashboard/public-chat.js";
import { LlamaClient } from "./client.js";
import { PublicFirewall, REQUIRE_ENFORCEMENT_HEADER, sameEndpoint, type PublicFirewallOptions } from "./public-firewall.js";

/** Public replies are a few sentences; anything near this is not a valid answer. */
export const PUBLIC_REPLY_BYTES = 65_536;

export interface PublicModel {
  firewall: PublicFirewall;
  client: LlamaClient;
  answer: (question: string, facts: PublicFacts, signal: AbortSignal, deadline: number) => Promise<PublicModelAnswer>;
}

/**
 * The public question path: its own client on the Aegis base URL, gated by a
 * fresh enforcing readiness report, sending the enforcement-required header,
 * accepting only replies marked enforced, never following redirects or
 * retrying, with bounded replies, and settling abandoned work upstream before
 * the shared model queue moves on. Returns null (rules-based answers only)
 * when the base URL is llm.base_url or a loopback alias of it.
 */
export function createPublicModel(options: {
  baseUrl: string;
  directBaseUrl: string;
  timeoutMs: number;
  onFailure?: (failure: { kind: string; attempt: number }) => void;
  fetchImpl?: typeof fetch;
  firewall?: Omit<PublicFirewallOptions, "baseUrl" | "fetchImpl">;
}): PublicModel | null {
  if (sameEndpoint(options.baseUrl, options.directBaseUrl)) return null;
  const firewall = new PublicFirewall({ baseUrl: options.baseUrl, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...options.firewall });
  const client = new LlamaClient({
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
    headers: { [REQUIRE_ENFORCEMENT_HEADER]: "enforce" },
    maxResponseBytes: PUBLIC_REPLY_BYTES,
    guard: { before: signal => firewall.ensureReady(signal), verify: headers => firewall.verifyReply(headers), settle: () => firewall.settle() },
    // Fixed fields only: upstream error messages can quote reply text.
    ...(options.onFailure ? { onFailure: ({ kind, attempt }) => options.onFailure!({ kind, attempt }) } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const answer = (question: string, facts: PublicFacts, signal: AbortSignal, deadline: number): Promise<PublicModelAnswer> => answerWithModel(
    messages => client.complete(messages, { signal, deadline, priority: "public" }).catch((error: unknown) => { firewall.observe(error); throw error; }),
    facts, question, signal);
  return { firewall, client, answer };
}
