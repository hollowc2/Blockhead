/** Observed-result contracts for mutation-producing operations. */
export type MutationStatus = "COMPLETE" | "PARTIAL" | "FAILED" | "NO_OP" | "ALREADY_SATISFIED";

export interface ObservedDelta {
  before: number;
  after: number;
  delta: number;
  requested: number;
  status: MutationStatus;
}

/** Classify only what was observed; never treat a zero delta as success. */
export function observedDelta(before: number, after: number, requested: number): ObservedDelta {
  const delta = Math.max(0, after - before);
  const target = Math.max(0, requested);
  const status: MutationStatus = delta === 0
    ? (before >= target && target > 0 ? "ALREADY_SATISFIED" : "NO_OP")
    : delta >= target ? "COMPLETE" : "PARTIAL";
  return { before, after, delta, requested: target, status };
}

/** Classify a transfer from independent source removal and destination gain. */
export function observedTransfer(beforeSource: number, afterSource: number, beforeTarget: number, afterTarget: number, requested: number): ObservedDelta {
  const moved = Math.max(0, Math.min(Math.max(0, beforeSource - afterSource), Math.max(0, afterTarget - beforeTarget)));
  return { before: 0, after: moved, delta: moved, requested: Math.max(0, requested), status: moved === 0 ? "NO_OP" : moved >= requested ? "COMPLETE" : "PARTIAL" };
}
