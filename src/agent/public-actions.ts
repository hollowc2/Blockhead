import type { WorldActionLease } from "./world-actions.js";
export const PUBLIC_ACTIONS = ["hello", "wave", "look_left", "look_right"] as const;
export type PublicAction = typeof PUBLIC_ACTIONS[number];
/** Capability surface intentionally excludes tasks, movement, tools and inventory. */
export interface GestureBot {
  entity: { yaw: number; pitch: number };
  chat(message: string): void;
  swingArm(arm: "right"): void;
  look(yaw: number, pitch: number, force: boolean): Promise<void>;
}
export class PublicActionController {
  private epoch = 0;
  private active = false;
  private quarantined = false;
  constructor(private readonly options: {
    session: () => GestureBot | null;
    safe: (bot: GestureBot) => boolean;
    tryRun: (signal: AbortSignal, action: (lease: WorldActionLease) => Promise<boolean>) => Promise<boolean> | null;
  }) {}
  diagnostics(): { active: boolean; quarantined: boolean } { return { active: this.active, quarantined: this.quarantined }; }
  invalidate(): void { this.epoch++; }
  available(): boolean {
    const bot = this.options.session();
    return !this.active && !this.quarantined && bot !== null && this.options.safe(bot);
  }
  async execute(action: PublicAction, signal: AbortSignal): Promise<boolean> {
    if (!PUBLIC_ACTIONS.includes(action) || signal.aborted || !this.available()) return false;
    const bot = this.options.session()!;
    const epoch = this.epoch;
    this.active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.options.tryRun(signal, async (lease) => {
        if (signal.aborted || lease.signal.aborted || epoch !== this.epoch || bot !== this.options.session() || !this.options.safe(bot)) return false;
        // No asynchronous boundary between last safety check and the one fixed effect.
        switch (action) {
          case "hello": bot.chat("Hello, everyone!"); break;
          case "wave": bot.swingArm("right"); break;
          case "look_left": await bot.look(bot.entity.yaw + Math.PI / 4, bot.entity.pitch, true); break;
          case "look_right": await bot.look(bot.entity.yaw - Math.PI / 4, bot.entity.pitch, true); break;
          default: return false;
        }
        return !signal.aborted && epoch === this.epoch && bot === this.options.session();
      });
      if (work === null) return false;
      // The lease stays held through actual primitive settlement, even after a deadline.
      const settled = work.finally(() => { this.active = false; });
      void settled.catch(() => undefined);
      return await Promise.race([settled, new Promise<false>(resolve => {
        timer = setTimeout(() => { this.quarantined = true; this.invalidate(); resolve(false); }, 1000);
      })]);
    } catch { return false; }
    finally { clearTimeout(timer); if (!this.quarantined) this.active = false; }
  }
}
