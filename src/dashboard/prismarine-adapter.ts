import { mineflayer as prismarineViewer } from "prismarine-viewer";
import { createServer } from "node:net";
import type { Bot } from "mineflayer";
import type { ViewerAdapter, ViewerHandle } from "./viewer.js";
import { ViewerShellServer } from "./viewer-shell.js";

/** Production adapter for the documented prismarine-viewer Mineflayer API. */
export const prismarineViewerAdapter: ViewerAdapter = {
  async start(bot: Bot, options) {
    await assertPortAvailable(options.port);
    const viewerPort = options.port + 1;
    await assertPortAvailable(viewerPort);
    const viewerOptions = {
      port: viewerPort,
      viewDistance: options.viewDistance,
      firstPerson: true,
    } as Parameters<typeof prismarineViewer>[1] & { firstPerson: boolean };
    prismarineViewer(bot, viewerOptions);
    const viewer = (bot as Bot & { viewer?: ViewerHandle }).viewer;
    if (viewer === undefined) throw new Error("viewer did not attach to bot");
    const shell = new ViewerShellServer({ host: "0.0.0.0", port: options.port, viewerPort, statsPort: options.dashboardPort });
    try {
      await shell.start();
    } catch (error) {
      viewer.close();
      throw error;
    }
    return { close: () => { shell.stop(); viewer.close(); } };
  },
};

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "0.0.0.0", () => probe.close((error) => error ? reject(error) : resolve()));
  });
}
