import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { WebSocketServer, WebSocket, type WebSocket as WebSocketType } from "ws";
import type { DashboardSnapshot } from "./types.js";

const SNAPSHOT_INTERVAL_MS = 500;
const MAX_BUFFERED_BYTES = 1_048_576;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const STATIC_ASSETS: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/dashboard.css": { file: "dashboard.css", contentType: "text/css; charset=utf-8" },
  "/dashboard.js": { file: "dashboard.js", contentType: "text/javascript; charset=utf-8" },
};

export interface DashboardServerOptions {
  host: string;
  port: number;
  snapshot: () => DashboardSnapshot | Promise<DashboardSnapshot>;
  logger?: Logger;
}

export class DashboardServer {
  private server: Server | null = null;
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocketType>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DashboardServerOptions) {
    this.websocketServer.on("connection", (client) => this.handleConnection(client));
  }

  start(): void {
    if (this.server !== null) return;

    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.server = server;
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method !== "GET" || pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (client) => {
        this.websocketServer.emit("connection", client, request);
      });
    });
    server.once("error", (error) => {
      this.options.logger?.warn({ err: String(error) }, "dashboard server unavailable");
      if (this.server === server) {
        this.server = null;
        this.clearSnapshotTimer();
      }
    });
    server.listen(this.options.port, this.options.host, () => {
      if (this.server === server) {
        this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), SNAPSHOT_INTERVAL_MS);
      }
    });
  }

  stop(): void {
    this.clearSnapshotTimer();
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.websocketServer.close();
    const server = this.server;
    this.server = null;
    server?.close();
  }

  address(): { port: number } | null {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== "string" ? { port: address.port } : null;
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET") {
      this.sendJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
      return;
    }
    const asset = STATIC_ASSETS[pathname];
    if (asset) {
      try {
        const body = await readFile(join(PUBLIC_DIR, asset.file));
        response.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store" });
        response.end(body);
      } catch (error) {
        this.options.logger?.warn({ err: String(error), pathname }, "dashboard static asset failed");
        this.sendJson(response, 500, { error: "asset unavailable" });
      }
      return;
    }
    if (pathname === "/health") {
      this.sendJson(response, 200, { ok: true, service: "blockhead-dashboard" });
      return;
    }
    if (pathname === "/api/state") {
      try {
        this.sendJson(response, 200, await this.options.snapshot());
      } catch (error) {
        this.options.logger?.warn({ err: String(error) }, "dashboard snapshot request failed");
        this.sendJson(response, 500, { error: "state unavailable" });
      }
      return;
    }
    this.sendJson(response, 404, { error: "not found" });
  }

  private handleConnection(client: WebSocketType): void {
    this.clients.add(client);
    client.once("close", () => this.clients.delete(client));
    client.once("error", () => this.clients.delete(client));
    void this.sendSnapshot(client);
  }

  private async broadcastSnapshot(): Promise<void> {
    if (this.clients.size === 0) return;
    let snapshot: DashboardSnapshot;
    try {
      snapshot = await this.options.snapshot();
    } catch (error) {
      this.options.logger?.warn({ err: String(error) }, "dashboard snapshot broadcast failed");
      return;
    }
    const envelope = JSON.stringify({ type: "snapshot", data: snapshot });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      client.send(envelope, (error) => {
        if (error) this.clients.delete(client);
      });
    }
  }

  private async sendSnapshot(client: WebSocketType): Promise<void> {
    try {
      const snapshot = await this.options.snapshot();
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= MAX_BUFFERED_BYTES) {
        client.send(JSON.stringify({ type: "snapshot", data: snapshot }), (error) => {
          if (error) this.clients.delete(client);
        });
      }
    } catch (error) {
      this.options.logger?.warn({ err: String(error) }, "dashboard initial snapshot failed");
    }
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer !== null) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders });
    response.end(JSON.stringify(body));
  }
}
