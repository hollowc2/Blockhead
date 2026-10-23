export function createViewerEquipment(three: unknown, itemTextures?: Record<string, string>): {
  update(equipment: Record<string, string | null> | null): void;
  attach(model: unknown): void;
};
