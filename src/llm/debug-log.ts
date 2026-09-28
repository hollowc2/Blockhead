import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Append-only JSONL debug stream (spec 32.2). Must capture the exact state
 * snapshot sent to the LLM plus the raw response, for reproducing bad
 * decisions. Secrets must never be written here.
 */
export class DebugLog {
  private readonly stream: WriteStream;

  constructor(path = "logs/blockhead-debug.jsonl") {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    this.stream = createWriteStream(abs, { flags: "a" });
  }

  write(entry: Record<string, unknown>): void {
    // A decision still in flight at shutdown must not "write after end".
    if (this.stream.writableEnded) return;
    this.stream.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
    );
  }

  /** End the stream; resolves once buffered entries reach the file. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stream.writableFinished) { resolve(); return; }
      this.stream.end(() => resolve());
    });
  }
}
