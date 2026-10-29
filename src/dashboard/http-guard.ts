import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

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
  if (trustForwarded && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") && header !== undefined) {
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

/** Only origin-form targets are accepted. Never normalize routing into another path. */
export function requestTarget(target: string | undefined): URL | null {
  if (!target || target.length > 8192 || !/^\/(?!\/)[^\x00-\x20\x7f\\#]*$/.test(target) || /%(?![\da-f]{2})/i.test(target)) return null;
  try {
    const url = new URL(target, "http://localhost");
    if (url.origin !== "http://localhost" || url.pathname !== target.split("?")[0]) return null;
    return url;
  } catch { return null; }
}

/** Canonical address key; IPv6 clients share a /64, mapped IPv4 shares its IPv4 key. */
export function addressKey(address: string): string {
  if (!isIP(address) || address.includes("%")) return "unknown";
  if (isIP(address) === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const parts = canonical.split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const words = parts.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  const nums = words.map(x => parseInt(x, 16));
  if (nums.slice(0, 5).every(n => n === 0) && nums[5] === 65535) return `${nums[6]! >> 8}.${nums[6]! & 255}.${nums[7]! >> 8}.${nums[7]! & 255}`;
  return nums.slice(0, 4).map(n => n.toString(16)).join(":") + "::/64";
}

/** Set only by the shell; raw viewer is loopback and must never be exposed. */
export const VIEWER_ADDRESS_HEADER = "x-blockhead-viewer-address";
