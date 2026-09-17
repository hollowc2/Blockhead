export function patchWorldRenderer(source: string, legacy: string, modern: string, path?: string): string;
export function patchWorker(source: string, path?: string): string;
export function patchViewerClient(source: string, path?: string): string;
export function patchViewerRecenterHotkey(source: string, path?: string): string;
export function patchPrismarineViewer(): Promise<void>;
