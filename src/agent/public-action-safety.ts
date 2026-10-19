import type { Bot } from "mineflayer";
/** Fresh Mineflayer facts only. Missing safety observations refuse admission. */
export function safePublicPhysicalState(bot: Bot, retreat: number): boolean {
  const entity = bot.entity as typeof bot.entity & { isInWater?: boolean; isInLava?: boolean };
  return entity != null && entity.onGround === true && entity.isInWater === false && entity.isInLava === false
    && Number.isFinite(entity.yaw) && Number.isFinite(entity.pitch)
    && Math.hypot(entity.velocity?.x, entity.velocity?.z) < 0.01 && Math.abs(entity.velocity?.y) < 0.1
    && bot.health > retreat && bot.food > 8 && bot.isSleeping === false && !entity.vehicle
    && bot.usingHeldItem === false && bot.autoEat?.isEating === false && bot.targetDigBlock == null
    && bot.currentWindow == null && bot.pvp?.target == null
    && bot.controlState != null && Object.values(bot.controlState).every(value => value === false)
    && bot.pathfinder?.isMoving() === false && bot.pathfinder?.isMining() === false && bot.pathfinder?.isBuilding() === false
    && bot.pathfinder.goal == null;
}
