import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import { dirname, extname, join, normalize, sep } from "node:path";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import { requestTarget, PUBLIC_VIEWER_HEADER, VIEWER_ADDRESS_HEADER, addressKey } from "./http-guard.js";
import { projectEquipment } from "./telemetry.js";

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
  maxPublicPerAddress?: number;
  pendingTimeoutMs?: number;
  maxBufferedBytes?: number;
  logger?: Pick<Logger, "info" | "warn">;
}

interface Vec { x: number; y: number; z: number }
type Emit = (event: string, payload?: unknown) => void;

/** Project dropped stacks without sending inventory metadata, NBT or custom names. */
export function viewerEntityPayload(bot: Bot, payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  const data = payload as Record<string, unknown>;
  if (data.delete) return payload;
  const entity = bot.entities[data.id as number];
  const name = entity?.name ?? data.name;
  if (name !== "item" && name !== "Item" && name !== "item_stack") return payload;
  let itemName: string | null = null;
  // Spawn arrives before the stack's metadata on modern servers.
  try { itemName = entity?.getDroppedItem()?.name ?? null; } catch { /* metadata pending */ }
  return { ...data, name: "item", itemName };
}

/**
 * Hides absolute world coordinates from public viewers: every position is
 * shifted by a per-process chunk-aligned offset and player names are dropped.
 */
/** Reconstruct through the installed numeric geometry serializer, never forward NBT. */
export function publicChunkJson(json: string, version: string): string {
  if (!/^1\.(?:18|19|20|21)(?:\.|$)/.test(version)) throw new Error("unsupported public chunk version");
  if (json.length > 4 * 1024 * 1024) throw new Error("oversized chunk");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (!Number.isInteger(parsed.worldHeight) || !Number.isInteger(parsed.minY) || !Array.isArray(parsed.sections) || !Array.isArray(parsed.biomes)) throw new Error("unsupported public chunk shape");
  const Chunk = require("prismarine-chunk")(version);
  // fromJson/toJson reconstructs sections, palettes and light bit arrays using known fields.
  const column = Chunk.fromJson(JSON.stringify({ ...parsed, blockEntities: {} }));
  const safe = JSON.parse(column.toJson()) as Record<string, unknown>;
  // Installed fromJson maps emptyBlockLightMask from the sky mask; retain each validated mask explicitly.
  for (const key of ["skyLightMask", "emptySkyLightMask", "blockLightMask", "emptyBlockLightMask"]) {
    const mask = parsed[key];
    if (!Array.isArray(mask) || mask.length > 64 || !mask.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isInteger))) throw new Error("unsupported light mask");
    safe[key] = mask;
  }
  return JSON.stringify(Object.fromEntries(["worldHeight", "minY", "sections", "biomes", "skyLightMask", "emptySkyLightMask", "skyLightSections", "blockLightMask", "emptyBlockLightMask", "blockLightSections"].map(key => [key, safe[key]])));
}

export function publicViewerTransform(offsetX: number, offsetZ: number, chunkProject: (json: string) => string = json => publicChunkJson(json, "1.21.4")): (event: string, payload: unknown) => unknown {
  const shift = (pos: Vec): Vec => {
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error("invalid position");
    return { x: pos.x + offsetX, y: pos.y, z: pos.z + offsetZ };
  };
  const select = (data: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter(key => data[key] !== undefined && (typeof data[key] === "number" || typeof data[key] === "boolean" || typeof data[key] === "string" && /^[a-z0-9_:. -]{1,80}$/i.test(data[key] as string) || data[key] === null)).map(key => [key, data[key]]));
  return (event, payload) => {
    if (event === "version") return typeof payload === "string" && /^1\.\d+(?:\.\d+)?$/.test(payload) ? payload : undefined;
    if (!payload || typeof payload !== "object") return undefined;
    const data = payload as Record<string, unknown>;
    switch (event) {
      case "position": return { ...select(data, ["yaw", "pitch", "addMesh"]), pos: shift(data.pos as Vec) };
      case "blockUpdate": return { ...select(data, ["stateId"]), pos: shift(data.pos as Vec) };
      case "entity": return data.delete ? { ...select(data, ["id"]), delete: true } : { ...select(data, ["id", "name", "width", "height", "pitch", "yaw", "itemName"]), ...(data.pos ? { pos: shift(data.pos as Vec) } : {}) };
      case "loadChunk": return { x: Number(data.x) + offsetX, z: Number(data.z) + offsetZ, chunk: chunkProject(String(data.chunk)) };
      case "unloadChunk": return { x: Number(data.x) + offsetX, z: Number(data.z) + offsetZ };
      case "equipment": return select(data, ["hand", "off-hand", "head", "torso", "legs", "feet"]);
      default: return undefined;
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
  private jobs: { owner: object; key: string; run: () => Promise<void>; done: () => void; promise: Promise<void> }[] = [];
  private running = false;
  private peakQueued = 0;
  stats(): { queued: number; running: number; peakQueued: number } { return { queued: this.jobs.length, running: this.running ? 1 : 0, peakQueued: this.peakQueued }; }
  run(owner: object, key: string, job: () => Promise<void>): Promise<void> {
    const existing = this.jobs.find(j => j.owner === owner && j.key === key);
    if (existing) return existing.promise;
    if (this.jobs.length >= 128) return Promise.resolve();
    let done!: () => void;
    const promise = new Promise<void>(resolve => { done = resolve; });
    this.jobs.push({ owner, key, run: job, done, promise }); this.peakQueued = Math.max(this.peakQueued, this.jobs.length); this.pump(); return promise;
  }
  cancel(owner: object): void {
    this.jobs = this.jobs.filter(j => { if (j.owner !== owner) return true; j.done(); return false; });
  }
  private pump(): void {
    if (this.running || !this.jobs.length) return;
    this.running = true;
    const job = this.jobs.shift()!;
    setTimeout(() => { void job.run().catch(() => undefined).finally(() => { job.done(); this.running = false; this.pump(); }); }, CHUNK_GAP_MS);
  }
}

/** One listener on the bot per event, regardless of admitted viewer count. */
class ViewerSubscriptions {
  private sources = new Map<object, Map<string, { listeners: Set<Function>; dispatch: (...args: unknown[]) => void }>>();
  on(source: object, event: string, listener: Function): void {
    let events = this.sources.get(source);
    if (!events) { events = new Map(); this.sources.set(source, events); }
    let entry = events.get(event);
    if (!entry) {
      const listeners = new Set<Function>();
      entry = { listeners, dispatch: (...args) => { for (const fn of [...listeners]) fn(...args); } };
      events.set(event, entry);
      (source as import("node:events").EventEmitter).on(event, entry.dispatch);
    }
    entry.listeners.add(listener);
  }
  off(source: object, event: string, listener: Function): void {
    const events = this.sources.get(source), entry = events?.get(event);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size) return;
    (source as import("node:events").EventEmitter).removeListener(event, entry.dispatch);
    events!.delete(event); if (!events!.size) this.sources.delete(source);
  }
}

interface Seat {
  public: boolean; address: string; released: boolean; joined: boolean;
  timer: NodeJS.Timeout; release: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  engine?: any;
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
  private readonly subscriptions = new ViewerSubscriptions();
  private readonly seats = new Set<Seat>();
  private readonly requests = new WeakMap<IncomingMessage, Seat>();
  private chunkCache = new Map<object, string>();
  private readonly invalidateChunks = (): void => { this.chunkCache.clear(); };
  // Cache only geometry from the shared world column; no viewer-specific data is cached.
  private readonly publicTransform = publicViewerTransform(randomChunkOffset(), randomChunkOffset(), json => json);
  private stopping = false;
  private publicSockets = 0;
  private totalSockets = 0;
  private peakBufferedBytes = 0;
  private slowDisconnects = 0;

  constructor(private readonly bot: Bot, private readonly options: ReadOnlyViewerOptions) {}

  async start(): Promise<void> {
    const http = createServer((request, response) => { void this.serveStatic(request, response).catch(() => response.destroy()); });
    http.on("clientError", (_error, socket) => socket.destroy());
    // Engine.IO wraps HTTP/upgrade listeners. Prepend validation after it is attached below.
    http.maxConnections = 128;
    http.maxHeadersCount = 64;
    http.requestTimeout = 30_000;
    http.headersTimeout = 10_000;
    this.io = new SocketServer(http, {
      path: "/socket.io",
      serveClient: false,
      maxHttpBufferSize: 4096,
      pingInterval: 20_000,
      pingTimeout: 20_000,
      allowRequest: (request: IncomingMessage, callback: (error: string | null, ok: boolean) => void) => {
        if (!requestTarget(request.url) || this.stopping) return callback("unavailable", false);
        const isPublic = request.headers[PUBLIC_VIEWER_HEADER] === "1";
        const address = isPublic ? String(request.headers[VIEWER_ADDRESS_HEADER] ?? addressKey(request.socket.remoteAddress ?? "")) : "private";
        const addressSeats = [...this.seats].filter(s => s.public && s.address === address).length;
        if (this.totalSockets >= this.options.maxConnections || isPublic && (this.publicSockets >= this.options.maxPublicConnections || addressSeats >= (this.options.maxPublicPerAddress ?? 3))) return callback("capacity", false);
        // Reserve synchronously, before Engine.IO's asynchronous handshake creates a socket.
        this.totalSockets++; if (isPublic) this.publicSockets++;
        const onAbort = (): void => seat.release();
        const seat: Seat = { public: isPublic, address, released: false, joined: false,
          timer: setTimeout(() => { seat.engine?.close(true); seat.release(); }, this.options.pendingTimeoutMs ?? 5000),
          release: () => {
            if (seat.released) return;
            seat.released = true; clearTimeout(seat.timer); request.off("aborted", onAbort);
            this.seats.delete(seat); this.totalSockets--; if (seat.public) this.publicSockets--;
          },
        };
        this.seats.add(seat); this.requests.set(request, seat);
        request.once("aborted", onAbort);
        callback(null, true);
      },
    });
    this.io.engine.use((request: IncomingMessage & { _query?: { sid?: string } }, _response: unknown, next: (error?: Error) => void) => {
      if (!requestTarget(request.url)) { next(new Error("invalid target")); return; }
      const sid = request._query?.sid;
      if (sid) {
        const engine = this.io.engine.clients[sid];
        const seat = engine ? this.requests.get(engine.request) : undefined;
        const isPublic = request.headers[PUBLIC_VIEWER_HEADER] === "1";
        if (seat && (seat.public !== isPublic || isPublic && seat.address !== String(request.headers[VIEWER_ADDRESS_HEADER] ?? addressKey(request.socket.remoteAddress ?? "")))) { next(new Error("unavailable")); return; }
      }
      next();
    });
    http.prependListener("request", (request, response) => { if (!requestTarget(request.url)) { request.url = "/__invalid_target"; response.writeHead(400); response.end(); } });
    http.prependListener("upgrade", (request, socket) => { if (!requestTarget(request.url)) { request.url = "/__invalid_target"; socket.destroy(); } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.io.engine.on("connection", (engine: any) => {
      const seat = this.requests.get(engine.request);
      if (!seat || seat.released) { engine.close(true); return; }
      seat.engine = engine;
      engine.once("close", seat.release);
    });
    this.io.engine.on("connection_error", ({ req }: { req: IncomingMessage }) => this.requests.get(req)?.release());
    for (const event of ["blockUpdate", "chunkColumnLoad", "chunkColumnUnload"]) this.subscriptions.on(this.bot, event, this.invalidateChunks);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.io.on("connection", (socket: any) => this.handleConnection(socket));
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port, this.options.host, () => { http.off("error", reject); resolve(); });
    }).catch((error: unknown) => { this.close(); throw error; });
  }

  close(): void {
    this.stopping = true;
    for (const event of ["blockUpdate", "chunkColumnLoad", "chunkColumnUnload"]) this.subscriptions.off(this.bot, event, this.invalidateChunks);
    this.invalidateChunks();
    this.io?.close();
    for (const seat of this.seats) seat.release();
    this.io = null;
    this.http?.close();
    this.http?.closeAllConnections();
    this.http = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleConnection(socket: any): void {
    const bot = this.bot;
    if (bot.entity === null || bot.entity === undefined) { socket.disconnect(true); return; }
    const seat = this.requests.get(socket.conn.request);
    if (!seat || seat.released || seat.joined || this.stopping) { socket.disconnect(true); return; }
    seat.joined = true; clearTimeout(seat.timer);
    const isPublic = seat.public;
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

    const emit: Emit = (event, payload) => {
      if (closed) return;
      // Include Engine.IO's pending packets plus the actual WebSocket transport buffer.
      const buffered = socket.conn.writeBuffer.reduce((sum: number, packet: { data?: string | Buffer }) => sum + (typeof packet.data === "string" ? Buffer.byteLength(packet.data) : packet.data?.length ?? 0), 0) + (socket.conn.transport.socket?.bufferedAmount ?? 0);
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, buffered);
      if (buffered > (this.options.maxBufferedBytes ?? 4 * 1024 * 1024) || socket.conn.writeBuffer.length > 128) { this.slowDisconnects++; socket.disconnect(true); return; }
      try {
        const projected = event === "entity" ? viewerEntityPayload(bot, payload) : payload;
        const safe = isPublic ? this.publicTransform(event, projected) : projected;
        if (safe !== undefined) socket.emit(event, safe);
      } catch { socket.disconnect(true); }
    };
    // WorldView subscribes to its emitter for `mouseClick`; this emitter has
    // no inbound side, so that handler is never registered.
    const outbound = { emit: (event: string, payload?: unknown) => { if (!closed) emit(event, payload); return true; }, on: () => outbound };
    const abortChunks = new AbortController();
    const world = { getColumnAt: async (pos: Vec) => {
      let timer: NodeJS.Timeout | undefined;
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("chunk cancelled"));
        abortChunks.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("chunk unavailable")), 2000);
      });
      let column;
      try { column = await Promise.race([bot.world.getColumnAt(pos as never), cancelled]); }
      finally { clearTimeout(timer); abortChunks.signal.removeEventListener("abort", abort); }
      if (!column || closed) return null;
      if (!isPublic) return column;
      let json = this.chunkCache.get(column);
      if (!json) { json = publicChunkJson(column.toJson(), bot.version); if (this.chunkCache.size >= 64) this.chunkCache.delete(this.chunkCache.keys().next().value!); this.chunkCache.set(column, json); }
      return { toJson: () => json };
    } };
    const worldView = new WorldView(world, this.options.viewDistance, bot.entity.position, outbound);
    const originalLoadChunk = worldView.loadChunk.bind(worldView);
    worldView.loadChunk = (pos: Vec) => closed ? Promise.resolve() : this.chunks.run(socket, `${pos.x},${pos.z}`, () => closed ? Promise.resolve() : originalLoadChunk(pos).catch(() => socket.disconnect(true)));
    // Upstream loads five chunks at a time; the shared queue already paces them.
    worldView._loadChunks = async (positions: Vec[]) => {
      for (const pos of positions) {
        if (closed) return;
        await worldView.loadChunk(pos);
      }
    };

    let lastEquipment = "";
    const botEquipment = (): void => {
      const equipment = Object.fromEntries(Object.entries(projectEquipment(bot)).map(([slot, item]) => [slot, item?.name ?? null]));
      const signature = JSON.stringify(equipment);
      if (signature === lastEquipment) return;
      lastEquipment = signature;
      emit("equipment", equipment);
    };
    // Our own worn gear comes from inventory slots, not entity_equipment packets.
    // Listen even while stationary, and send a fresh snapshot to every new viewer.
    const inventory = bot.inventory;
    this.subscriptions.on(inventory, "updateSlot", botEquipment);
    this.subscriptions.on(bot, "heldItemChanged", botEquipment);
    this.subscriptions.on(bot, "spawn", botEquipment);
    const droppedItemUpdate = (entity: Bot["entity"]): void => {
      if (entity.name !== "item" && entity.name !== "Item" && entity.name !== "item_stack") return;
      emit("entity", { id: entity.id, name: entity.name, pos: entity.position });
    };
    this.subscriptions.on(bot, "entityUpdate", droppedItemUpdate);
    let updating = false;
    let updateAgain = false;
    const updateWorld = async (): Promise<void> => {
      if (updating) { updateAgain = true; return; }
      updating = true;
      try { do { updateAgain = false; if (closed) return; await worldView.updatePosition(bot.entity.position); } while (updateAgain && !closed); }
      finally { updating = false; }
    };
    const botPosition = (): void => {
      if (bot.entity === null || bot.entity === undefined) return;
      emit("position", { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch, addMesh: true });
      void updateWorld().catch(() => socket.disconnect(true));
    };
    this.subscriptions.on(bot, "move", botPosition);

    const botView = new Proxy(bot, { get: (target, property) => {
      // WorldView emits the entire entity snapshot synchronously. A populated
      // world can fill a healthy connection's packet queue before I/O can run.
      // Attach its live listeners now, then send that snapshot in paced batches.
      if (property === "entities") return {};
      if (property === "on") return (event: string, listener: Function) => { this.subscriptions.on(bot, event, listener); return botView; };
      if (property === "removeListener") return (event: string, listener: Function) => { this.subscriptions.off(bot, event, listener); return botView; };
      return Reflect.get(target, property);
    } });
    let worldListening = false;
    socket.on("disconnect", () => {
      closed = true;
      abortChunks.abort();
      this.chunks.cancel(socket);
      seat.release();
      this.subscriptions.off(bot, "move", botPosition);
      this.subscriptions.off(inventory, "updateSlot", botEquipment);
      this.subscriptions.off(bot, "heldItemChanged", botEquipment);
      this.subscriptions.off(bot, "spawn", botEquipment);
      this.subscriptions.off(bot, "entityUpdate", droppedItemUpdate);
      if (worldListening) worldView.removeListenersFromBot(botView);
    });
    emit("version", bot.version);
    if (closed) return;
    worldListening = true;
    worldView.listenToBot(botView);
    botEquipment();
    void worldView.init(bot.entity.position).catch(() => socket.disconnect(true));
    botPosition();
    const sendInitialEntities = async (): Promise<void> => {
      const deadline = Date.now() + 5000;
      let count = 0;
      for (const id in bot.entities) {
        if (closed) return;
        const entity = bot.entities[id];
        if (!entity || entity === bot.entity) continue;
        emit("entity", { id: entity.id, name: entity.name, pos: entity.position, width: entity.width, height: entity.height, username: entity.username });
        if (++count % 32 !== 0) continue;
        // Yield for both WebSocket writes and the next polling request. Do not
        // retain an extra per-viewer copy of the world's entities or an unbounded
        // queue while waiting for a slow or abandoned receiver.
        do {
          await new Promise(resolve => setTimeout(resolve, 4));
          if (closed) return;
          if (Date.now() >= deadline) { this.slowDisconnects++; socket.disconnect(true); return; }
        } while (socket.conn.writeBuffer.length > 0);
      }
    };
    void sendInitialEntities().catch(() => socket.disconnect(true));
  }

  resources(): { chunks: ReturnType<ChunkQueue["stats"]>; peakBufferedBytes: number; slowDisconnects: number } {
    return { chunks: this.chunks.stats(), peakBufferedBytes: this.peakBufferedBytes, slowDisconnects: this.slowDisconnects };
  }

  diagnostics(): { pending: number; total: number; public: number } {
    return { pending: [...this.seats].filter(s => !s.joined).length, total: this.totalSockets, public: this.publicSockets };
  }

  private async serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = requestTarget(request.url);
    if (!target) { response.writeHead(400); response.end(); return; }
    const pathname = target.pathname;
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
      if (response.destroyed || response.writableEnded || response.headersSent) return;
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": String(info.size),
        "cache-control": extname(file) === ".js" || extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
      });
      createReadStream(file).on("error", () => response.destroy()).pipe(response);
    } catch {
      notFound();
    }
  }
}
