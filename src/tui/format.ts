/**
 * Pure display formatters for the Phase 12 dashboard (spec 33). Every
 * function maps a primitive to a short human line; none of them touch I/O,
 * so the panel renderers and the dashboard stay unit-testable.
 */

/** Wall-clock delta as a relative age ("1.1 sec ago", "3 min ago"). */
export function age(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.round(ms)} ms ago`;
  if (seconds < 60) return `${round1(seconds)} sec ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  return `${round1(hours)} hr ago`;
}

/** A duration in milliseconds ("742 ms", "1.2 s", "41 s"). */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${round1(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** One-decimal number without trailing noise (0.15 -> "0.2"). */
export function round1(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

/** Distance in blocks as "18m" or "1.2km" (spec 33 event examples). */
export function meters(blocks: number): string {
  if (!Number.isFinite(blocks)) return "?";
  if (blocks < 1000) return `${Math.round(blocks)}m`;
  return `${round1(blocks / 1000)}km`;
}

/** A position as "184, 67, -291" (spec 33). Null -> "--". */
export function position(p: { x: number; y: number; z: number } | null): string {
  if (p === null) return "--";
  const n = (v: number): string => (Number.isInteger(v) ? `${v}` : String(Math.round(v * 10) / 10));
  return `${n(p.x)}, ${n(p.y)}, ${n(p.z)}`;
}

/** "overworld" -> "Overworld"; null -> "--". */
export function dimensionLabel(dimension: string | null): string {
  if (dimension === null) return "--";
  return dimension.charAt(0).toUpperCase() + dimension.slice(1).replace(/_/g, " ");
}

/** "day" -> "Day"; "night" -> "Night"; null -> "--". */
export function timePhaseLabel(phase: "day" | "night" | null): string {
  if (phase === null) return "--";
  return phase === "day" ? "Day" : "Night";
}

/** Underscore-separated minecraft name -> "Iron Pickaxe". */
export function titleCase(name: string): string {
  return name
    .replace(/^minecraft:/, "")
    .split("_")
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() : "") + word.slice(1))
    .join(" ");
}

/** Cut a line to `max` characters, appending an ellipsis when truncated. */
export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Strip ANSI SGR sequences so a colored line still measures by visible width. */
export function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a label column: `label` left-justified in `width`, then the value. */
export function field(label: string, value: string, width = 10): string {
  return `${label.padEnd(width)}${value}`;
}