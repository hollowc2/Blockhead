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
    this.stream.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
    );
  }

  close(): void {
    this.stream.end();
  }
}
