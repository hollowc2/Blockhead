import { ViewerSession, frameToken } from "./viewer-session.mjs";
import { ago, armorMaterial, compact, dayDial, gainedItems, iconRow, itemLabel, progression, TIERS } from "./broadcast-panels.mjs";
// The broadcast frame filmed by tools/stream. It reads the same /api/state as
// the viewer shell, polls once a second, and never takes input: no buttons,
// no hover, no keys. Animations are CSS; nothing here runs per frame.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; };
  const setText = (node, value) => { const text = value === null || value === undefined || value === "" ? "—" : String(value); if (node.textContent !== text) node.textContent = text; };
  const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`; };

  // The stream renders the frame 1:1; a smaller preview window gets it scaled down whole.
  const frame = $("frame");
  const fit = () => { const scale = Math.min(1, innerWidth / 1280, innerHeight / 720); frame.style.transform = scale < 1 ? `scale(${scale})` : ""; };
  addEventListener("resize", fit);
  fit();

  // Item art comes from the viewer's bundled textures, as on the shell. Items
  // drawn as entity models (shield, beds, chests) would show a misleading flat
  // texture, so they and anything unknown show initials instead.
  const textureRoot = "/viewer/textures/1.21.4/";
  const itemTextures = new Map();
  const ENTITY_MODEL = /^(?:shield|[a-z_]+_bed|chest|trapped_chest|ender_chest|barrel)$/;
  const SLOT_GHOST = { head: "helmet", torso: "chestplate", legs: "leggings", feet: "boots", hand: "sword", "off-hand": "shield" };
  const initials = (key) => { const words = key.split("_").filter(Boolean); return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : key.slice(0, 2).replace(/^./, (c) => c.toUpperCase()); };
  function art(box, name, slot) {
    const key = name ? String(name).replace(/^minecraft:/, "") : null;
    const texture = key ? (ENTITY_MODEL.test(key) ? null : itemTextures.get(key)) : slot ? `gui/sprites/container/slot/${SLOT_GHOST[slot]}.png` : null;
    const signature = JSON.stringify([key, texture ?? null]);
    if (box.dataset.art === signature) return;
    box.dataset.art = signature;
    box.classList.toggle("blank", !key);
    const nodes = [];
    if (texture) {
      const img = el("img", key ? "" : "ghost");
      img.alt = ""; img.width = 32; img.height = 32;
      img.addEventListener("error", () => img.remove(), { once: true });
      img.src = textureRoot + texture;
      nodes.push(img);
    }
    if (key) nodes.push(el("span", "initials", initials(key)));
    box.replaceChildren(...nodes);
  }
  fetch(textureRoot + "items_textures.json").then((response) => {
    if (!response.ok) throw new Error("Item artwork unavailable");
    return response.json();
  }).then((items) => {
    for (const item of items) {
      const texture = item.texture.replace(/^minecraft:/, "").replace(/^block\//, "blocks/").replace(/^item\//, "items/");
      if (/^(?:items|blocks)\/[a-z0-9_]+$/.test(texture)) itemTextures.set(item.name, `${texture}.png`);
    }
    if (lastState) render(lastState, { repaint: true });
  }).catch(() => {}); // Initials stay readable if artwork fails.

  // ---- Game overlay: day, phase, dial, hearts and hunger ----
  let lastPhase = null, observedFlipAt = null;
  const DIMENSIONS = { overworld: "Overworld", the_nether: "Nether", the_end: "The End" };
  function renderOverlay(s, connected, now) {
    const self = s.self || {};
    const day = s.world?.day;
    $("dayChip").hidden = typeof day !== "number";
    setText($("dayCount"), day);
    const phase = connected && (self.timePhase === "day" || self.timePhase === "night") ? self.timePhase : null;
    if (phase && lastPhase && phase !== lastPhase) observedFlipAt = now;
    if (phase) lastPhase = phase;
    $("phaseChip").hidden = !phase;
    $("phaseIcon").className = `phase-icon ${phase ?? ""}`;
    setText($("phaseLabel"), phase === "day" ? "Day" : "Night");
    const dimension = typeof self.dimension === "string" ? self.dimension.replace(/^minecraft:/, "") : null;
    const away = connected && dimension && dimension !== "overworld";
    $("dimensionChip").hidden = !away;
    if (away) setText($("dimensionChip"), DIMENSIONS[dimension] ?? itemLabel(dimension));
    // The Nether and the End have no sky to time.
    const dial = dayDial({ phase: away ? null : phase, story: s.story || [], observedFlipAt, now });
    $("dial").hidden = dial.phase === null;
    $("dial").dataset.phase = dial.phase ?? "";
    $("dialHand").style.setProperty("--dial-angle", `${dial.angle}deg`);
    setText($("dialLabel"), dial.label);

    const live = connected && typeof self.health === "number";
    $("vitals").hidden = !live;
    icons($("hearts"), self.health);
    icons($("food"), self.hunger);
    $("hearts").classList.toggle("low", live && self.health <= 6);
  }
  function icons(root, value) {
    if (root.children.length !== 10) root.replaceChildren(...Array.from({ length: 10 }, () => el("i")));
    iconRow(value).forEach((state, i) => { const icon = root.children[i]; if (icon.className !== state) icon.className = state; });
  }

  // ---- Right now: the coarse public status ----
  const ACTIVITY = { offline: "Offline", recovering: "Recovering", building: "Building", gathering: "Gathering", exploring: "Exploring", resting: "Resting", working: "Working" };
  function renderStatus(s, connected, now) {
    // The private listener's state has no public status; the card waits for one.
    $("statusPanel").hidden = connected && !s.status;
    const activity = connected && ACTIVITY[s.status?.activity] ? s.status.activity : "offline";
    $("statusPanel").dataset.activity = activity;
    setText($("statusLabel"), ACTIVITY[activity]);
    setText($("statusDetail"), connected ? s.status?.detail : "CobbleBob isn't connected to the world right now.");
    const started = connected && s.status?.since ? Date.parse(s.status.since) : NaN;
    const since = Number.isFinite(started) && now - started >= 60_000 ? `for ${span(now - started)}` : "";
    if ($("statusSince").textContent !== since) $("statusSince").textContent = since;
  }

  // ---- Inventory: sprites and counts; anything gained since the last poll glows ~5 s ----
  const MAX_SLOTS = 16, GLOW_MS = 5000;
  const inventoryRows = new Map(), glowUntil = new Map();
  let lastCounts = null;
  function renderInventory(inventory, connected, now) {
    const counts = new Map();
    for (const item of inventory?.items ?? []) if (item && typeof item.name === "string") counts.set(item.name, (counts.get(item.name) ?? 0) + (Number(item.count) || 0));
    const items = [...counts].map(([name, count]) => ({ name, count }));
    for (const name of gainedItems(lastCounts, items)) glowUntil.set(name, now + GLOW_MS);
    // Offline or unavailable drops the baseline, so a reconnect never lights up everything.
    lastCounts = inventory ? counts : null;
    for (const [name, until] of glowUntil) if (until <= now || !counts.has(name)) glowUntil.delete(name);

    const total = inventory ? `${compact(inventory.totalItems)} items` : "";
    if ($("inventoryCount").textContent !== total) $("inventoryCount").textContent = total;
    $("inventoryEmpty").hidden = items.length > 0;
    setText($("inventoryEmpty"), inventory ? "Empty-handed for now." : connected ? "Inventory unavailable." : "Inventory unavailable while CobbleBob is offline.");
    const shown = items.length > MAX_SLOTS ? items.slice(0, MAX_SLOTS - 1) : items;
    for (const [name, row] of inventoryRows) if (!shown.some((item) => item.name === name)) { row.remove(); inventoryRows.delete(name); }
    const root = $("inventory");
    shown.forEach((item, index) => {
      let row = inventoryRows.get(item.name);
      if (!row) {
        row = el("li");
        row.append(el("span", "slot-box"), el("b", "count"));
        inventoryRows.set(item.name, row);
      }
      art(row.firstElementChild, item.name);
      const count = item.count > 1 ? compact(item.count) : "";
      if (row.lastElementChild.textContent !== count) row.lastElementChild.textContent = count;
      const until = glowUntil.get(item.name);
      // A new gain while still glowing restarts the animation.
      if (String(until ?? "") !== (row.dataset.glow ?? "")) {
        row.classList.remove("gained");
        if (until) { void row.offsetWidth; row.classList.add("gained"); row.dataset.glow = String(until); } else delete row.dataset.glow;
      }
      if (root.children[index] !== row) root.insertBefore(row, root.children[index] || null);
    });
    let more = root.querySelector(".more");
    if (items.length > MAX_SLOTS) {
      if (!more) { more = el("li", "more"); more.append(el("span", "slot-box")); }
      setText(more.firstElementChild, `+${items.length - shown.length}`);
      if (root.lastElementChild !== more) root.append(more);
    } else more?.remove();
  }

  // ---- Equipment paper doll ----
  const ARMOR_PARTS = { head: ["head"], torso: ["torso", "arms"], legs: ["legs"], feet: ["feet"] };
  function renderEquipment(equipment) {
    for (const [slot, parts] of Object.entries(ARMOR_PARTS)) {
      const item = equipment?.[slot];
      art(document.querySelector(`.doll-armor [data-slot="${slot}"]`), item?.name, slot);
      const material = armorMaterial(item?.name);
      for (const part of parts) document.querySelectorAll(`.doll-figure [data-part="${part}"]`).forEach((node) => {
        if (material) node.setAttribute("data-material", material); else node.removeAttribute("data-material");
      });
    }
    for (const slot of ["hand", "off-hand"]) {
      const row = document.querySelector(`.doll-hands [data-slot="${slot}"]`);
      const item = equipment?.[slot];
      art(row.querySelector(".slot-box"), item?.name, slot);
      row.classList.toggle("blank", !item);
      setText(row.querySelector("b"), !equipment ? "—" : item ? `${itemLabel(item.name)}${item.count > 1 ? ` ×${item.count}` : ""}` : "Empty");
    }
  }

  // ---- Story ticker: the latest four, newest first ----
  const GLYPHS = new Set(["day", "night", "goal", "build", "death", "respawn", "gather", "tool", "hostile", "explore", "home", "fight", "milestone"]);
  let lastStoryId = null;
  function renderStory(entries, now) {
    const newest = entries.length ? entries[entries.length - 1].id : 0;
    // A restarted bot numbers its story from 1 again; treat that as a fresh start.
    const firstLoad = lastStoryId === null || newest < lastStoryId;
    const latest = entries.slice(-4).reverse();
    const list = $("story");
    $("storyEmpty").hidden = latest.length > 0;
    const key = JSON.stringify(latest.map((entry) => [entry.id, entry.text, entry.highlight, ago(entry.at, now)]));
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...latest.map((entry) => {
        const icon = GLYPHS.has(entry.icon) ? entry.icon : "dot";
        const row = el("li", `${icon}${entry.highlight ? " highlight" : ""}${!firstLoad && entry.id > lastStoryId ? " fresh" : ""}`);
        const time = el("time", "", ago(entry.at, now));
        time.dateTime = entry.at;
        row.append(el("i", `glyph ${icon}`), el("span", "", entry.text), time);
        return row;
      }));
    }
    lastStoryId = newest;
  }

  // ---- Lifetime stats ----
  function renderStats(world) {
    setText($("statDay"), world?.day);
    setText($("statDeaths"), world ? compact(world.deaths) : null);
    setText($("statMined"), world ? compact(world.blocksMined) : null);
    setText($("statCrafted"), world ? compact(world.itemsCrafted) : null);
    setText($("statDistance"), typeof world?.distanceKm === "number" ? `${world.distanceKm < 100 ? world.distanceKm.toFixed(1) : compact(Math.round(world.distanceKm))} km` : null);
    setText($("statNemesis"), world ? world.nemesis ?? "None yet" : null);
    $("statNemesis").classList.toggle("word", Boolean(world?.nemesis));
  }

  // ---- Progression badges ----
  const tierRows = new Map();
  let reachedTiers = null;
  function renderProgress(s) {
    const root = $("tiers");
    if (!tierRows.size) for (const tier of TIERS) {
      const row = el("li", "tier");
      const badge = el("span", "badge");
      const img = el("img"); img.alt = ""; img.width = 28; img.height = 28; img.src = textureRoot + tier.texture;
      badge.append(img);
      row.append(badge, el("span", "", tier.label));
      tierRows.set(tier.id, row);
      root.append(row);
    }
    const { tiers, current } = progression(s);
    for (const tier of tiers) {
      const row = tierRows.get(tier.id);
      row.classList.toggle("reached", tier.reached);
      row.classList.toggle("current", tier.id === current);
      if (reachedTiers && tier.reached && !reachedTiers.has(tier.id)) { row.classList.remove("fresh"); void row.offsetWidth; row.classList.add("fresh"); }
    }
    reachedTiers = new Set(tiers.filter((tier) => tier.reached).map((tier) => tier.id));
    // The frame never reflows, so the track is measured only when the current tier changes.
    if (root.dataset.current !== String(current)) {
      root.dataset.current = String(current);
      const centre = (id) => { const badge = tierRows.get(id).firstElementChild; return badge.offsetLeft + badge.parentElement.offsetLeft + badge.offsetWidth / 2; };
      const first = centre(TIERS[0].id);
      root.style.setProperty("--track-left", `${first}px`);
      root.style.setProperty("--track-width", `${centre(TIERS[TIERS.length - 1].id) - first}px`);
      root.style.setProperty("--fill-width", `${current ? centre(current) - first : 0}px`);
    }
    const label = current ? TIERS.find((tier) => tier.id === current).label : null;
    setText($("tierLabel"), label ? (current === "nether" ? "Nether explorer" : `${label} age`) : "Just started");
  }

  // Later phases bind these slots; a slot shows only once its field is present (and bound).
  const SLOT_FIELDS = new Set(["now", "thinking", "build", "brain", "vitals"]);
  function renderSlots(s) {
    document.querySelectorAll("[data-panel]").forEach((slot) => {
      const field = slot.dataset.panel;
      slot.hidden = !SLOT_FIELDS.has(field) || s[field] === undefined || s[field] === null;
    });
  }

  // ---- Freshness, the live pill and the veil over the game ----
  let reachable = false, botLive = false, lastReceivedAt = null, lastState = null;
  function renderFreshness() {
    document.body.classList.toggle("stale", !reachable || !botLive);
    const live = $("live");
    const state = !reachable ? "wait" : !botLive ? "down" : "ok";
    live.dataset.state = state;
    setText($("liveText"), { wait: lastReceivedAt === null ? "Connecting" : "Reconnecting", down: "Offline", ok: "Live" }[state]);
  }
  const VEIL = {
    loading: ["Joining the world…", "The live view starts in a moment."],
    connecting: ["Joining the world…", "The live view starts in a moment."],
    "loading-world": ["Loading the world…", "Nearby terrain is on its way."],
    reconnecting: ["Reconnecting…", "The live view will be back shortly."],
    capacity: ["Reconnecting…", "The live view will be back shortly."],
    unavailable: ["Reconnecting…", "The live view will be back shortly."],
    offline: ["CobbleBob is offline", "He'll be back in the world soon."],
    "webgl-failed": ["Live view unavailable", "The 3D view could not start."],
  };
  function renderVeil(state) {
    const veil = $("veil");
    veil.hidden = state === "connected";
    const [title, detail] = VEIL[state] || VEIL.reconnecting;
    setText($("veilTitle"), title);
    setText($("veilDetail"), detail);
  }

  function render(s, { repaint = false } = {}) {
    const now = Date.now();
    const connected = s.connection?.connected === true;
    if (!repaint) { reachable = true; botLive = connected; lastReceivedAt = now; }
    lastState = s;
    renderOverlay(s, connected, now);
    renderStatus(s, connected, now);
    renderInventory(connected ? s.inventory : null, connected, now);
    renderEquipment(connected ? s.equipment : null);
    renderStory(s.story || [], now);
    renderStats(s.world);
    renderProgress(s);
    renderSlots(s);
    if (repaint) return;
    viewerSession.update({ reachable: true, connected, running: s.viewer?.status === "running", session: s.viewer?.session ?? "unknown" });
    setText($("viewerStatus"), viewerSession.state);
    renderFreshness();
  }

  // ---- The 3D frame: the same mount/retry lifecycle as the viewer shell ----
  // Follow mode is applied on every mount, so the streamer never needs to press T.
  let viewerFrame = document.querySelector(".stage iframe");
  function follow() {
    try {
      const win = viewerFrame.contentWindow;
      win.dispatchEvent(new win.CustomEvent("bob-cam", { detail: "follow" }));
    } catch {}
  }
  const viewerSession = new ViewerSession({
    mode: "3d", origin: window.location.origin,
    token: frameToken, random: Math.random, schedule: (run, ms) => setTimeout(run, ms), cancel: (timer) => clearTimeout(timer),
    mount(token) {
      const replacement = viewerFrame.cloneNode(false);
      replacement.removeAttribute("src"); viewerFrame.replaceWith(replacement); viewerFrame = replacement;
      viewerFrame.addEventListener("load", follow);
      viewerFrame.src = `/viewer/?visit=${token}`;
      return viewerFrame.contentWindow;
    },
    release() { viewerFrame.removeAttribute("src"); viewerFrame.src = "about:blank"; },
    changed(state) {
      setText($("viewerStatus"), state);
      renderVeil(state);
      if (state === "connected") follow();
    },
  });
  window.addEventListener("message", (event) => viewerSession.message(event.source, event.origin, event.data));
  window.addEventListener("pagehide", () => viewerSession.stop(), { once: true });
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) viewerSession.visibility(false);
    else { await refresh(); viewerSession.visibility(true); }
  });

  // Each poll gets a deadline, and only the newest answer counts.
  const STATE_DEADLINE_MS = 4000, STALE_AFTER_MS = 5000;
  let refreshSeq = 0, appliedSeq = 0, refreshing = false;
  async function refresh() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    const seq = ++refreshSeq;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATE_DEADLINE_MS);
    try {
      const response = await fetch("/api/state", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      const state = await response.json();
      if (seq < appliedSeq) return;
      appliedSeq = seq;
      render(state);
    } catch {
      if (seq < appliedSeq) return;
      markUnreachable();
    } finally {
      clearTimeout(timer); refreshing = false;
    }
  }
  function markUnreachable() {
    reachable = false; botLive = false;
    viewerSession.update({ reachable: false, connected: false, running: false, session: lastState?.viewer?.session ?? "unknown" });
    setText($("viewerStatus"), viewerSession.state);
    renderFreshness();
  }

  renderVeil(viewerSession.state);
  void refresh();
  setInterval(() => {
    if (document.hidden) return;
    void refresh();
    // Silence counts as a lost connection even while requests hang unanswered.
    if (reachable && lastReceivedAt !== null && Date.now() - lastReceivedAt > STALE_AFTER_MS) markUnreachable();
  }, 1000);
})();
