export class ViewerSession {
  constructor(options: any);
  state: string; mode: string; token: string | null; source: unknown; attempt: number;
  update(state: any): void;
  message(source: unknown, origin: string, data: unknown): boolean;
  open(): void; retry(): void; setMode(mode: string): void; pause(): void; visibility(visible: boolean): void; stop(): void;
}
export function retryUntil(startedAt: number, receivedAt: number, wait: unknown): number;

export function frameToken(): string;
