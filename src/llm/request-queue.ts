/** One backend owner at a time. After three private jobs, one waiting public job may run. */
export interface CompletionOptions { signal?: AbortSignal; deadline?: number; priority?: "private" | "public" }
interface Entry { public: boolean; signal: AbortSignal; run: () => Promise<string>; resolve: (value: string) => void; reject: (error: unknown) => void; cleanup: () => void }
export class ModelQueue {
  private entries: Entry[] = [];
  private running: Entry | null = null;
  private privateStreak = 0;
  stats(): { queued: number; running: number; publicQueued: number; publicRunning: number } {
    return { queued: this.entries.length, running: this.running ? 1 : 0, publicQueued: this.entries.filter(e => e.public).length, publicRunning: this.running?.public ? 1 : 0 };
  }
  add(run: () => Promise<string>, signal: AbortSignal, isPublic: boolean): Promise<string> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.entries.length >= 64 || isPublic && (this.entries.some(e => e.public) || this.running?.public)) return Promise.reject(new Error("model queue full"));
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const i = this.entries.indexOf(entry);
        if (i < 0) return; // The running transport owns the backend until it actually settles.
        this.entries.splice(i, 1); entry.cleanup(); reject(signal.reason);
      };
      const entry: Entry = { public: isPublic, signal, run, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      this.entries.push(entry); this.pump();
    });
  }
  private pump(): void {
    if (this.running) return;
    if (!this.entries.length) { this.privateStreak = 0; return; }
    let i = this.entries.findIndex(e => !e.public);
    if (i < 0 || this.privateStreak >= 3) {
      const publicIndex = this.entries.findIndex(e => e.public);
      if (publicIndex >= 0) i = publicIndex;
    }
    if (i < 0) return;
    const entry = this.entries.splice(i, 1)[0]!;
    entry.cleanup();
    if (entry.signal.aborted) { entry.reject(entry.signal.reason); this.pump(); return; }
    this.running = entry;
    this.privateStreak = entry.public ? 0 : this.entries.some(e => e.public) ? Math.min(3, this.privateStreak + 1) : 1;
    void Promise.resolve().then(() => { entry.signal.throwIfAborted(); return entry.run(); }).then(entry.resolve, entry.reject).finally(() => { this.running = null; this.pump(); });
  }
}
export const modelQueue = new ModelQueue();
