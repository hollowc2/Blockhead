export function installViewerPreview(three: unknown, scene: unknown, view?: { camera: unknown; controls: () => unknown }): {
  show(preview: { palette: string[]; blocks: number[]; footprint?: unknown; facing?: string | null } | null): void;
  clear(): void;
  frame(target: { footprint: unknown; facing?: string | null } | null): void;
};
