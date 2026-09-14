import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MinecraftConfigSchema, type MinecraftConfig } from "./schema.js";

export function loadConfig(path: string): MinecraftConfig {
  const raw = readFileSync(resolve(path), "utf8");
  return MinecraftConfigSchema.parse(parse(raw));
}