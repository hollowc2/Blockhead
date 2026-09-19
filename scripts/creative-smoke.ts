import { loadConfig } from "../src/config/load.js";
import { createCobbleBob } from "../src/minecraft/bot.js";
import { isCreativeMode, provideCreativeItem } from "../src/minecraft/mode.js";

const configPath = process.env.BLOCKHEAD_CONFIG ?? "config/minecraft.yaml";
const bot = createCobbleBob(loadConfig(configPath));
const stop = (code: number): void => { bot.quit("creative smoke test complete"); process.exitCode = code; };

bot.once("error", (error) => { console.error("creative smoke connection error:", error); stop(1); });
bot.once("spawn", async () => {
  try {
    if (!isCreativeMode(bot)) throw new Error("connected bot is not in creative mode");
    const result = await provideCreativeItem(bot, "stone_bricks", 1);
    if (!result.ok) throw new Error(`${result.diagnostics.finalReason} (${JSON.stringify(result.diagnostics)})`);
    await bot.equip(result.item, "hand");
    const equipped = bot.heldItem?.name.replace(/^minecraft:/, "");
    if (equipped !== "stone_bricks") throw new Error(`server did not equip stone_bricks (held=${equipped ?? "empty"})`);
    console.log("creative smoke passed: stone_bricks was server-confirmed and equipped");
    stop(0);
  } catch (error) {
    console.error("creative smoke failed:", error);
    stop(1);
  }
});
