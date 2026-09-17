import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const SHELL_HTML = fileURLToPath(new URL("./public/viewer-shell.html", import.meta.url));
const SHELL_CSS = fileURLToPath(new URL("./public/viewer-shell.css", import.meta.url));
const SHELL_JS = fileURLToPath(new URL("./public/viewer-shell.js", import.meta.url));

export interface ViewerShellOptions {
  host: string;
  port: number;
  viewerPort: number;
  statsPort: number;
  logger?: Logger;
}

/** Hosts the combined third-person viewer page while proxying viewer traffic. */
export class ViewerShellServer {
  private server: Server | null = null;

  constructor(private readonly options: ViewerShellOptions) {}

  async start(): Promise<void> {
    if (this.server !== null) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
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
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end("method not allowed");
      return;
    }
    if (pathname === "/") {
      await this.sendFile(response, SHELL_HTML, "text/html; charset=utf-8");
      return;
    }
    if (pathname === "/viewer-shell.css") {
      await this.sendFile(response, SHELL_CSS, "text/css; charset=utf-8");
      return;
    }
    if (pathname === "/viewer-shell.js") {
      await this.sendFile(response, SHELL_JS, "text/javascript; charset=utf-8");
      return;
    }
    if (pathname === "/api/state") {
      this.proxy(request, response, this.options.statsPort, "/api/state");
      return;
    }
    if (pathname === "/viewer" || pathname.startsWith("/viewer/")) {
      const targetPath = pathname === "/viewer" ? "/" : pathname.slice("/viewer".length);
      this.proxy(request, response, this.options.viewerPort, targetPath);
      return;
    }
    if (pathname.startsWith("/socket.io/")) {
      this.proxy(request, response, this.options.viewerPort, request.url ?? pathname);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }

  private async sendFile(response: ServerResponse, path: string, contentType: string): Promise<void> {
    try {
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(await readFile(path));
    } catch (error) {
      this.options.logger?.warn({ err: String(error), path }, "viewer shell asset failed");
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("asset unavailable");
    }
  }

  private proxy(request: IncomingMessage, response: ServerResponse, port: number, path: string): void {
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${port}` },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", (error) => {
      this.options.logger?.warn({ err: String(error), port, path }, "viewer shell proxy failed");
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("upstream unavailable");
    });
    request.pipe(upstream);
  }

  private handleUpgrade(request: IncomingMessage, socket: NodeJS.WritableStream, head: Buffer): void {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith("/socket.io/")) {
      socket.destroy();
      return;
    }
    const upstream = connectTcp(this.options.viewerPort, "127.0.0.1", () => {
      const target = `GET ${request.url ?? pathname} HTTP/1.1\r\n` +
        Object.entries(request.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}\r\n`).join("") +
        "\r\n";
      upstream.write(target);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
  }
}
