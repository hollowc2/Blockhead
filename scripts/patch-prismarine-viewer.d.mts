export function patchWorldRenderer(source: string, legacy: string, modern: string, path?: string): string;
export function patchWorker(source: string, path?: string): string;
export function patchViewerClient(source: string, path?: string): string;
export function patchViewerRecenterHotkey(source: string, path?: string): string;
export function patchViewerCamera(source: string, path?: string): string;
export function patchMineflayerCrafting(source: string, path?: string): string;
export function patchPrismarineViewer(): Promise<void>;
export const FIRST_PERSON_V1: ReadonlyArray<readonly [string, string]>;
