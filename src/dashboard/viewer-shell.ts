import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { clientAddress, PUBLIC_VIEWER_HEADER, RateLimiter, SHELL_SECURITY_HEADERS, VIEWER_SECURITY_HEADERS } from "./http-guard.js";

const SHELL_HTML = fileURLToPath(new URL("./public/viewer-shell.html", import.meta.url));
const SHELL_CSS = fileURLToPath(new URL("./public/viewer-shell.css", import.meta.url));
const SHELL_JS = fileURLToPath(new URL("./public/viewer-shell.js", import.meta.url));

/** Viewer bundle files a public client may fetch (see prismarine-viewer/public). */
const PUBLIC_VIEWER_ASSET = /^\/viewer\/(?:index\.js|worker\.js|(?:textures|blocksStates)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:png|json))$/;
const MAX_PUBLIC_POST_BYTES = 8192;
/** Request headers forwarded upstream from public clients; everything else is dropped. */
const PUBLIC_FORWARD_HEADERS = ["accept", "content-type", "content-length", "if-none-match", "if-modified-since"] as const;
const PUBLIC_UPGRADE_HEADERS = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version"] as const;
/** Response headers passed back to public clients; e.g. x-powered-by never is. */
const PUBLIC_RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "etag", "last-modified"] as const;

export function viewerTargetPath(requestUrl: string): string {
  return requestUrl === "/viewer" ? "/" : requestUrl.slice("/viewer".length);
}

export function isViewerSocketPath(pathname: string): boolean {
  return pathname === "/viewer/socket.io" || pathname.startsWith("/viewer/socket.io/") ||
    pathname === "/socket.io" || pathname.startsWith("/socket.io/");
}

export interface PublicShellLimits {
  /** HTTP requests per IP: burst size and sustained rate. */
  httpBurst: number;
  httpPerSecond: number;
  /** New Socket.IO sessions per IP: burst size and sustained rate. */
  handshakeBurst: number;
  handshakePerSecond: number;
  /** Concurrent websocket tunnels per IP and in total. */
  socketsPerIp: number;
  socketsTotal: number;
}

export const DEFAULT_PUBLIC_LIMITS: PublicShellLimits = {
  httpBurst: 200,
  httpPerSecond: 10,
  handshakeBurst: 6,
  handshakePerSecond: 0.1,
  socketsPerIp: 3,
  socketsTotal: 12,
};

export interface ViewerShellOptions {
  host: string;
  port: number;
  viewerPort: number;
  statsPort: number;
  /**
   * "public" serves only the viewer and a redacted state, with rate limits
   * and no proxy route to the dashboard. Defaults to "private".
   */
  mode?: "private" | "public";
  /** Redacted state for public mode's `/api/state`. */
  publicState?: () => Promise<unknown>;
  limits?: PublicShellLimits;
  logger?: Pick<Logger, "warn">;
}

/** Hosts the combined third-person viewer page while proxying viewer traffic. */
export class ViewerShellServer {
  private server: Server | null = null;
  private readonly isPublic: boolean;
  private readonly limits: PublicShellLimits;
  private readonly httpLimiter: RateLimiter;
  private readonly handshakeLimiter: RateLimiter;
  private readonly socketsByIp = new Map<string, number>();
  private openSockets = 0;

  constructor(private readonly options: ViewerShellOptions) {
    this.isPublic = options.mode === "public";
    this.limits = options.limits ?? DEFAULT_PUBLIC_LIMITS;
    this.httpLimiter = new RateLimiter(this.limits.httpBurst, this.limits.httpPerSecond);
    this.handshakeLimiter = new RateLimiter(this.limits.handshakeBurst, this.limits.handshakePerSecond);
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    const server = createServer((request, response) => {
      const handler = this.isPublic ? this.handlePublic(request, response) : this.handle(request, response);
      void handler.catch(() => this.sendText(response, 500, "server error"));
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("upgrade", (request, socket, head) => {
      if (this.isPublic) this.handlePublicUpgrade(request, socket, head);
      else this.handleUpgrade(request, socket, head);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    }).catch((error: unknown) => {
      if (this.server === server) this.server = null;
      throw error;
    });
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    server?.close();
    server?.closeAllConnections();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (isViewerSocketPath(pathname) && (request.method === "GET" || request.method === "POST")) {
      const targetPath = pathname.startsWith("/viewer/")
        ? viewerTargetPath(request.url ?? pathname)
        : request.url ?? pathname;
      this.proxy(request, response, this.options.viewerPort, targetPath);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end("method not allowed");
      return;
    }
    if (await this.serveShellAsset(pathname, response)) return;
    if (pathname === "/api/state") {
      this.proxy(request, response, this.options.statsPort, "/api/state");
      return;
    }
    if (pathname === "/viewer" || pathname.startsWith("/viewer/")) {
      this.proxy(request, response, this.options.viewerPort, viewerTargetPath(request.url ?? pathname));
      return;
    }
    this.sendText(response, 404, "not found");
  }

  /** Public allowlist: shell page, viewer bundle, viewer socket, redacted state. Anything else is 404. */
  private async handlePublic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = clientAddress(request, true);
    if (!this.httpLimiter.take(ip)) { this.sendText(response, 429, "too many requests"); return; }
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (isViewerSocketPath(pathname)) {
      if (!(request.method === "GET" || request.method === "POST") || url.searchParams.get("EIO") !== "4") {
        this.sendText(response, 404, "not found");
        return;
      }
      if (!url.searchParams.has("sid") && !this.handshakeLimiter.take(ip)) {
        this.sendText(response, 429, "too many requests");
        return;
      }
      if (request.method === "POST") {
        const length = Number(request.headers["content-length"]);
        if (!Number.isFinite(length) || length > MAX_PUBLIC_POST_BYTES) { this.sendText(response, 413, "payload too large"); return; }
      }
      this.proxy(request, response, this.options.viewerPort, `/socket.io/${url.search}`);
      return;
    }
    if (request.method !== "GET") { this.sendText(response, 404, "not found"); return; }
    if (await this.serveShellAsset(pathname, response)) return;
    if (pathname === "/api/state" && this.options.publicState !== undefined) {
      try {
        const body = JSON.stringify(await this.options.publicState());
        response.writeHead(200, { ...SHELL_SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
        response.end(body);
      } catch {
        this.sendText(response, 503, "state unavailable");
      }
      return;
    }
    if (pathname === "/viewer" || pathname === "/viewer/") {
      this.proxy(request, response, this.options.viewerPort, "/");
      return;
    }
    if (PUBLIC_VIEWER_ASSET.test(pathname) && !pathname.includes("..")) {
      this.proxy(request, response, this.options.viewerPort, viewerTargetPath(pathname));
      return;
    }
    this.sendText(response, 404, "not found");
  }

  private async serveShellAsset(pathname: string, response: ServerResponse): Promise<boolean> {
    if (pathname === "/") await this.sendFile(response, SHELL_HTML, "text/html; charset=utf-8");
    else if (pathname === "/viewer-shell.css") await this.sendFile(response, SHELL_CSS, "text/css; charset=utf-8");
    else if (pathname === "/viewer-shell.js") await this.sendFile(response, SHELL_JS, "text/javascript; charset=utf-8");
    else return false;
    return true;
  }

  private sendText(response: ServerResponse, status: number, body: string): void {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { ...SHELL_SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  }

  private async sendFile(response: ServerResponse, path: string, contentType: string): Promise<void> {
    try {
      const body = await readFile(path);
      response.writeHead(200, { ...SHELL_SECURITY_HEADERS, "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    } catch (error) {
      this.options.logger?.warn({ err: String(error), path }, "viewer shell asset failed");
      this.sendText(response, 500, "asset unavailable");
    }
  }

  private proxy(request: IncomingMessage, response: ServerResponse, port: number, path: string): void {
    const headers: IncomingHttpHeaders = this.isPublic
      ? { ...pick(request.headers, PUBLIC_FORWARD_HEADERS), [PUBLIC_VIEWER_HEADER]: "1" }
      : { ...request.headers };
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: request.method,
      headers: { ...headers, host: `127.0.0.1:${port}` },
      timeout: 60_000,
    }, (upstreamResponse) => {
      const passed = this.isPublic
        ? { ...pick(upstreamResponse.headers, PUBLIC_RESPONSE_HEADERS), ...VIEWER_SECURITY_HEADERS }
        : upstreamResponse.headers;
      response.writeHead(upstreamResponse.statusCode ?? 502, { ...passed, "cache-control": "no-store" });
      upstreamResponse.pipe(response);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.once("error", (error) => {
      this.options.logger?.warn({ err: String(error), port, path }, "viewer shell proxy failed");
      if (!response.headersSent) this.sendText(response, 502, "upstream unavailable");
      else response.destroy();
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const viewerSocket = pathname === "/viewer/socket.io" || pathname.startsWith("/viewer/socket.io/");
    const directSocket = pathname === "/socket.io" || pathname.startsWith("/socket.io/");
    if (!viewerSocket && !directSocket) {
      socket.destroy();
      return;
    }
    const upstreamPath = viewerSocket ? (request.url ?? pathname).slice("/viewer".length) : (request.url ?? pathname);
    this.tunnel(socket, head, upstreamPath, request.headers);
  }

  private handlePublicUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const ip = clientAddress(request, true);
    const valid = isViewerSocketPath(url.pathname) && request.method === "GET" &&
      String(request.headers.upgrade).toLowerCase() === "websocket" &&
      url.searchParams.get("EIO") === "4" && url.searchParams.get("transport") === "websocket";
    const perIp = this.socketsByIp.get(ip) ?? 0;
    if (!valid || !this.httpLimiter.take(ip) || (!url.searchParams.has("sid") && !this.handshakeLimiter.take(ip)) ||
      perIp >= this.limits.socketsPerIp || this.openSockets >= this.limits.socketsTotal) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    this.openSockets += 1;
    this.socketsByIp.set(ip, perIp + 1);
    socket.once("close", () => {
      this.openSockets -= 1;
      const remaining = (this.socketsByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) this.socketsByIp.delete(ip);
      else this.socketsByIp.set(ip, remaining);
    });
    const headers = { ...pick(request.headers, PUBLIC_UPGRADE_HEADERS), [PUBLIC_VIEWER_HEADER]: "1" };
    this.tunnel(socket, head, `/socket.io/${url.search}`, headers);
  }

  private tunnel(socket: Duplex, head: Buffer, upstreamPath: string, headers: IncomingHttpHeaders): void {
    const upstream = connectTcp(this.options.viewerPort, "127.0.0.1", () => {
      const target = `GET ${upstreamPath} HTTP/1.1\r\n` +
        Object.entries({ ...headers, host: `127.0.0.1:${this.options.viewerPort}` })
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}\r\n`).join("") +
        "\r\n";
      upstream.write(target);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    upstream.once("close", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  }
}

function pick(headers: IncomingHttpHeaders, names: readonly string[]): IncomingHttpHeaders {
  const picked: IncomingHttpHeaders = {};
  for (const name of names) if (headers[name] !== undefined) picked[name] = headers[name];
  return picked;
}
