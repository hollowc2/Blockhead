import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import { dirname, extname, join, normalize, sep } from "node:path";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { PUBLIC_VIEWER_HEADER } from "./http-guard.js";

const require = createRequire(import.meta.url);
const VIEWER_ROOT = dirname(require.resolve("prismarine-viewer/package.json"));
const viewerRequire = createRequire(join(VIEWER_ROOT, "package.json"));
const STATIC_ROOT = join(VIEWER_ROOT, "public");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { WorldView } = viewerRequire("./viewer/lib/worldView.js") as { WorldView: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Server: SocketServer } = viewerRequire("socket.io") as { Server: any };

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};
/** Inbound packets tolerated per window before a flooding client is dropped. */
const MAX_DROPPED_INBOUND = 30;
const DROPPED_WINDOW_MS = 10_000;
/** Pause between chunk serializations so viewers never monopolize the bot's event loop. */
const CHUNK_GAP_MS = 4;

export interface ReadOnlyViewerOptions {
  host: string;
  port: number;
  viewDistance: number;
  /** Concurrent sockets allowed from the public listener. */
  maxPublicConnections: number;
  /** Concurrent sockets allowed in total (tailnet + public). */
  maxConnections: number;
  logger?: Pick<Logger, "info" | "warn">;
}

interface Vec { x: number; y: number; z: number }
type Emit = (event: string, payload?: unknown) => void;

/**
 * Hides absolute world coordinates from public viewers: every position is
 * shifted by a per-process chunk-aligned offset and player names are dropped.
 */
export function publicViewerTransform(offsetX: number, offsetZ: number): (event: string, payload: unknown) => unknown {
  const shift = (pos: Vec | undefined): Vec | undefined =>
    pos === undefined || pos === null ? pos : { x: pos.x + offsetX, y: pos.y, z: pos.z + offsetZ };
  return (event, payload) => {
    if (payload === null || typeof payload !== "object") return payload;
    const data = payload as Record<string, unknown>;
    switch (event) {
      case "position":
      case "blockUpdate":
        return { ...data, pos: shift(data.pos as Vec | undefined) };
      case "entity": {
        const { username: _username, ...rest } = data;
        return "pos" in data ? { ...rest, pos: shift(data.pos as Vec | undefined) } : rest;
      }
      case "loadChunk":
      case "unloadChunk":
        return { ...data, x: (data.x as number) + offsetX, z: (data.z as number) + offsetZ };
      default:
        return payload;
    }
  };
}

/** Random offset in whole chunks, small enough to keep three.js float precision. */
export function randomChunkOffset(): number {
  const chunks = randomInt(256, 1024) * (randomInt(0, 2) === 0 ? -1 : 1);
  return chunks * 16;
}

/** Serializes chunk work across every viewer socket with a pause between jobs. */
class ChunkQueue {
  private tail: Promise<void> = Promise.resolve();
  run(job: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, CHUNK_GAP_MS));
      await job();
    }).catch(() => undefined);
    this.tail = next;
    return next;
  }
}

/** Resolves a request path inside the viewer's static bundle, or null. */
export function staticViewerFile(pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes("..")) return null;
  if (CONTENT_TYPES[extname(relative)] === undefined) return null;
  const file = normalize(join(STATIC_ROOT, relative));
  return file.startsWith(STATIC_ROOT + sep) ? file : null;
}

/**
 * Replacement for prismarine-viewer's `lib/mineflayer.js` server. It serves
 * the same browser bundle and speaks the same Socket.IO protocol, but it is
 * strictly one-way: no inbound event handler exists (the upstream server
 * raycasts on `mouseClick`), connections are capped, and chunk
 * serialization is paced so viewers cannot stall the bot.
 */
export class ReadOnlyViewerServer {
  private http: Server | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private io: any = null;
  private readonly chunks = new ChunkQueue();
  private readonly publicTransform = publicViewerTransform(randomChunkOffset(), randomChunkOffset());
  private publicSockets = 0;
  private totalSockets = 0;

  constructor(private readonly bot: Bot, private readonly options: ReadOnlyViewerOptions) {}

  async start(): Promise<void> {
    const http = createServer((request, response) => { void this.serveStatic(request, response); });
    http.requestTimeout = 30_000;
    http.headersTimeout = 10_000;
    this.io = new SocketServer(http, {
      path: "/socket.io",
      serveClient: false,
      maxHttpBufferSize: 4096,
      pingInterval: 20_000,
      pingTimeout: 20_000,
      allowRequest: (request: IncomingMessage, callback: (error: string | null, ok: boolean) => void) => {
        const isPublic = request.headers[PUBLIC_VIEWER_HEADER] !== undefined;
        if (this.totalSockets >= this.options.maxConnections) return callback("viewer full", false);
        if (isPublic && this.publicSockets >= this.options.maxPublicConnections) return callback("viewer full", false);
        callback(null, true);
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.io.on("connection", (socket: any) => this.handleConnection(socket));
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port, this.options.host, () => { http.off("error", reject); resolve(); });
    });
  }

  close(): void {
    this.io?.close();
    this.io = null;
    this.http?.close();
    this.http?.closeAllConnections();
    this.http = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleConnection(socket: any): void {
    const bot = this.bot;
    if (bot.entity === null || bot.entity === undefined) { socket.disconnect(true); return; }
    const isPublic = socket.handshake.headers[PUBLIC_VIEWER_HEADER] !== undefined;
    this.totalSockets += 1;
    if (isPublic) this.publicSockets += 1;
    let closed = false;
    let dropped = 0;
    let windowStart = Date.now();

    // Every inbound packet stops here: next() is never called, so no event
    // handler can run, and a client that floods is disconnected.
    socket.use((_packet: unknown, _next: unknown) => {
      if (Date.now() - windowStart > DROPPED_WINDOW_MS) { windowStart = Date.now(); dropped = 0; }
      dropped += 1;
      if (dropped > MAX_DROPPED_INBOUND) socket.disconnect(true);
    });

    const emit: Emit = isPublic
      ? (event, payload) => socket.emit(event, this.publicTransform(event, payload))
      : (event, payload) => socket.emit(event, payload);
    // WorldView subscribes to its emitter for `mouseClick`; this emitter has
    // no inbound side, so that handler is never registered.
    const outbound = { emit: (event: string, payload?: unknown) => { if (!closed) emit(event, payload); return true; }, on: () => outbound };
    const worldView = new WorldView(bot.world, this.options.viewDistance, bot.entity.position, outbound);
    const originalLoadChunk = worldView.loadChunk.bind(worldView);
    worldView.loadChunk = (pos: Vec) => closed ? Promise.resolve() : this.chunks.run(() => closed ? Promise.resolve() : originalLoadChunk(pos));
    // Upstream loads five chunks at a time; the shared queue already paces them.
    worldView._loadChunks = async (positions: Vec[]) => {
      for (const pos of positions) {
        if (closed) return;
        await worldView.loadChunk(pos);
      }
    };

    emit("version", bot.version);
    void worldView.init(bot.entity.position).catch(() => undefined);
    const botPosition = (): void => {
      if (bot.entity === null || bot.entity === undefined) return;
      emit("position", { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true });
      void worldView.updatePosition(bot.entity.position).catch(() => undefined);
    };
    bot.on("move", botPosition);
    worldView.listenToBot(bot);
    botPosition();

    socket.on("disconnect", () => {
      closed = true;
      this.totalSockets -= 1;
      if (isPublic) this.publicSockets -= 1;
      bot.removeListener("move", botPosition);
      worldView.removeListenersFromBot(bot);
    });
  }

  private async serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = request.method === "GET" ? staticViewerFile(pathname) : null;
    const notFound = (): void => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    };
    if (file === null) { notFound(); return; }
    try {
      const info = await stat(file);
      if (!info.isFile()) { notFound(); return; }
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": String(info.size),
        "cache-control": "public, max-age=3600",
      });
      createReadStream(file).on("error", () => response.destroy()).pipe(response);
    } catch {
      notFound();
    }
  }
}
