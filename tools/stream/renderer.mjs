/**
 * Owns the headless Chromium that renders the loopback broadcast page. Every
 * (re)launch is a new generation: frames and events from an older one are
 * ignored. A failure here never touches the encoder; the broadcast shows the
 * holding card while this retries with backoff.
 */
import { BroadcastViewerHealth } from "./viewer-health.mjs";

export const RENDERER_DEFAULTS = Object.freeze({
  staleMs: 5_000,          // no screencast frame this long → screenshot (still scenes paint nothing)
  frameFreshMs: 10_000,    // newest live frame older than this → not healthy
  probeTimeoutMs: 3_000,
  unresponsiveMs: 30_000,  // page probes failing this long → relaunch
  openTimeoutMs: 120_000,
  reloadMs: 6 * 3600_000,  // fresh page every 6 h bounds browser memory growth
  backoffMs: 5_000,
  maxBackoffMs: 300_000,
  stableMs: 300_000,
});

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(label), { name: "TimeoutError" })), ms); })]).finally(() => clearTimeout(timer));
};

export class Renderer {
  constructor({ chromium, pageUrl, width, height, log, now, onFrame, onGeneration, onBanner, executablePath, ...options }) {
    Object.assign(this, { chromium, pageUrl, width, height, log, now, onFrame, onGeneration, onBanner, executablePath });
    this.banner = null;   // the event banner on the page at the last probe ("kind|text"), or null
    this.o = { ...RENDERER_DEFAULTS, ...options };
    this.generation = 0;
    this.browser = null; this.context = null; this.page = null; this.cdp = null;
    this.open = false; this.busy = false; this.timer = null; this.stopped = false;
    this.failures = 0; this.openedAt = null; this.lastReload = null;
    this.lastFrameAt = null; this.frames = 0;
    this.pendingHardFailure = null;
    this.viewerState = null; this.raf = null; this.rafAdvancedAt = null; this.probeOkAt = null; this.pageOffline = false;
    this.viewerHealth = new BroadcastViewerHealth();
    this.renderer = null;
    this.relaunches = 0;
  }

  start() { this.launch(); }

  /** A crash or close is reported once, immediately, for the state machine. */
  takeHardFailure() { const failure = this.pendingHardFailure; this.pendingHardFailure = null; return failure; }

  health() {
    if (!this.open) return { ok: false, reason: this.timer || this.busy ? "renderer-recovering" : "renderer-down" };
    const now = this.now();
    if (this.probeOkAt === null || now - this.probeOkAt > this.o.probeTimeoutMs + 2_500) return { ok: false, reason: "renderer-unresponsive" };
    if (this.lastFrameAt === null || now - this.lastFrameAt > this.o.frameFreshMs) return { ok: false, reason: "frame-stale" };
    return { ok: true };
  }

  viewerHealthSignal() {
    if (!this.open) return { ok: false, reason: "viewer-unknown" };
    // "offline" is the page's fresh word from the bot that Bob is disconnected; with its offline scene up it can be shown (withOfflineScene).
    if (this.viewerState === "offline") return { ok: false, reason: this.pageOffline ? "viewer-offline-scene" : "viewer-offline" };
    if (this.viewerState !== "connected") return { ok: false, reason: "viewer-not-connected" };
    // rAF runs in the 3D frame; a CSS animation in the shell can't advance it.
    if (this.rafAdvancedAt === null || this.now() - this.rafAdvancedAt > this.o.frameFreshMs) return { ok: false, reason: "viewer-frozen" };
    return { ok: true };
  }

  crash(generation, reason) {
    if (generation !== this.generation || this.stopped) return;
    this.log("renderer failed", { reason, generation });
    this.pendingHardFailure = reason;
    this.recover(reason);
  }

  /** Retire this generation and relaunch after backoff. */
  recover(reason) {
    if (this.stopped || this.timer) return;
    this.open = false;
    this.onGeneration(++this.generation);
    const delay = Math.min(this.o.maxBackoffMs, this.o.backoffMs * 2 ** this.failures);
    this.failures++;
    this.log("renderer recovery scheduled", { reason, delayMs: delay, generation: this.generation });
    const old = { browser: this.browser };
    this.browser = this.context = this.page = this.cdp = null;
    void this.teardown(old.browser);
    this.timer = setTimeout(() => { this.timer = null; this.launch(); }, delay);
  }

  async teardown(browser) {
    if (!browser) return;
    try { await withTimeout(browser.close(), 10_000, "browser close"); }
    catch { try { browser.process?.()?.kill("SIGKILL"); } catch {} }
  }

  async launch() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const browser = await withTimeout(this.chromium.launch({
        executablePath: this.executablePath || undefined,
        args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=vulkan", "--enable-features=Vulkan", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
      }), 60_000, "browser launch");
      if (generation !== this.generation || this.stopped) { void this.teardown(browser); return; }
      this.browser = browser;
      browser.on("disconnected", () => this.crash(generation, "browser-disconnected"));
      // The page runs under its own CSP, as for any visitor. The init script goes in through CDP, which CSP doesn't govern.
      const context = await browser.newContext({ viewport: { width: this.width, height: this.height }, deviceScaleFactor: 1 });
      await context.addInitScript(() => {
        // Render-loop evidence for the broadcast probe, installed in every frame.
        let ticks = 0; const tick = () => { ticks++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
        Object.defineProperty(window, "__cobblebobRaf", { get: () => ticks });
      });
      const page = await context.newPage();
      page.on("crash", () => this.crash(generation, "page-crashed"));
      page.on("close", () => this.crash(generation, "page-closed"));
      const cdp = await context.newCDPSession(page);
      cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        if (generation === this.generation) this.frame(Buffer.from(data, "base64"), generation);
      });
      Object.assign(this, { context, page, cdp });
      await withTimeout(this.openPage(page, cdp), this.o.openTimeoutMs, "page open");
      if (generation !== this.generation) return;
      this.open = true; this.openedAt = this.lastReload = this.now(); this.probeOkAt = this.now();
      this.relaunches++;
    } catch (error) {
      this.log("renderer open failed", { error: error?.name ?? "Error" });
      this.busy = false;
      if (generation === this.generation) this.recover("renderer-open-failed");
      return;
    }
    this.busy = false;
  }

  async openPage(page, cdp) {
    this.banner = null;
    this.pageOffline = false;  // a fresh page vouches for its offline scene only once probed
    await page.goto(this.pageUrl, { waitUntil: "load", timeout: 30_000 });
    // /broadcast is made for the stream: it has no controls to hide, and it applies the follow camera
    // itself (again whenever the 3D frame reloads). Nothing here clicks, types into or restyles the page.
    await page.locator(".stage iframe").waitFor({ state: "attached", timeout: 30_000 });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 2 });  // the page paints at ~60 Hz; the stream needs 30
    this.log("page open", { generation: this.generation });
  }

  frame(buffer, generation) {
    this.lastFrameAt = this.now(); this.frames++;
    this.onFrame(buffer, generation);
  }

  /** Every couple of seconds: probe the page, keep still scenes fresh, recover stalls. */
  async check() {
    if (!this.open || this.busy || this.stopped) return;
    const generation = this.generation, page = this.page, now = this.now();
    this.busy = true;
    try {
      const probe = await withTimeout(page.evaluate(() => {
        const frame = document.querySelector(".stage iframe");
        let raf = null, gl = null;
        try { raf = frame?.contentWindow?.__cobblebobRaf ?? null; } catch {}
        try { gl = frame?.contentDocument?.querySelector("canvas") ? true : false; } catch {}
        // The page's event banner (#banner.show, data-kind), for clips. Banners last 6 s; probes run every 2 s.
        const node = document.querySelector("#banner");
        const banner = node?.classList.contains("show") ? `${node.dataset.kind ?? ""}|${document.querySelector("#bannerText")?.textContent ?? ""}`.slice(0, 200) : null;
        return { state: document.querySelector("#viewerStatus")?.textContent ?? null, raf, gl, banner, offline: document.querySelector("[data-offline]") !== null };
      }), this.o.probeTimeoutMs, "probe");
      if (generation !== this.generation) return;
      this.probeOkAt = this.now();
      this.pageOffline = probe.offline === true;
      const banner = typeof probe.banner === "string" ? probe.banner : null;
      if (banner !== this.banner) {
        this.banner = banner;
        // Only the kind leaves the renderer; the banner text is never logged.
        if (banner) this.onBanner?.(banner.slice(0, banner.indexOf("|")).replace(/[^a-z]/g, "").slice(0, 16));
      }
      if (probe.state !== this.viewerState) { this.log("viewer state", { state: probe.state }); this.viewerState = probe.state; }
      if (typeof probe.raf === "number" && probe.raf !== this.raf) { this.raf = probe.raf; this.rafAdvancedAt = this.now(); }
      if (this.failures && this.openedAt !== null && now - this.openedAt > this.o.stableMs && this.viewerState === "connected") this.failures = 0;
      const stalled = this.viewerHealth.shouldRecover(probe.state, now);
      if (stalled || now - this.lastReload > this.o.reloadMs) {
        this.log("reopening page", { reason: stalled ? "viewer stalled" : "scheduled refresh" });
        this.busy = false;
        this.recoverInPlace(stalled ? "viewer-stalled" : "scheduled-refresh");
        return;
      }
      // A still scene yields no screencast frames; a screenshot proves the page still paints.
      if (this.lastFrameAt === null || now - this.lastFrameAt > this.o.staleMs) {
        const shot = await page.screenshot({ type: "jpeg", quality: 85, timeout: 10_000 });
        if (generation === this.generation) this.frame(shot, generation);
      }
    } catch (error) {
      if (generation === this.generation && this.probeOkAt !== null && this.now() - this.probeOkAt > this.o.unresponsiveMs) {
        this.busy = false;
        this.log("renderer unresponsive", { error: error?.name });
        this.recover("renderer-unresponsive");
        return;
      }
    } finally { if (generation === this.generation) this.busy = false; }
  }

  /** Reload the page inside the same browser (cheaper than a relaunch); falls back to one. */
  recoverInPlace(reason) {
    const generation = ++this.generation;
    this.onGeneration(generation);
    this.open = false; this.busy = true;
    const { page, cdp } = this;
    void (async () => {
      try {
        page.removeAllListeners("crash"); page.removeAllListeners("close");
        page.on("crash", () => this.crash(generation, "page-crashed"));
        page.on("close", () => this.crash(generation, "page-closed"));
        cdp.removeAllListeners("Page.screencastFrame");
        cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
          cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
          if (generation === this.generation) this.frame(Buffer.from(data, "base64"), generation);
        });
        await cdp.send("Page.stopScreencast").catch(() => {});
        await withTimeout(this.openPage(page, cdp), this.o.openTimeoutMs, "page reopen");
        if (generation !== this.generation) return;
        this.open = true; this.openedAt = this.lastReload = this.now(); this.probeOkAt = this.now();
        this.busy = false;
      } catch (error) {
        this.log("page recovery failed", { reason, error: error?.name ?? "Error" });
        this.busy = false;
        if (generation === this.generation) this.recover("renderer-reopen-failed");
      }
    })();
  }

  async stop() {
    this.stopped = true; this.open = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const browser = this.browser; this.browser = null;
    await this.teardown(browser);
  }
}
