import type { WorldActionLease } from "./world-actions.js";
export const PUBLIC_ACTIONS = ["hello", "wave", "look_left", "look_right"] as const;
export type PublicAction = typeof PUBLIC_ACTIONS[number];
/** The one fixed message *hello* sends. Never visitor-supplied. */
export const PUBLIC_HELLO = "Hello, everyone!";
/** Fixed effect budget: an unsettled primitive after this quarantines public actions. */
export const PUBLIC_ACTION_BUDGET_MS = 1000;
/** Capability surface intentionally excludes tasks, movement, tools and inventory. */
export interface GestureBot {
  entity: { yaw: number; pitch: number };
  chat(message: string): void;
  swingArm(arm: "right"): void;
  look(yaw: number, pitch: number, force: boolean): Promise<void>;
  once(event: "physicsTick" | "end", listener: () => void): unknown;
  removeListener(event: "physicsTick" | "end", listener: () => void): unknown;
}
/**
 * What happened to the one fixed primitive. None of these is an independently
 * observed Minecraft effect; see docs/public-gesture-enablement.md.
 *
 * - `refused`: nothing was handed to the client (admission, lease, abort or
 *   session change before the primitive started).
 * - `dispatched`: the primitive was handed to the client and settled, with the
 *   same session and no cancellation.
 * - `interrupted`: the primitive was handed to the client, then the request was
 *   cancelled or the session changed. A sent packet cannot be recalled, so this
 *   is recorded as an irreversible dispatch, never as a cancellation.
 * - `uncertain`: the primitive threw after starting or did not settle within the
 *   budget. Public actions are quarantined for the rest of the process.
 */
export type GestureDispatch = "refused" | "dispatched" | "interrupted" | "uncertain";
export type QuarantineCause = "timeout" | "primitive_error";

/**
 * True once Mineflayer's next physics tick has run: it writes queued orientation
 * synchronously after emitting the event. False if the connection ended first.
 */
function nextPhysicsTick(bot: GestureBot): Promise<boolean> {
  return new Promise(resolve => {
    const finish = (ticked: boolean): void => { bot.removeListener("physicsTick", tick); bot.removeListener("end", end); resolve(ticked); };
    const tick = (): void => finish(true), end = (): void => finish(false);
    bot.once("physicsTick", tick);
    bot.once("end", end);
  });
}

export class PublicActionController {
  private epoch = 0;
  private active = false;
  private quarantine: QuarantineCause | null = null;
  private readonly counts: Record<GestureDispatch, number> = { refused: 0, dispatched: 0, interrupted: 0, uncertain: 0 };
  constructor(private readonly options: {
    session: () => GestureBot | null;
    safe: (bot: GestureBot) => boolean;
    tryRun: (signal: AbortSignal, action: (lease: WorldActionLease) => Promise<GestureDispatch>) => Promise<GestureDispatch> | null;
    budgetMs?: number;
  }) {}
  /**
   * Quarantine is process-lifetime: it survives session replacement and
   * disabling/re-enabling actions, and is cleared only by restarting the bot
   * service after an operator has reviewed the uncertain dispatch.
   */
  diagnostics(): { active: boolean; quarantined: boolean; quarantineCause: QuarantineCause | null; dispatches: Record<GestureDispatch, number> } {
    return { active: this.active, quarantined: this.quarantine !== null, quarantineCause: this.quarantine, dispatches: { ...this.counts } };
  }
  invalidate(): void { this.epoch++; }
  available(): boolean {
    const bot = this.options.session();
    return !this.active && this.quarantine === null && bot !== null && this.options.safe(bot);
  }
  async execute(action: PublicAction, signal: AbortSignal): Promise<GestureDispatch> {
    const outcome = await this.run(action, signal);
    this.counts[outcome]++;
    return outcome;
  }
  private async run(action: PublicAction, signal: AbortSignal): Promise<GestureDispatch> {
    if (!PUBLIC_ACTIONS.includes(action) || signal.aborted || !this.available()) return "refused";
    const bot = this.options.session()!;
    const epoch = this.epoch;
    const current = (): boolean => !signal.aborted && epoch === this.epoch && bot === this.options.session();
    this.active = true;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quarantine = (cause: QuarantineCause): void => { this.quarantine ??= cause; this.invalidate(); };
    try {
      const work = this.options.tryRun(signal, async (lease) => {
        if (lease.signal.aborted || !current() || !this.options.safe(bot)) return "refused";
        // No asynchronous boundary between the last safety check and the start of the one fixed effect.
        started = true;
        let sent = true;
        try {
          switch (action) {
            case "hello": bot.chat(PUBLIC_HELLO); break;
            case "wave": bot.swingArm("right"); break;
            // A forced look only updates local orientation; Mineflayer writes the
            // packet on its next physics tick. Keep the lease until then so no
            // other owner's orientation can merge into the same packet.
            case "look_left": { const tick = nextPhysicsTick(bot); await bot.look(bot.entity.yaw + Math.PI / 4, bot.entity.pitch, true); sent = await tick; break; }
            case "look_right": { const tick = nextPhysicsTick(bot); await bot.look(bot.entity.yaw - Math.PI / 4, bot.entity.pitch, true); sent = await tick; break; }
          }
        } catch {
          quarantine("primitive_error");
          return "uncertain";
        }
        // A connection that ended before the tick may or may not have flushed it.
        return sent && current() ? "dispatched" : "interrupted";
      });
      if (work === null) { this.active = false; return "refused"; }
      // The lease and `active` stay held through actual primitive settlement,
      // even after the deadline below has answered the visitor.
      const settled = work.catch((): GestureDispatch => { if (started) { quarantine("primitive_error"); return "uncertain"; } return "refused"; })
        .finally(() => { this.active = false; });
      return await Promise.race([settled, new Promise<GestureDispatch>(resolve => {
        timer = setTimeout(() => { quarantine("timeout"); resolve("uncertain"); }, this.options.budgetMs ?? PUBLIC_ACTION_BUDGET_MS);
      })]);
    } catch {
      if (started) { quarantine("primitive_error"); return "uncertain"; }
      this.active = false;
      return "refused";
    } finally { clearTimeout(timer); }
  }
}
