import { EventEmitter } from "node:events";
import type { GestureBot } from "./public-actions.js";

/**
 * Test double with Mineflayer's gesture timing: chat and swing write at once,
 * a forced look changes local orientation and is written on the next physics
 * tick (emitted on a later turn unless *manualTicks*).
 */
export function fakeGestureBot(effects: unknown[] = [], options: { manualTicks?: boolean; yaw?: number; pitch?: number } = {}): GestureBot & EventEmitter {
  const bot = Object.assign(new EventEmitter(), {
    entity: { yaw: options.yaw ?? 2, pitch: options.pitch ?? 0.3 },
    chat: (text: string) => { effects.push(["chat", text]); },
    swingArm: (arm: "right") => { effects.push(["swing", arm]); },
    look: async (yaw: number, pitch: number, force: boolean) => {
      effects.push(["look", yaw, pitch, force]);
      bot.entity.yaw = yaw; bot.entity.pitch = pitch;
      if (!options.manualTicks) setImmediate(() => bot.emit("physicsTick"));
    },
  });
  return bot;
}
