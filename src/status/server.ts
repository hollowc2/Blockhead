import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { StatusSnapshot } from "./snapshot.js";
import { requestTarget } from "../dashboard/http-guard.js";

export interface StatusOperatorHooks {
  command?: (text: string) => string;
  publicInteractions?: { status: () => unknown; configure: (raw: unknown) => unknown };
}
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const OPERATOR_BODY_BYTES = 4096;
export const OPERATOR_BODY_MS = 5000;

class BodyError extends Error { constructor(readonly status: number) { super("invalid body"); } }
async function readBody(request: IncomingMessage, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = (): void => { clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", fail); request.off("aborted", fail); request.pause(); };
    const fail = (error: unknown): void => { cleanup(); reject(error instanceof BodyError ? error : new BodyError(400)); };
    const data = (chunk: Buffer): void => { size += chunk.length; if (size > OPERATOR_BODY_BYTES) fail(new BodyError(413)); else chunks.push(chunk); };
    const end = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const timer = setTimeout(() => fail(new BodyError(408)), deadlineMs);
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", fail);
  });
}

export class StatusServer {
  private server: Server | null = null;
  constructor(private readonly options: { status: () => StatusSnapshot | Promise<StatusSnapshot>; host: string; port: number; logger?: Logger; operator?: StatusOperatorHooks; operatorToken?: string; bodyTimeoutMs?: number }) {}

  private authorized(request: IncomingMessage): boolean {
    const token = this.options.operatorToken;
    const header = request.headers.authorization;
    if (!token || token.length < 32 || !header || !/^Bearer [\x21-\x7e]+$/.test(header) || header.length > 1024) return false;
    const hash = (text: string): Buffer => createHash("sha256").update(text).digest();
    return timingSafeEqual(hash(header.slice(7)), hash(token));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "close" });
      response.end(JSON.stringify(body));
    };
    const target = requestTarget(request.url);
    if (!target) { send(400, { error: "invalid target" }); return; }
    const operator = LOOPBACK_HOSTS.has(this.options.host) ? this.options.operator : undefined;
    if (target.pathname === "/command" || target.pathname === "/public-interactions") {
      if (!operator) { send(404, { error: "not found" }); return; }
      // This channel is for local CLI callers only. Even same-origin browser requests are refused.
      if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined || request.headers["sec-fetch-mode"] !== undefined || request.headers["sec-fetch-dest"] !== undefined) { send(403, { error: "forbidden" }); return; }
      if (!this.authorized(request)) { send(401, { error: "unauthorized" }); return; }
      if (target.pathname === "/public-interactions" && request.method === "GET" && operator.publicInteractions) { send(200, operator.publicInteractions.status()); return; }
      if (request.method !== "POST") { send(405, { error: "method not allowed" }); return; }
      const expected = target.pathname === "/command" ? "text/plain" : "application/json";
      if (!new RegExp(`^${expected}(?:\\s*;\\s*charset=utf-8)?$`, "i").test(String(request.headers["content-type"] ?? "")) || request.headers["content-encoding"] !== undefined) { send(415, { error: "unsupported content type" }); return; }
      if (Number(request.headers["content-length"] ?? 0) > OPERATOR_BODY_BYTES) { send(413, { error: "body too large" }); return; }
      try {
        const body = await readBody(request, this.options.bodyTimeoutMs ?? OPERATOR_BODY_MS);
        if (response.destroyed) return;
        if (target.pathname === "/command" && operator.command) {
          if (!body.trim()) { send(400, { error: "empty command" }); return; }
          send(200, { ok: true, result: operator.command(body.trim()) });
        } else if (target.pathname === "/public-interactions" && operator.publicInteractions) send(200, operator.publicInteractions.configure(JSON.parse(body)));
        else send(404, { error: "not found" });
      } catch (error) { send(error instanceof BodyError ? error.status : 400, { error: "invalid request" }); }
      return;
    }
    if (request.method !== "GET" || (target.pathname !== "/status" && target.pathname !== "/health")) { send(404, { error: "not found" }); return; }
    try { send(200, await this.options.status()); } catch { send(500, { error: "status unavailable" }); }
  }

  start(): void {
    if (this.server !== null) return;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => { if (!response.destroyed) response.destroy(); });
    });
    this.server.maxConnections = 32;
    this.server.maxHeadersCount = 32;
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.once("error", (error) => { this.options.logger?.warn({ err: String(error) }, "status server unavailable"); this.server = null; });
    this.server.listen(this.options.port, this.options.host);
    this.server.unref();
  }
  stop(): void { const server = this.server; this.server = null; server?.close(); server?.closeAllConnections(); }
  address(): { port: number } | null {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== "string" ? { port: address.port } : null;
  }
}
