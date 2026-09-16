import type { Logger } from "pino";
import { DashboardServer } from "./server.js";
import type { DashboardSnapshot } from "./types.js";

export interface DashboardLifecycleOptions {
  enabled?: boolean;
  host: string;
  port: number;
  snapshot: () => DashboardSnapshot | Promise<DashboardSnapshot>;
  logger?: Logger;
}

/** Start the optional, process-lifetime dashboard without making it fatal. */
export function startDashboard(options: DashboardLifecycleOptions): DashboardServer | null {
  if (options.enabled === false) return null;

  const server = new DashboardServer(options);
  try {
    server.start();
    return server;
  } catch (error) {
    options.logger?.warn({ err: String(error) }, "dashboard startup failed");
    server.stop();
    return null;
  }
}
