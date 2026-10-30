import { connect } from "node:net";
import { CAPTURE_LIMITS, parseObserverLine, type ObserverRecord, type StatusRecord } from "./gesture-records.js";

/** Integrity facts about a capture that the records themselves cannot show. */
export interface CaptureIntegrity { invalidLines: number; truncated: boolean; closedEarly: boolean }
export interface Capture {
  /** The agent's status line, sent before collection starts. */
  readonly ready: Promise<StatusRecord>;
  readonly records: ObserverRecord[];
  /** Asks the agent to disarm and resolves once it has sent its end record and closed. */
  stop(): Promise<CaptureIntegrity>;
  /** Resolves when the connection closes for any reason. */
  readonly closed: Promise<CaptureIntegrity>;
}

/** Arms the private observer socket for at most *seconds*. Only reads; sends ARM/DISARM lines only. */
export function armObserver(socketPath: string, seconds: number, limits: { maxLineBytes: number; maxRecords: number } = CAPTURE_LIMITS): Capture {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new RangeError("arm 1-300 s");
  const records: ObserverRecord[] = [];
  const integrity: CaptureIntegrity = { invalidLines: 0, truncated: false, closedEarly: true };
  const socket = connect(socketPath);
  const ready = Promise.withResolvers<StatusRecord>();
  const closed = Promise.withResolvers<CaptureIntegrity>();
  void ready.promise.catch(() => undefined);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(`ARM ${seconds}\n`));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const record = parseObserverLine(line);
      if (record === null) { integrity.invalidLines++; if (records.length === 0) ready.reject(new Error("observer refused or sent an invalid status")); continue; }
      if (records.length === 0) { if (record.type === "status") ready.resolve(record); else ready.reject(new Error("observer did not start with status")); }
      if (record.type === "end") integrity.closedEarly = false;
      if (records.length >= limits.maxRecords) { integrity.truncated = true; socket.destroy(); return; }
      records.push(record);
    }
    if (buffer.length > limits.maxLineBytes) { integrity.invalidLines++; integrity.truncated = true; socket.destroy(); }
  });
  socket.on("error", () => { ready.reject(new Error("observer socket error")); });
  socket.on("close", () => { ready.reject(new Error("observer closed before status")); closed.resolve(integrity); });
  return {
    ready: ready.promise, records, closed: closed.promise,
    async stop() {
      if (!socket.destroyed && socket.writable) socket.write("DISARM\n");
      const timer = setTimeout(() => socket.destroy(), 3000);
      try { return await closed.promise; } finally { clearTimeout(timer); }
    },
  };
}

/** One STATUS round trip. */
export async function observerStatus(socketPath: string, timeoutMs = 3000): Promise<StatusRecord> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("observer status timeout")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("STATUS\n"));
    socket.on("data", (chunk: string) => { buffer += chunk; if (buffer.length > CAPTURE_LIMITS.maxLineBytes) socket.destroy(); });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => {
      clearTimeout(timer);
      const record = parseObserverLine(buffer.trim());
      if (record?.type === "status") resolve(record); else reject(new Error("invalid observer status"));
    });
  });
}
