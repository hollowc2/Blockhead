import { createServer, type Server } from "node:http";
import type { Logger } from "pino";
import type { StatusSnapshot } from "./snapshot.js";

export class StatusServer {
  private server: Server | null = null;
  constructor(private readonly options: { status: () => StatusSnapshot | Promise<StatusSnapshot>; host: string; port: number; logger?: Logger }) {}

  start(): void {
    if (this.server !== null) return;
    this.server = createServer((request, response) => {
      if (request.method !== "GET" || (request.url !== "/status" && request.url !== "/health")) {
        response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      void (async () => {
        try {
          const body = JSON.stringify(await this.options.status());
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(body);
        } catch (error) {
        this.options.logger?.warn({ err: String(error) }, "status request failed");
        response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "status unavailable" }));
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
  }

  address(): { port: number } | null {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== "string" ? { port: address.port } : null;
  }
}
