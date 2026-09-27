import { normalizeDimension } from "../minecraft/protection.js";
import type { BlockBounds } from "../terrain/schema.js";

export type DestructiveAction = "dig" | "place_support" | "place_light";
export type DestructiveAuthorizationState = "active" | "dormant" | "revoked";
export interface AuthorizedGeometry { readonly bounds: BlockBounds; }
export interface DestructiveAuthorization {
  readonly projectId: string; readonly taskId: string; readonly worldId: string | number;
  readonly dimension: string; readonly geometryHash: string; readonly geometry: AuthorizedGeometry;
  readonly allowedActions: readonly DestructiveAction[]; readonly state: DestructiveAuthorizationState;
  readonly issuedAt: string; readonly expiresAt: string;
}
export interface MutationAuthorizationContext {
  readonly authorization: DestructiveAuthorization; readonly taskId: string; readonly projectId: string;
  readonly worldId: string | number; readonly dimension: string;
}
export interface DestructiveAuthorizationInput {
  projectId: string; taskId: string; worldId: string | number; dimension: string; geometryHash: string;
  geometry: AuthorizedGeometry; allowedActions: readonly DestructiveAction[]; issuedAt?: string; expiresAt: string;
}

function contains(bounds: BlockBounds, point: { x: number; y: number; z: number }): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY && point.z >= bounds.minZ && point.z <= bounds.maxZ;
}
function activeAt(a: DestructiveAuthorization, now: Date): boolean {
  return a.state === "active" && Date.parse(a.issuedAt) <= now.getTime() && Date.parse(a.expiresAt) > now.getTime();
}

/** Process-scoped registry; Stage 4 may replace its storage without changing callers. */
export class DestructiveAuthorizationRegistry {
  private readonly grants = new Map<string, DestructiveAuthorization>();
  issue(input: DestructiveAuthorizationInput): DestructiveAuthorization {
    const issuedAt = input.issuedAt ?? new Date().toISOString();
    if (input.projectId.trim() === "" || input.taskId.trim() === "" || input.geometryHash.trim() === "") throw new Error("authorization requires project, task, and geometry ids");
    if (input.allowedActions.length === 0 || !Number.isFinite(Date.parse(issuedAt)) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(issuedAt)) throw new Error("authorization has invalid actions or timestamps");
    const authorization: DestructiveAuthorization = { ...input, dimension: normalizeDimension(input.dimension), allowedActions: [...new Set(input.allowedActions)], state: "active", issuedAt };
    this.grants.set(input.taskId, authorization);
    return authorization;
  }
  get(taskId: string): DestructiveAuthorization | null { return this.grants.get(taskId) ?? null; }
  contextFor(taskId: string, projectId: string, worldId: string | number, dimension: string, now = new Date()): MutationAuthorizationContext | null {
    const authorization = this.get(taskId);
    if (authorization === null || authorization.projectId !== projectId || String(authorization.worldId) !== String(worldId) || authorization.dimension !== normalizeDimension(dimension) || !activeAt(authorization, now)) return null;
    return { authorization, taskId, projectId, worldId, dimension: normalizeDimension(dimension) };
  }
  setState(taskId: string, state: DestructiveAuthorizationState): boolean {
    const current = this.grants.get(taskId); if (current === undefined) return false;
    this.grants.set(taskId, { ...current, state }); return true;
  }
  revoke(taskId: string): boolean { return this.setState(taskId, "revoked"); }
  allows(context: MutationAuthorizationContext, action: DestructiveAction, point: { x: number; y: number; z: number }, worldId: string | number, dimension: string, projectId: string, taskId: string, now = new Date()): boolean {
    const a = context.authorization;
    return context.taskId === taskId && context.projectId === projectId && String(context.worldId) === String(worldId) && a.taskId === taskId && a.projectId === projectId && String(a.worldId) === String(worldId) && a.dimension === normalizeDimension(dimension) && a.allowedActions.includes(action) && activeAt(a, now) && contains(a.geometry.bounds, point);
  }
}

export function destructiveActionForMutation(action: string, blockName?: string): DestructiveAction | null {
  if (action === "dig") return "dig";
  if (action !== "place") return null;
  const bare = (blockName ?? "").replace(/^minecraft:/, "");
  return ["torch", "wall_torch", "lantern", "soul_torch", "soul_lantern"].includes(bare) ? "place_light" : "place_support";
}
