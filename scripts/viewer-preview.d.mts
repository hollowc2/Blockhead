export function installViewerPreview(three: unknown, scene: unknown): {
  show(preview: { palette: string[]; blocks: number[]; footprint?: unknown; facing?: string | null } | null): void;
  clear(): void;
};
