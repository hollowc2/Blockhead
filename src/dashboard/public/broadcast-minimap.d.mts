export interface MinimapShapes {
  radius: number;
  /** Degrees clockwise from north. */
  heading: number;
  /** SVG polyline points in cell units, or null when there is no line to draw. */
  trail: string | null;
  home: { x: number; y: number } | { rim: number } | null;
}
export function minimapShapes(data: unknown): MinimapShapes | null;
export function mountMinimap(slot: Element | null): void;
