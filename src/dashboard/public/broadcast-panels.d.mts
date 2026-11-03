export const DAY_SECONDS: number;
export const NIGHT_SECONDS: number;
export function itemLabel(name: unknown): string;
export function compact(n: unknown): string;
export function ago(iso: string, now: number): string;
export function gainedItems(previous: ReadonlyMap<string, number> | null, items: ReadonlyArray<{ name: string; count: number }>): Set<string>;
export interface Tier { id: "wood" | "stone" | "iron" | "diamond" | "nether"; label: string; texture: string }
export const TIERS: readonly Tier[];
export function progression(state: unknown): { tiers: Array<Tier & { reached: boolean }>; current: Tier["id"] | null };
export function armorMaterial(name: unknown): string | null;
export function dayDial(input: { phase: unknown; story?: ReadonlyArray<{ icon?: string; at?: string }>; observedFlipAt?: number | null; now: number }): { phase: "day" | "night" | null; angle: number; remaining: number | null; label: string };
export function iconRow(value: unknown): Array<"full" | "half" | "empty">;
