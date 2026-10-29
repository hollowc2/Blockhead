import type { PublicInteractions } from "./public-interactions.js";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { ViewerChatResult } from "./viewer-chat.js";
import { addressKey, requestTarget, VIEWER_ADDRESS_HEADER, clientAddress, PUBLIC_VIEWER_HEADER, RateLimiter, SHELL_SECURITY_HEADERS, VIEWER_SECURITY_HEADERS, VIEWER_WORKER_SECURITY_HEADERS } from "./http-guard.js";

const SHELL_HTML = fileURLToPath(new URL("./public/viewer-shell.html", import.meta.url));
const SHELL_CSS = fileURLToPath(new URL("./public/viewer-shell.css", import.meta.url));
const SESSION_JS = fileURLToPath(new URL("./public/viewer-session.mjs", import.meta.url));
const SHELL_JS = fileURLToPath(new URL("./public/viewer-shell.js", import.meta.url));

/** Viewer bundle files a public client may fetch (see prismarine-viewer/public). */
const PUBLIC_VIEWER_ASSET = /^\/viewer\/(?:index\.js|worker\.js|(?:textures|blocksStates)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:png|json))$/;
const MAX_PUBLIC_POST_BYTES = 8192;
const MAX_CHAT_POST_BYTES = 2048;
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
  publicInteractions?: PublicInteractions;
  publicState?: () => Promise<unknown>;
  limits?: PublicShellLimits;
  /** Viewer Q&A behind `POST /api/chat`; private mode only, ignored when public. */
  chat?: (question: unknown) => Promise<ViewerChatResult>;
  /** Owner commands; private listener only. */
  command?: (command: unknown) => Promise<ViewerChatResult>;
  /** Owner-only data and controls (jobs, build preview, history, map); private listener only. */
  privateApi?: PrivateApi;
  logger?: Pick<Logger, "warn">;
}

export interface PrivateApiResult { status: number; body: unknown }
export interface PrivateApi {
  /** `POST /api/job` `{ kind, id, action }`: pause / resume / cancel one job. */
  job?: (body: unknown) => Promise<ViewerChatResult>;
  /** `POST /api/preview` `{ command }`: compile a build without starting it. */
  preview?: (body: unknown) => Promise<PrivateApiResult>;
  /** `POST /api/preview/start` `{ command, baseline }`: start a previewed build if its placement still holds. */
  previewStart?: (body: unknown) => Promise<PrivateApiResult>;
  /** `GET /api/history?since=ISO`: story and summary since the viewer's last visit. */
  history?: (since: string | null) => Promise<PrivateApiResult>;
  /** `GET /api/map`: remembered places, Bob, his destination and route. */
  map?: () => Promise<PrivateApiResult>;
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
  private readonly tunnels = new Set<Duplex>();

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
    server.maxConnections = 128;
    server.maxHeadersCount = 64;
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("upgrade", (request, socket, head) => {
      if (!requestTarget(request.url)) { socket.destroy(); return; }
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
    if (this.isPublic) this.options.publicInteractions?.cancelAll();
    for (const socket of this.tunnels) socket.destroy();
    this.tunnels.clear();
    server?.close();
    server?.closeAllConnections();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = requestTarget(request.url);
    if (!target) { this.sendText(response, 400, "invalid target"); return; }
    const pathname = target.pathname;
    if (isViewerSocketPath(pathname) && (request.method === "GET" || request.method === "POST")) {
      const targetPath = pathname.startsWith("/viewer/")
        ? viewerTargetPath(request.url ?? pathname)
        : request.url ?? pathname;
      this.proxy(request, response, this.options.viewerPort, targetPath);
      return;
    }
    if (pathname === "/api/chat" && this.options.chat !== undefined) {
      await this.handleChat(request, response, this.options.chat);
      return;
    }
    if (pathname === "/api/command" && this.options.command !== undefined) {
      await this.handleChat(request, response, this.options.command, "command");
      return;
    }
    const api = this.options.privateApi;
    if (pathname === "/api/job" && api?.job !== undefined) {
      await this.handleChat(request, response, api.job, null);
      return;
    }
    if ((pathname === "/api/preview" && api?.preview !== undefined) || (pathname === "/api/preview/start" && api?.previewStart !== undefined)) {
      const body = await this.readJsonBody(request, response);
      if (body === undefined) return;
      const run = pathname === "/api/preview" ? api.preview! : api.previewStart!;
      const result = await run(body).catch(() => ({ status: 503, body: { error: "Preview unavailable." } }));
      this.sendJson(response, result.status, result.body);
      return;
    }
    if ((pathname === "/api/history" && api?.history !== undefined) || (pathname === "/api/map" && api?.map !== undefined)) {
      if (request.method !== "GET") { this.sendJson(response, 405, { error: "method not allowed" }); return; }
      const since = new URL(request.url ?? "/", "http://localhost").searchParams.get("since");
      const result = await (pathname === "/api/map" ? api.map!() : api.history!(since)).catch(() => ({ status: 503, body: { error: "unavailable" } }));
      this.sendJson(response, result.status, result.body);
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
    const ip = addressKey(clientAddress(request, true));
    if (!this.httpLimiter.take(ip)) { response.setHeader("retry-after", "30"); this.sendText(response, 429, "too many requests"); return; }
    const url = requestTarget(request.url);
    if (!url) { this.sendText(response, 400, "invalid target"); return; }
    const pathname = url.pathname;

    if ((pathname === "/api/public/question" || pathname === "/api/public/action") && this.options.publicInteractions) {
      await this.options.publicInteractions.handle(pathname.endsWith("question") ? "question" : "action", request, response);
      return;
    }

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
        if (response.destroyed || response.writableEnded || response.headersSent) return;
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

  private async handleChat(request: IncomingMessage, response: ServerResponse, chat: (question: unknown) => Promise<ViewerChatResult>, field: "question" | "command" | null = "question"): Promise<void> {
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    const question = field === null ? body : (body as Record<string, unknown> | null)?.[field];
    const result = await chat(question);
    if (result.ok) this.sendJson(response, 200, { answer: result.answer });
    else this.sendJson(response, result.status, { error: result.error });
  }

  /** A same-origin JSON POST body, or undefined after answering the error. */
  private async readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    if (request.method !== "POST") { this.sendJson(response, 405, { error: "method not allowed" }); return undefined; }
    // JSON-only plus a same-origin check: a cross-site page cannot make a
    // browser send this without a preflight we never answer.
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { this.sendJson(response, 415, { error: "expected application/json" }); return undefined; }
    const origin = request.headers.origin;
    if (request.headers[PUBLIC_VIEWER_HEADER] !== undefined || request.headers["sec-fetch-site"] === "cross-site"
      || origin !== undefined && (() => { try { return new URL(origin).host !== request.headers.host; } catch { return true; } })()) {
      this.sendJson(response, 403, { error: "cross-origin request" });
      return undefined;
    }
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > MAX_CHAT_POST_BYTES) { this.sendJson(response, 413, { error: "payload too large" }); return undefined; }
    let body = "";
    try {
      body = await new Promise<string>((resolve, reject) => {
        let data = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          data += chunk;
          if (data.length > MAX_CHAT_POST_BYTES) { reject(new Error("too large")); request.destroy(); }
        });
        request.on("end", () => resolve(data));
        request.on("error", reject);
      });
    } catch {
      this.sendJson(response, 413, { error: "payload too large" });
      return undefined;
    }
    try { return JSON.parse(body) as unknown; } catch { return null; }
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { ...SHELL_SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  private async serveShellAsset(pathname: string, response: ServerResponse): Promise<boolean> {
    if (pathname === "/") await this.sendFile(response, SHELL_HTML, "text/html; charset=utf-8");
    else if (pathname === "/viewer-shell.css") await this.sendFile(response, SHELL_CSS, "text/css; charset=utf-8");
    else if (pathname === "/viewer-session.mjs") await this.sendFile(response, SESSION_JS, "text/javascript; charset=utf-8");
    else if (pathname === "/viewer-shell.js") await this.sendFile(response, SHELL_JS, "text/javascript; charset=utf-8");
    else return false;
    return true;
  }

  private sendText(response: ServerResponse, status: number, body: string): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { ...SHELL_SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  }

  private async sendFile(response: ServerResponse, path: string, contentType: string): Promise<void> {
    try {
      const body = await readFile(path);
      if (response.destroyed || response.writableEnded || response.headersSent) return;
      response.writeHead(200, { ...SHELL_SECURITY_HEADERS, "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    } catch (error) {
      this.options.logger?.warn({ err: String(error), path }, "viewer shell asset failed");
      this.sendText(response, 500, "asset unavailable");
    }
  }

  private proxy(request: IncomingMessage, response: ServerResponse, port: number, path: string): void {
    const headers: IncomingHttpHeaders = this.isPublic
      ? { ...pick(request.headers, PUBLIC_FORWARD_HEADERS), [PUBLIC_VIEWER_HEADER]: "1", [VIEWER_ADDRESS_HEADER]: addressKey(clientAddress(request, true)) }
      : { ...request.headers };
    if (!this.isPublic) { delete headers[PUBLIC_VIEWER_HEADER]; delete headers[VIEWER_ADDRESS_HEADER]; }
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: request.method,
      headers: { ...headers, host: `127.0.0.1:${port}` },
      timeout: 60_000,
    }, (upstreamResponse) => {
      const passed = this.isPublic
        ? { ...pick(upstreamResponse.headers, PUBLIC_RESPONSE_HEADERS), ...(path === "/worker.js" ? VIEWER_WORKER_SECURITY_HEADERS : VIEWER_SECURITY_HEADERS) }
        : upstreamResponse.headers;
      if (response.destroyed || response.writableEnded) { upstreamResponse.destroy(); return; }
      response.writeHead(upstreamResponse.statusCode ?? 502, { ...passed, "cache-control": "no-store" });
      upstreamResponse.pipe(response);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.once("error", (error) => {
      this.options.logger?.warn({ err: String(error), port, path: path.split("?")[0] }, "viewer shell proxy failed");
      if (!response.headersSent) this.sendText(response, 502, "upstream unavailable");
      else response.destroy();
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = requestTarget(request.url);
    if (!target) { socket.destroy(); return; }
    const pathname = target.pathname;
    const viewerSocket = pathname === "/viewer/socket.io" || pathname.startsWith("/viewer/socket.io/");
    const directSocket = pathname === "/socket.io" || pathname.startsWith("/socket.io/");
    if (!viewerSocket && !directSocket) {
      socket.destroy();
      return;
    }
    const upstreamPath = viewerSocket ? (request.url ?? pathname).slice("/viewer".length) : (request.url ?? pathname);
    const headers = { ...request.headers };
    delete headers[PUBLIC_VIEWER_HEADER]; delete headers[VIEWER_ADDRESS_HEADER];
    this.tunnel(socket, head, upstreamPath, headers);
  }

  private handlePublicUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = requestTarget(request.url);
    if (!url) { socket.destroy(); return; }
    const ip = addressKey(clientAddress(request, true));
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
    const headers = { ...pick(request.headers, PUBLIC_UPGRADE_HEADERS), [PUBLIC_VIEWER_HEADER]: "1", [VIEWER_ADDRESS_HEADER]: ip };
    this.tunnel(socket, head, `/socket.io/${url.search}`, headers);
  }

  private tunnel(socket: Duplex, head: Buffer, upstreamPath: string, headers: IncomingHttpHeaders): void {
    this.tunnels.add(socket);
    socket.once("close", () => this.tunnels.delete(socket));
    const upstream = connectTcp(this.options.viewerPort, "127.0.0.1", () => {
      const target = `GET ${upstreamPath} HTTP/1.1\r\n` +
        Object.entries({ ...headers, host: `127.0.0.1:${this.options.viewerPort}` })
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}\r\n`).join("") +
        "\r\n";
      upstream.write(target);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.setTimeout(65_000, () => upstream.destroy());
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
