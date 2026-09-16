import { mineflayer as prismarineViewer } from "prismarine-viewer";
import { createServer } from "node:net";
import type { Bot } from "mineflayer";
import type { ViewerAdapter, ViewerHandle } from "./viewer.js";

/** Production adapter for the documented prismarine-viewer Mineflayer API. */
export const prismarineViewerAdapter: ViewerAdapter = {
  async start(bot: Bot, options) {
    await assertPortAvailable(options.port);
    prismarineViewer(bot, options);
    const viewer = (bot as Bot & { viewer?: ViewerHandle }).viewer;
    if (viewer === undefined) throw new Error("viewer did not attach to bot");
    return viewer;
  },
};

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "0.0.0.0", () => probe.close((error) => error ? reject(error) : resolve()));
  });
}
