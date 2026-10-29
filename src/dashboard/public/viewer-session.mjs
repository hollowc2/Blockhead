/** Browser visitor lifecycle, independent of the server's bot/status availability. */
export class ViewerSession {
  constructor(options) {
    this.options = options;
    this.mode = options.mode === 'lightweight' ? 'lightweight' : '3d';
    this.state = 'loading'; this.token = null; this.source = null; this.attempt = 0;
    this.allowed = false; this.visible = true; this.paused = false; this.timer = null; this.backgroundTimer = null;
  }
  change(state) { this.state = state; this.options.changed(state); }
  clearTimer() { this.options.cancel(this.timer); this.timer = null; }
  release() { this.clearTimer(); this.token = this.source = null; this.options.release(); }
  open() {
    if (this.mode !== '3d' || this.paused || !this.visible || !this.allowed) return;
    this.release(); this.token = this.options.token(); this.change('connecting');
    this.source = this.options.mount(this.token);
    this.timer = this.options.schedule(() => this.fail('unavailable'), 30_000);
  }
  update({ reachable, connected, running, session }) {
    const changedSession = this.serverSession !== undefined && session !== this.serverSession;
    this.serverSession = session;
    if (!reachable && this.token && this.state === 'connected') return;
    const wasAllowed = this.allowed;
    this.allowed = reachable && connected && running;
    if (this.mode === 'lightweight') { this.change('lightweight'); return; }
    if (!this.allowed) {
      this.release(); this.change(!reachable ? 'unavailable' : !connected ? 'offline' : 'unavailable'); return;
    }
    if (changedSession) { this.attempt = 0; this.release(); }
    if ((!wasAllowed || changedSession) && !this.paused) { this.attempt = 0; this.open(); }
  }
  message(source, origin, data) {
    if (!this.token || source !== this.source || origin !== this.options.origin || !data || typeof data !== 'object' || Object.keys(data).length !== 4 || data.type !== 'bob-viewer' || data.version !== 1 || data.token !== this.token || !['connecting', 'socket-connected', 'ready', 'disconnected', 'capacity', 'unavailable', 'webgl-failed'].includes(data.state)) return false;
    if (data.state === 'ready') { this.clearTimer(); this.attempt = 0; this.change('connected'); }
    else if (data.state === 'socket-connected') this.change('loading-world');
    else if (data.state === 'connecting') { this.clearTimer(); this.timer = this.options.schedule(() => this.fail('unavailable'), 30_000); this.change('connecting'); }
    else if (data.state === 'webgl-failed') { this.paused = true; this.release(); this.change('webgl-failed'); }
    else this.fail(data.state === 'disconnected' ? 'reconnecting' : data.state);
    return true;
  }
  fail(state) {
    this.release(); this.change(state);
    if (this.attempt >= 3 || !this.visible || !this.allowed || this.paused || this.mode !== '3d') return;
    const delay = Math.min(60_000, 15_000 * 2 ** this.attempt++) + Math.round(this.options.random() * 5000);
    this.timer = this.options.schedule(() => this.open(), delay);
  }
  retry() { if (this.token) return; this.paused = false; this.attempt = 0; this.open(); }
  setMode(mode) { this.mode = mode === 'lightweight' ? mode : '3d'; this.paused = false; this.attempt = 0; this.release(); if (this.mode === 'lightweight') this.change('lightweight'); else this.open(); }
  pause() { this.paused = true; this.release(); this.change('paused'); }
  visibility(visible) {
    this.visible = visible; this.options.cancel(this.backgroundTimer);
    if (!visible) {
      this.clearTimer();
      this.backgroundTimer = this.options.schedule(() => { this.release(); if (this.mode === '3d' && !this.paused) this.change('background'); }, 60_000);
    } else if (!this.token && this.mode === '3d' && !this.paused) this.open();
  }
  stop() { this.release(); this.options.cancel(this.backgroundTimer); }
}

/** Countdown anchored at request start: latency never extends a server wait. */
export function retryUntil(startedAt, receivedAt, wait) {
  return typeof wait === 'number' && Number.isFinite(wait) ? Math.min(receivedAt + 3600_000, startedAt + Math.max(0, wait)) : 0;
}

/** getRandomValues also works on private HTTP origins where randomUUID is unavailable. */
export function frameToken() {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
