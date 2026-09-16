import type { Bot } from "mineflayer";
import type { Logger } from "pino";

export type ViewerStatus = "enabled" | "starting" | "running" | "stopped" | "failed";

export interface ViewerTelemetry {
  enabled: boolean;
  status: ViewerStatus;
  port: number;
  distance: number;
  failure: string | null;
}

export interface ViewerHandle { close(): void }

export interface ViewerAdapter {
  start(bot: Bot, options: { port: number; viewDistance: number }): ViewerHandle | Promise<ViewerHandle>;
}

export interface ViewerManagerOptions {
  enabled: boolean;
  port: number;
  distance: number;
  adapter: ViewerAdapter;
  logger?: Pick<Logger, "warn">;
}

const conciseError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240) || "viewer startup failed";
};

/** Owns one viewer at a time and binds it to the exact Mineflayer session. */
export class ViewerManager {
  private readonly options: ViewerManagerOptions;
  private activeBot: Bot | null = null;
  private handle: ViewerHandle | null = null;
  private state: ViewerTelemetry;

  constructor(options: ViewerManagerOptions) {
    this.options = options;
    this.state = {
      enabled: options.enabled,
      status: options.enabled ? "enabled" : "stopped",
      port: options.port,
      distance: options.distance,
      failure: null,
    };
  }

  telemetry(): ViewerTelemetry { return { ...this.state }; }

  async startFor(bot: Bot): Promise<void> {
    if (!this.options.enabled) return;
    if (this.activeBot === bot) return;
    if (this.activeBot !== null) this.stopFor(this.activeBot);

    this.activeBot = bot;
    this.state = { ...this.state, status: "starting", failure: null };
    try {
      const handle = await this.options.adapter.start(bot, { port: this.options.port, viewDistance: this.options.distance });
      if (this.activeBot !== bot) {
        handle.close();
        return;
      }
      this.handle = handle;
      this.state = { ...this.state, status: "running" };
    } catch (error) {
      this.handle = null;
      this.state = { ...this.state, status: "failed", failure: conciseError(error) };
      this.options.logger?.warn({ err: this.state.failure, port: this.options.port }, "minecraft viewer startup failed");
    }
    bot.once("end", () => this.stopFor(bot));
  }

  stopFor(bot: Bot): void {
    if (this.activeBot !== bot) return;
    const handle = this.handle;
    this.activeBot = null;
    this.handle = null;
    if (handle !== null) {
      try { handle.close(); } catch (error) {
        this.options.logger?.warn({ err: conciseError(error) }, "minecraft viewer shutdown failed");
      }
    }
    this.state = { ...this.state, status: "stopped", failure: null };
  }

  stop(): void {
    if (this.activeBot !== null) this.stopFor(this.activeBot);
    else if (this.options.enabled) this.state = { ...this.state, status: "stopped", failure: null };
  }
}
