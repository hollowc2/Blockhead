import { z } from "zod";

/**
 * Typed records from tools/gesture-observer (a server-side Java agent). Every
 * record is private evidence: it can carry Bob's pose, so it never reaches
 * public state, logs or the viewer. Unknown types/fields fail parsing.
 */
const base = { v: z.literal(1), run: z.uuid(), seq: z.int().nonnegative(), tick: z.int().nonnegative(), ms: z.int().nonnegative() };
const finite = z.number().refine(Number.isFinite);

export const statusRecord = z.object({ ...base, type: z.literal("status"), agent: z.string().max(16), mc: z.string().max(32).nullable(),
  supported: z.boolean(), complete: z.boolean(), unhooked: z.boolean(), failure: z.string().max(128).nullable(),
  hooks: z.record(z.string().max(32), z.string().max(32)) }).strict();
export const tickRecord = z.object({ ...base, type: z.literal("tick"), bob: z.object({ conn: z.int(), entity: z.int(), removed: z.boolean(),
  x: finite, y: finite, z: finite, yaw: finite, pitch: finite }).strict().nullable() }).strict();
export const lifecycleRecord = z.object({ ...base, type: z.literal("lifecycle"), event: z.enum(["entity_changed", "login", "respawn", "death", "disconnect"]),
  conn: z.int().optional(), entity: z.int().nullable().optional() }).strict();
export const packetRecord = z.object({ ...base, type: z.literal("packet"), kind: z.string().max(64).regex(/^[A-Za-z$]+$/),
  hasPos: z.boolean().optional(), hasRot: z.boolean().optional(), yaw: finite.optional(), pitch: finite.optional(),
  fixedHello: z.boolean().optional(), hand: z.enum(["main", "off", "unknown"]).optional() }).strict();
export const EFFECTS = ["chat", "swing_call", "animate_broadcast", "attack", "interact", "use_item", "use_item_on", "drop", "open_menu",
  "force_rotation", "block_action", "destroy_block", "correction", "damage_taken", "damage_dealt"] as const;
export const effectRecord = z.object({ ...base, type: z.literal("effect"), effect: z.enum(EFFECTS), fixedHello: z.boolean().optional(),
  hand: z.enum(["main", "off", "unknown"]).optional(), action: z.int().optional(), self: z.boolean().optional(), recipients: z.int().optional() }).strict();
export const overflowRecord = z.object({ ...base, type: z.literal("overflow"), dropped: z.int().positive() }).strict();
export const faultRecord = z.object({ ...base, type: z.literal("fault"), where: z.string().max(32) }).strict();
export const endRecord = z.object({ ...base, type: z.literal("end"), reason: z.enum(["timeout", "client", "unhooked", "interrupted"]),
  dropped: z.int().nonnegative(), faults: z.int().nonnegative(), hookCalls: z.int().nonnegative(), hookNanos: z.int().nonnegative() }).strict();

export const observerRecord = z.discriminatedUnion("type", [statusRecord, tickRecord, lifecycleRecord, packetRecord, effectRecord, overflowRecord, faultRecord, endRecord]);
export type ObserverRecord = z.infer<typeof observerRecord>;
export type StatusRecord = z.infer<typeof statusRecord>;
export type TickRecord = z.infer<typeof tickRecord>;

/** Bounds for one capture: a 300-second arm at 20 ticks/s plus packets fits well inside. */
export const CAPTURE_LIMITS = { maxLineBytes: 2048, maxRecords: 30_000 } as const;

/** Parses one NDJSON line; null for anything malformed or not in the schema. */
export function parseObserverLine(line: string): ObserverRecord | null {
  if (Buffer.byteLength(line) > CAPTURE_LIMITS.maxLineBytes) return null;
  try { const parsed = observerRecord.safeParse(JSON.parse(line)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
