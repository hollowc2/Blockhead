/**
 * Paces whichever source is selected (live or holding) into the encoder at a
 * constant frame rate. Holds only the latest live frame: obsolete frames are
 * replaced, never queued. Honors stdin backpressure by dropping frames until
 * 'drain', and counts every drop so a blocked encoder can't hide.
 */
export class FramePublisher {
  constructor({ fps, now }) {
    this.interval = 1000 / fps;
    this.now = now;
    this.live = null;            // { frame: Buffer, at: number, generation: number }
    this.generation = 0;         // renderer generation whose frames are accepted
    this.holding = null;         // Buffer selected by the broadcast state
    this.kind = "holding";
    this.sink = null;            // { write(buf): boolean, once('drain') }
    this.blockedSince = null;
    this.next = null;
    this.stats = { written: 0, writtenLive: 0, writtenHolding: 0, dropped: 0, skipped: 0, stale: 0 };
  }

  /** A new renderer generation invalidates every frame from the previous one. */
  setGeneration(generation) { this.generation = generation; this.live = null; }

  /** Returns false (and keeps nothing) for a frame from an obsolete renderer. */
  offerLive(frame, generation) {
    if (generation !== this.generation) { this.stats.stale++; return false; }
    this.live = { frame, at: this.now(), generation };
    return true;
  }

  liveFrameAt() { return this.live?.at ?? null; }

  select(kind, holdingFrame) { this.kind = kind; if (holdingFrame) this.holding = holdingFrame; }

  attach(sink) { this.sink = sink; this.blockedSince = null; this.next = null; }
  detach() { this.sink = null; this.blockedSince = null; }

  /** Call often (every few ms is fine). Writes the frames owed since the last call. */
  tick() {
    const now = this.now();
    this.next ??= now;
    if (now < this.next) return 0;
    // After a delayed callback, catch up by at most one extra frame; skip the rest.
    let owed = Math.floor((now - this.next) / this.interval) + 1;
    if (owed > 2) { this.stats.skipped += owed - 2; owed = 2; }
    this.next += Math.floor((now - this.next) / this.interval + 1) * this.interval;
    let wrote = 0;
    for (let i = 0; i < owed; i++) if (this.writeOne(now)) wrote++;
    return wrote;
  }

  writeOne(now) {
    const frame = this.kind === "live" ? this.live?.frame ?? this.holding : this.holding;
    if (!frame || !this.sink) return false;
    if (this.blockedSince !== null) { this.stats.dropped++; return false; }
    const ok = this.sink.write(frame);
    this.stats.written++;
    if (frame === this.holding) this.stats.writtenHolding++; else this.stats.writtenLive++;
    if (!ok) {
      this.blockedSince = now;
      const sink = this.sink;
      sink.once("drain", () => { if (this.sink === sink) this.blockedSince = null; });
    }
    return true;
  }

  /** How long the encoder's input has refused data; 0 when flowing. */
  blockedFor() { return this.blockedSince === null ? 0 : this.now() - this.blockedSince; }
}
