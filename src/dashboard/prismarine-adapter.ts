import { randomUUID } from "node:crypto";
import type { PublicInteractions } from "./public-interactions.js";
import { createServer } from "node:net";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { ViewerAdapter } from "./viewer.js";
import { ViewerShellServer, type PrivateApi } from "./viewer-shell.js";
import type { ViewerChatResult } from "./viewer-chat.js";
import { ReadOnlyViewerServer } from "./viewer-server.js";

export interface PrismarineAdapterOptions {
  /** Bind address for the tailnet shell and the raw viewer server. */
  host: string;
  /** Loopback-only listener that Tailscale Funnel exposes; null disables it. */
  publicViewer: { port: number; maxConnections: number } | null;
  publicInteractions?: PublicInteractions;
  publicState: () => Promise<unknown>;
  /** Viewer Q&A for the private shell only; the public shell never gets it. */
  chat?: (question: unknown) => Promise<ViewerChatResult>;
  command?: (command: unknown) => Promise<ViewerChatResult>;
  /** Jobs, build preview, history and map for the private shell only. */
  privateApi?: PrivateApi;
  logger?: Pick<Logger, "info" | "warn">;
}

/** The public status shell survives bot sessions; renderer and private shell are session scoped. */
export interface PrismarineViewerAdapter extends ViewerAdapter {
  startPublicShell(options: { port: number; dashboardPort: number }): Promise<void>;
  close(): void;
  diagnostics(): unknown;
}
export function createPrismarineViewerAdapter(adapterOptions: PrismarineAdapterOptions): PrismarineViewerAdapter {
  let publicShell: ViewerShellServer | null = null;
  let publicStart: Promise<void> | null = null;
  let viewerSession = randomUUID();
  let closed = false;
  let publicReady = false;
  const handles = new Set<{ close(): void }>();
  let activeViewer: ReadOnlyViewerServer | null = null;
  const adapter: PrismarineViewerAdapter = {
    async startPublicShell(options) {
      if (closed || !adapterOptions.publicViewer) return;
      if (publicStart) return publicStart;
      const port = adapterOptions.publicViewer.port;
      if ([options.port, options.port + 1, options.dashboardPort].includes(port)) throw new Error("public viewer port must be separate");
      const shell = new ViewerShellServer({ host: "127.0.0.1", port, viewerPort: options.port + 1, statsPort: options.dashboardPort, mode: "public",
        publicState: async () => {
          const state = await adapterOptions.publicState() as Record<string, unknown>;
          return { ...state, viewer: { ...(state.viewer as object), session: viewerSession } };
        }, publicInteractions: adapterOptions.publicInteractions, logger: adapterOptions.logger,
      });
      publicShell = shell;
      publicStart = shell.start().then(() => { publicReady = true; if (closed) shell.stop(); }).catch((error: unknown) => { shell.stop(); if (publicShell === shell) { publicShell = null; publicStart = null; publicReady = false; } throw error; });
      return publicStart;
    },
    async start(bot: Bot, options) {
      if (closed) throw new Error("viewer adapter closed");
      await adapter.startPublicShell(options);
      const viewerPort = options.port + 1;
      viewerSession = randomUUID();
      await assertPortAvailable(options.port, adapterOptions.host);
      await assertPortAvailable(viewerPort, "127.0.0.1");
      const viewer = new ReadOnlyViewerServer(bot, { host: "127.0.0.1", port: viewerPort, viewDistance: options.viewDistance,
        maxPublicConnections: adapterOptions.publicViewer?.maxConnections ?? 0,
        maxConnections: (adapterOptions.publicViewer?.maxConnections ?? 0) + 4, logger: adapterOptions.logger,
      });
      const shell = new ViewerShellServer({ host: adapterOptions.host, port: options.port, viewerPort, statsPort: options.dashboardPort,
        chat: adapterOptions.chat, command: adapterOptions.command, privateApi: adapterOptions.privateApi, logger: adapterOptions.logger,
      });
      try { await viewer.start(); await shell.start(); }
      catch (error) { shell.stop(); viewer.close(); throw error; }
      activeViewer = viewer;
      let stopped = false;
      const handle = { close: () => {
        if (stopped) return; stopped = true;
        handles.delete(handle); shell.stop(); viewer.close(); if (activeViewer === viewer) activeViewer = null; adapterOptions.publicInteractions?.cancelAll(); viewerSession = randomUUID();
      } };
      if (closed) handle.close(); else handles.add(handle);
      return handle;
    },
    diagnostics() { return activeViewer ? { ...activeViewer.diagnostics(), ...activeViewer.resources() } : { pending: 0, total: 0, public: 0 }; },
    close() {
      closed = true;
      for (const handle of handles) handle.close();
      if (publicReady) publicShell?.stop();
      publicShell = null;
    },
  };
  return adapter;
}

function assertPortAvailable(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, host, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}
