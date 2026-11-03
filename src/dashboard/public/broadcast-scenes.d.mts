export type Scene = "normal" | "action" | "night";
/** The viewer's bob-cam modes the broadcast uses. */
export type Camera = "follow" | "eyes" | "wide" | "close";
export interface Banner { id: number; kind: "death" | "build" | "milestone" | "tier"; label: string; text: string; note: string | null; item: string | null; icon: string; until: number }
export interface Scenes {
  scene: Scene;
  sceneSince: number;
  banner: Banner | null;
  queue: ReadonlyArray<Omit<Banner, "until"> & { queuedAt: number }>;
  lowerThird: boolean;
  camera: Camera;
  cameraSince: number;
  readonly [memory: string]: unknown;
}
export const ACTION_HOLD_MS: number;
export const MIN_DWELL_MS: number;
export const NIGHT_ENTER_MS: number;
export const NIGHT_AWAY_MS: number;
export const BUILD_REARM_MS: number;
export const BANNER_MS: number;
export const BANNER_GAP_MS: number;
export const BANNER_QUEUE_MAX: number;
export const BANNER_STALE_MS: number;
export const LOWER_THIRD_MS: number;
export const LOWER_THIRD_EVERY_MS: number;
export const LOWER_THIRD_FIRST_MS: number;
export const CAMERA_SHOTS: ReadonlyArray<readonly [Camera, number]>;
export const CLOSE_HOLD_MS: number;
export const CAMERA_MIN_MS: number;
export function gearTiers(state: unknown): { tool: { rank: number; item: string | null }; armor: { rank: number; item: string | null } } | null;
export function createScenes(now: number): Scenes;
export function stepScenes(previous: Scenes, state: unknown, now: number): Scenes;
