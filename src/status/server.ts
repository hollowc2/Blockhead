import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Logger } from "pino";
import type { StatusSnapshot } from "./snapshot.js";

/**
 * Operator hook for local debugging. It is reachable only when the server is
 * bound to a loopback address, so nothing on the LAN can drive the bot.
 */
export interface StatusOperatorHooks {
  /** Deliver `text` exactly as if the configured owner typed it in chat. */
  command?: (text: string) => string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class StatusServer {
  private server: Server | null = null;
  constructor(private readonly options: { status: () => StatusSnapshot | Promise<StatusSnapshot>; host: string; port: number; logger?: Logger; operator?: StatusOperatorHooks }) {}

  private operatorEnabled(): boolean {
    return LOOPBACK_HOSTS.has(this.options.host);
  }

  start(): void {
    if (this.server !== null) return;
    this.server = createServer((request, response) => {
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
      };
      const operator = this.operatorEnabled() ? this.options.operator : undefined;
      if (request.method === "POST" && request.url === "/command") {
        const command = operator?.command;
        if (command === undefined) { send(404, { error: "not found" }); return; }
        void (async () => {
          try {
            const result = command((await readBody(request)).trim());
            send(200, { ok: true, result });
          } catch (error) {
            this.options.logger?.warn({ err: String(error) }, "operator command failed");
            send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        })();
        return;
      }
      if (request.method !== "GET" || (request.url !== "/status" && request.url !== "/health")) {
        send(404, { error: "not found" });
        return;
      }
      void (async () => {
        try {
          send(200, await this.options.status());
        } catch (error) {
          this.options.logger?.warn({ err: String(error) }, "status request failed");
          send(500, { error: "status unavailable" });
        }
      })();
    });
    this.server.once("error", (error) => {
      this.options.logger?.warn({ err: String(error) }, "status server unavailable");
      this.server = null;
    });
    this.server.listen(this.options.port, this.options.host);
    this.server.unref();
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    server?.close();
    server?.closeAllConnections();
  }

  address(): { port: number } | null {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== "string" ? { port: address.port } : null;
  }
}
