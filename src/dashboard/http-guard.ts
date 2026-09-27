import type { IncomingMessage } from "node:http";

/** Set by the public listener on everything it forwards to the viewer server. */
export const PUBLIC_VIEWER_HEADER = "x-blockhead-public";

/** Security headers for the shell page itself (never framed). */
export const SHELL_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * The prismarine bundle is framed by the shell, injects an inline <style>,
 * spawns a same-origin worker and draws textures through data/blob URLs.
 */
export const VIEWER_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  ...SHELL_SECURITY_HEADERS,
  "content-security-policy": "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "SAMEORIGIN",
};

/**
 * The meshing worker validates block models with ajv, which compiles
 * schemas via `new Function`. A worker takes its CSP from its own script's
 * response, so eval is allowed there and nowhere else.
 */
export const VIEWER_WORKER_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  ...VIEWER_SECURITY_HEADERS,
  "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:",
};

/**
 * Client address for rate limiting. The public listener is bound to
 * loopback and only Tailscale Funnel talks to it, which appends the real
 * client to X-Forwarded-For; earlier entries are client-controlled.
 */
export function clientAddress(request: IncomingMessage, trustForwarded: boolean): string {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (trustForwarded && header !== undefined) {
    const last = header.split(",").map(part => part.trim()).filter(part => part.length > 0).pop();
    if (last !== undefined) return last;
  }
  return request.socket.remoteAddress ?? "unknown";
}

/** Token bucket per key; idle keys are pruned so memory stays bounded. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string, cost = 1): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond);
      bucket.at = now;
    }
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  private prune(now: number): void {
    const fullAfterMs = (this.capacity / this.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at >= fullAfterMs) this.buckets.delete(key);
    }
    // Under a flood of distinct keys, forget the oldest half.
    if (this.buckets.size >= this.maxKeys) {
      let drop = Math.floor(this.buckets.size / 2);
      for (const key of this.buckets.keys()) { if (drop-- <= 0) break; this.buckets.delete(key); }
    }
  }
}
