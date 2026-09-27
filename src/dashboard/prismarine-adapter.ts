import { createServer } from "node:net";
import type { Bot } from "mineflayer";
import type { Logger } from "pino";
import type { ViewerAdapter } from "./viewer.js";
import { ViewerShellServer } from "./viewer-shell.js";
import { ReadOnlyViewerServer } from "./viewer-server.js";

export interface PrismarineAdapterOptions {
  /** Bind address for the tailnet shell and the raw viewer server. */
  host: string;
  /** Loopback-only listener that Tailscale Funnel exposes; null disables it. */
  publicViewer: { port: number; maxConnections: number } | null;
  publicState: () => Promise<unknown>;
  logger?: Pick<Logger, "info" | "warn">;
}

/**
 * Production adapter: the read-only viewer server on `port + 1` (loopback),
 * the full shell on `port` for the tailnet, and optionally the public shell.
 */
export function createPrismarineViewerAdapter(adapterOptions: PrismarineAdapterOptions): ViewerAdapter {
  return {
    async start(bot: Bot, options) {
      const viewerPort = options.port + 1;
      const publicPort = adapterOptions.publicViewer?.port;
      await assertPortAvailable(options.port, adapterOptions.host);
      await assertPortAvailable(viewerPort, "127.0.0.1");
      if (publicPort !== undefined) await assertPortAvailable(publicPort, "127.0.0.1");

      const viewer = new ReadOnlyViewerServer(bot, {
        host: "127.0.0.1",
        port: viewerPort,
        viewDistance: options.viewDistance,
        maxPublicConnections: adapterOptions.publicViewer?.maxConnections ?? 0,
        maxConnections: (adapterOptions.publicViewer?.maxConnections ?? 0) + 4,
        logger: adapterOptions.logger,
      });
      await viewer.start();
      const shells: ViewerShellServer[] = [
        new ViewerShellServer({ host: adapterOptions.host, port: options.port, viewerPort, statsPort: options.dashboardPort, logger: adapterOptions.logger }),
      ];
      if (publicPort !== undefined) {
        shells.push(new ViewerShellServer({
          host: "127.0.0.1",
          port: publicPort,
          viewerPort,
          statsPort: options.dashboardPort,
          mode: "public",
          publicState: adapterOptions.publicState,
          logger: adapterOptions.logger,
        }));
      }
      try {
        for (const shell of shells) await shell.start();
      } catch (error) {
        for (const shell of shells) shell.stop();
        viewer.close();
        throw error;
      }
      return { close: () => { for (const shell of shells) shell.stop(); viewer.close(); } };
    },
  };
}

function assertPortAvailable(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, host, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}
