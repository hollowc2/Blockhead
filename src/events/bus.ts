import { logger } from "../logger.js";
import type { EventMap, EventName, EventPayload } from "./types.js";

type Listener<K extends EventName> = (payload: EventPayload<K>) => void;

/**
 * Lightweight synchronous internal event bus (spec section 18).
 *
 * - Listeners are typed per event name via `EventMap`.
 * - `emit` is synchronous so state transitions are ordered and deterministic.
 * - A throwing listener is logged and does not break other listeners or the
 *   caller; a buggy listener must not take the whole bot down.
 */
export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>();

  /** Subscribe; returns an unsubscribe function. */
  on<K extends EventName>(name: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as Listener<EventName>);
    return () => this.off(name, listener);
  }

  off<K extends EventName>(name: K, listener: Listener<K>): void {
    this.listeners.get(name)?.delete(listener as Listener<EventName>);
  }

  emit<K extends EventName>(name: K, payload: EventPayload<K>): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        (listener as Listener<K>)(payload);
      } catch (err) {
        logger.error({ err, event: name }, "event listener threw");
      }
    }
  }

  listenerCount(name: EventName): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}