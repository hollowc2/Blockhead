import { ViewerSession, frameToken } from "./viewer-session.mjs";
import { createScenes, stepScenes } from "./broadcast-scenes.mjs";
import { ago, armorMaterial, compact, dayDial, fraction, gainedItems, iconRow, itemLabel, latency, milestoneSummary, nearestTurn, progression, sparkline, TIERS, uptime, wearBar } from "./broadcast-panels.mjs";
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

  // ---- Game overlay: day, phase, dial, hearts, hunger and their last hour ----
  // The public clock moves 100 ticks (5 s) at a time; one standing still for
  // longer is a stopped daylight cycle, which gets no countdown.
  const FROZEN_AFTER_MS = 20_000;
  let lastPhase = null, observedFlipAt = null, lastTicks = null, ticksMovedAt = 0, dialAngle = null;
  const DIMENSIONS = { overworld: "Overworld", the_nether: "Nether", the_end: "The End" };
  function renderOverlay(s, connected, now) {
    const self = s.self || {};
    const day = s.world?.day;
    $("dayChip").hidden = typeof day !== "number";
    setText($("dayCount"), day);
    const ticks = connected && typeof self.timeOfDay === "number" ? self.timeOfDay : null;
    if (ticks !== lastTicks) { lastTicks = ticks; ticksMovedAt = now; }
    const phase = connected && (self.timePhase === "day" || self.timePhase === "night") ? self.timePhase : null;
    if (phase && lastPhase && phase !== lastPhase) observedFlipAt = now;
    if (phase) lastPhase = phase;
    const dimension = typeof self.dimension === "string" ? self.dimension.replace(/^minecraft:/, "") : null;
    const away = connected && dimension && dimension !== "overworld";
    $("dimensionChip").hidden = !away;
    if (away) setText($("dimensionChip"), DIMENSIONS[dimension] ?? itemLabel(dimension));
    // The Nether and the End have no sky to time.
    const dial = dayDial({ phase: away ? null : phase, timeOfDay: ticks, frozen: now - ticksMovedAt > FROZEN_AFTER_MS, story: s.story || [], observedFlipAt, now });
    // With the exact clock the dial's phase leads, so the chip and the dial never disagree.
    const shown = dial.phase ?? phase;
    $("phaseChip").hidden = !shown;
    $("phaseIcon").className = `phase-icon ${shown ?? ""}`;
    setText($("phaseLabel"), shown === "day" ? "Day" : "Night");
    $("dial").hidden = dial.phase === null;
    $("dial").dataset.phase = dial.phase ?? "";
    dialAngle = nearestTurn(dialAngle, dial.angle);
    $("dialHand").style.setProperty("--dial-angle", `${dialAngle}deg`);
    setText($("dialLabel"), dial.label);

    const live = connected && typeof self.health === "number";
    $("vitals").hidden = !live;
    icons($("hearts"), self.health);
    icons($("food"), self.hunger);
    $("hearts").classList.toggle("low", live && self.health <= 6);
  }
  // Drawn only when the samples change (once a minute), never per frame.
  function renderVitals(vitals) {
    const spark = document.querySelector('[data-panel="vitals"]');
    const samples = Array.isArray(vitals) ? vitals : [];
    spark.hidden = !samples.some((sample) => typeof sample?.health === "number" || typeof sample?.hunger === "number");
    const key = JSON.stringify(samples.map((sample) => [sample?.health, sample?.hunger]));
    if (spark.dataset.key === key) return;
    spark.dataset.key = key;
    const paths = sparkline(samples, { width: 150, height: 46 });
    $("sparkHealth").setAttribute("d", paths.health);
    $("sparkHunger").setAttribute("d", paths.hunger);
  }
  function icons(root, value) {
    if (root.children.length !== 10) root.replaceChildren(...Array.from({ length: 10 }, () => el("i")));
    iconRow(value).forEach((state, i) => { const icon = root.children[i]; if (icon.className !== state) icon.className = state; });
  }

  // ---- Now: the coarse public status, the templated goal line, its progress and step ----
  const ACTIVITY = { offline: "Offline", recovering: "Recovering", building: "Building", gathering: "Gathering", exploring: "Exploring", resting: "Resting", working: "Working" };
  function renderNow(s, connected, now) {
    // The private listener's state has no public status; the card waits for one.
    $("nowPanel").hidden = connected && !s.status;
    const activity = connected && ACTIVITY[s.status?.activity] ? s.status.activity : "offline";
    $("nowPanel").dataset.activity = activity;
    $("actionBar").dataset.activity = activity;
    setText($("statusLabel"), ACTIVITY[activity]);
    setText($("actionStatus"), ACTIVITY[activity]);
    setText($("nowLabel"), connected ? s.now?.label ?? s.status?.detail : "CobbleBob isn't connected to the world right now.");
    // The action bar's line is short: the goal when there is one, else nothing.
    const goal = connected && typeof s.now?.label === "string" ? s.now.label : "";
    if ($("actionNow").textContent !== goal) $("actionNow").textContent = goal;
    const started = connected && s.status?.since ? Date.parse(s.status.since) : NaN;
    const since = Number.isFinite(started) && now - started >= 60_000 ? `for ${span(now - started)}` : "";
    if ($("statusSince").textContent !== since) $("statusSince").textContent = since;
    const done = connected ? fraction(s.now?.progress) : null;
    $("nowBar").hidden = done === null;
    if (done !== null) $("nowBar").style.setProperty("--fill", `${Math.round(done * 1000) / 10}%`);
    // The step adds nothing when it only repeats the activity ("Exploring").
    const step = connected && typeof s.now?.step === "string" && s.now.step !== ACTIVITY[activity] ? s.now.step : "";
    $("nowStep").hidden = !step;
    if ($("nowStep").textContent !== step) $("nowStep").textContent = step;
  }

  // ---- Thinking: typed out once per decision, pulsing while a model call is in flight ----
  const TYPE_MS = 2600, TYPE_STEP_MAX_MS = 45;
  let thoughtAt = null;
  function renderThinking(s, connected) {
    const panel = $("thinkingPanel");
    const thought = connected && typeof s.thinking?.text === "string" && s.thinking.text ? s.thinking : null;
    const busy = connected && s.brain?.thinking === true;
    panel.hidden = !thought && !busy;
    panel.classList.toggle("busy", busy);
    const node = $("thought");
    if (!thought) {
      if (thoughtAt !== "") { thoughtAt = ""; node.className = "thought still"; node.textContent = "Mulling it over…"; }
      return;
    }
    // The trigger is the decision time: a repeated fixed phrase still types out again.
    if (thought.at === thoughtAt) return;
    thoughtAt = thought.at;
    const chars = [...thought.text];
    node.className = "thought";
    node.style.setProperty("--type-step", `${Math.min(TYPE_STEP_MAX_MS, TYPE_MS / chars.length).toFixed(1)}ms`);
    node.style.setProperty("--n", String(chars.length));
    node.replaceChildren(...chars.map((char, i) => { const letter = el("span", "", char); letter.style.setProperty("--i", String(i)); return letter; }));
  }

  // ---- Build: only while one is underway; it takes the progression row's place ----
  function renderBuild(build, connected) {
    const shown = connected && build && typeof build.structure === "string";
    $("buildPanel").hidden = !shown;
    $("progressPanel").hidden = Boolean(shown);
    if (!shown) return;
    const percent = Math.max(0, Math.min(100, Math.round(Number(build.percent) || 0)));
    setText($("buildName"), build.structure);
    setText($("buildPercent"), `${percent}%`);
    $("buildBar").style.setProperty("--fill", `${percent}%`);
    const placed = Number(build.blocksPlaced) || 0;
    setText($("buildBlocks"), `${compact(placed)} ${placed === 1 ? "block" : "blocks"}`);
  }

  // ---- Brain: model, decisions an hour, last latency (and uptime beside the minimap) ----
  function renderBrain(brain, uptimeSeconds) {
    $("brainPanel").hidden = !brain;
    if (!brain) return;
    setText($("brainModel"), brain.model ?? "Local model");
    setText($("brainRate"), compact(brain.decisionsLastHour ?? 0));
    setText($("brainLatency"), latency(brain.lastLatencyMs));
    setText($("brainUptime"), uptime(uptimeSeconds));
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

  // ---- Equipment hotbar: hands, then armor (its material shown as a strip, its wear as a bar) ----
  const EQUIPMENT_SLOTS = ["hand", "off-hand", "head", "torso", "legs", "feet"];
  const ARMOR_SLOTS = new Set(["head", "torso", "legs", "feet"]);
  function renderEquipment(equipment) {
    $("hotbar").hidden = !equipment;
    for (const slot of EQUIPMENT_SLOTS) {
      const box = document.querySelector(`.hotbar [data-slot="${slot}"]`);
      const item = equipment?.[slot];
      art(box, item?.name, slot);
      const material = ARMOR_SLOTS.has(slot) ? armorMaterial(item?.name) : null;
      if (material) box.setAttribute("data-material", material); else box.removeAttribute("data-material");
      // art() replaces the box's children when the item changes, so the bar is re-added after it.
      const bar = item ? wearBar(item.durability) : null;
      let wear = box.querySelector(".wear");
      if (!bar) { wear?.remove(); continue; }
      if (!wear) { wear = el("i", "wear"); wear.append(el("b")); box.append(wear); }
      wear.style.setProperty("--wear", `${Math.round(bar.fill * 100)}%`);
      wear.style.setProperty("--wear-hue", String(bar.hue));
    }
  }

  // ---- Story ticker: the latest four, newest first (seven in the night scene, by CSS) ----
  const GLYPHS = new Set(["day", "night", "goal", "build", "death", "respawn", "gather", "tool", "hostile", "explore", "home", "fight", "milestone"]);
  let lastStoryId = null;
  function renderStory(entries, now) {
    const newest = entries.length ? entries[entries.length - 1].id : 0;
    // A restarted bot numbers its story from 1 again; treat that as a fresh start.
    const firstLoad = lastStoryId === null || newest < lastStoryId;
    const latest = entries.slice(-7).reverse();
    const list = $("story");
    $("storyEmpty").hidden = latest.length > 0;
    const key = JSON.stringify(latest.map((entry) => [entry.id, entry.text, entry.highlight, ago(entry.at, now)]));
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...latest.map((entry) => storyRow(entry, now, !firstLoad && entry.id > lastStoryId)));
      // The action bar repeats the newest line: usually what set the scene off.
      const top = latest[0];
      $("actionStory").replaceChildren(...(top ? [el("i", `glyph ${GLYPHS.has(top.icon) ? top.icon : "dot"}`), el("span", "", top.text)] : []));
    }
    lastStoryId = newest;
  }
  function storyRow(entry, now, fresh = false) {
    const icon = GLYPHS.has(entry.icon) ? entry.icon : "dot";
    const row = el("li", `${icon}${entry.highlight ? " highlight" : ""}${fresh ? " fresh" : ""}`);
    const time = el("time", "", ago(entry.at, now));
    time.dateTime = entry.at;
    row.append(el("i", `glyph ${icon}`), el("span", "", entry.text), time);
    return row;
  }

  // ---- Offline scene: the bot answers but Bob isn't in the world ----
  // Recent story (already public-safe: built and filtered by the bot) and the
  // milestones closest to done stand in for the game view. The strip drops the
  // inventory and story for wider lifetime stats (CSS). The streamer counts
  // this, and only this, as presentable while Bob is disconnected.
  const OFFLINE_STORY = 6;
  let offlineSince = null, lastLiveAt = null;
  function renderOffline(s, offline, now) {
    if (frame.hasAttribute("data-offline") !== offline) frame.toggleAttribute("data-offline", offline);
    $("offline").hidden = !offline;
    if (!offline) { offlineSince = null; return; }
    // Since when: this page saw him go, else the last connected minute of the vitals (a page loaded mid-outage).
    if (offlineSince === null) {
      const seen = [...(Array.isArray(s.vitals) ? s.vitals : [])].reverse().find((sample) => typeof sample?.health === "number");
      const at = seen ? Date.parse(seen.at) : NaN;
      offlineSince = lastLiveAt ?? (Number.isFinite(at) ? at : NaN);
    }
    const away = Number.isFinite(offlineSince) && now - offlineSince >= 60_000 ? `Away ${span(now - offlineSince)}` : "";
    $("offlineFor").hidden = !away;
    if ($("offlineFor").textContent !== away) $("offlineFor").textContent = away;

    const entries = (Array.isArray(s.story) ? s.story : []).filter((entry) => entry && typeof entry.text === "string").slice(-OFFLINE_STORY).reverse();
    $("offlineStoryEmpty").hidden = entries.length > 0;
    const list = $("offlineStory");
    const key = JSON.stringify(entries.map((entry) => [entry.id, entry.text, entry.highlight, ago(entry.at, now)]));
    if (list.dataset.key !== key) { list.dataset.key = key; list.replaceChildren(...entries.map((entry) => storyRow(entry, now))); }

    const summary = milestoneSummary(s.world, 4);
    $("offlineMilestones").hidden = !summary;
    if (!summary) return;
    setText($("milestoneCount"), `${summary.unlocked}/${summary.total}`);
    const rows = $("milestones");
    const milestonesKey = JSON.stringify(summary.next);
    if (rows.dataset.key === milestonesKey) return;
    rows.dataset.key = milestonesKey;
    rows.replaceChildren(...(summary.next.length ? summary.next.map((m) => {
      const row = el("li", "milestone");
      const bar = el("div", "bar"); const fill = el("i"); fill.style.setProperty("--fill", `${Math.round(m.progress * 100)}%`); bar.append(fill);
      row.append(el("i", "glyph milestone"), el("b", "", m.title), el("span", "", m.description), bar);
      return row;
    }) : [el("li", "empty", "Every milestone unlocked!")]));
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
      row.append(badge);
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
    // The frame never reflows, so the track is measured only when the current
    // tier changes, and not while the build card hides the row (nothing to measure).
    if (root.dataset.current !== String(current) && root.offsetWidth > 0) {
      root.dataset.current = String(current);
      const centre = (id) => { const badge = tierRows.get(id).firstElementChild; return badge.offsetLeft + badge.parentElement.offsetLeft + badge.offsetWidth / 2; };
      const first = centre(TIERS[0].id);
      root.style.setProperty("--track-left", `${first}px`);
      root.style.setProperty("--track-width", `${centre(TIERS[TIERS.length - 1].id) - first}px`);
      root.style.setProperty("--fill-width", `${current ? centre(current) - first : 0}px`);
    }
    const label = current ? TIERS.find((tier) => tier.id === current).label : null;
    setText($("tierLabel"), label ?? "None yet");
  }

  // Later phases bind these slots; a slot shows only once its field is present (and bound).
  const SLOT_FIELDS = new Set(["now", "thinking", "build", "brain", "vitals"]);
  function renderSlots(s) {
    document.querySelectorAll("[data-panel]").forEach((slot) => {
      const field = slot.dataset.panel;
      if (field === "minimap") return;
      slot.hidden = !SLOT_FIELDS.has(field) || s[field] === undefined || s[field] === null;
    });
  }

  // The thought gets as many lines as the column has room for (2-5), so the
  // foot (brain, minimap) never gets pushed out. One layout read a poll.
  const LINE_PX = 24, MIN_LINES = 2, MAX_LINES = 5;
  let thoughtLines = MAX_LINES;
  function fitColumn() {
    const side = document.querySelector(".side"), node = $("thought"), foot = document.querySelector(".side-foot");
    if ($("thinkingPanel").hidden) return;
    const above = () => { let last = foot.previousElementSibling; while (last && last.hidden) last = last.previousElementSibling; return last; };
    const free = () => foot.getBoundingClientRect().top - above().getBoundingClientRect().bottom - parseFloat(getComputedStyle(side).rowGap);
    const set = (lines) => { thoughtLines = lines; node.style.setProperty("--lines", String(lines)); };
    while (thoughtLines > MIN_LINES && side.scrollHeight > side.clientHeight) set(thoughtLines - 1);
    while (thoughtLines < MAX_LINES && side.scrollHeight <= side.clientHeight && free() >= LINE_PX) set(thoughtLines + 1);
    if (side.scrollHeight > side.clientHeight && thoughtLines > MIN_LINES) set(thoughtLines - 1);
  }

  // ---- Scenes and moments (broadcast-scenes.mjs): layout, banners, the lower-third ----
  // The scene is a data attribute on the frame; CSS moves the stage box and
  // scales the iframe inside it. The iframe itself is never moved or reloaded.
  let scenes = createScenes(Date.now()), bannerId = null;
  function renderScenes(s, now) {
    scenes = stepScenes(scenes, s, now);
    if (frame.dataset.scene !== scenes.scene) {
      frame.dataset.scene = scenes.scene;
      // Panels fade back in after the layout swap (a CSS animation, restarted here).
      frame.classList.remove("scene-in"); void frame.offsetWidth; frame.classList.add("scene-in");
    }
    renderBanner(scenes.banner);
    frame.classList.toggle("lower-third-on", scenes.lowerThird);
    if (scenes.camera !== frame.dataset.camera) { frame.dataset.camera = scenes.camera; aim(); }
  }
  function renderBanner(banner) {
    const node = $("banner");
    if (!banner) { bannerId = null; node.classList.remove("show"); return; }
    if (banner.id === bannerId) return;
    bannerId = banner.id;
    node.dataset.kind = banner.kind;
    setText($("bannerLabel"), banner.label);
    setText($("bannerText"), banner.text);
    $("bannerNote").hidden = !banner.note;
    if (banner.note) setText($("bannerNote"), banner.note);
    const box = $("bannerArt");
    if (banner.item) { box.className = "banner-art slot-box"; art(box, banner.item); }
    else { delete box.dataset.art; box.className = "banner-art"; box.replaceChildren(el("i", `glyph ${GLYPHS.has(banner.icon) ? banner.icon : "dot"}`)); }
    node.classList.remove("show"); void node.offsetWidth; node.classList.add("show");
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
    if (!repaint) { reachable = true; botLive = connected; lastReceivedAt = now; if (connected) lastLiveAt = now; }
    lastState = s;
    renderOffline(s, reachable && !botLive, now);
    renderOverlay(s, connected, now);
    renderInventory(connected ? s.inventory : null, connected, now);
    renderEquipment(connected ? s.equipment : null);
    renderStory(s.story || [], now);
    renderStats(s.world);
    renderSlots(s);
    // The bound panels refine what renderSlots showed: offline, busy and building states.
    renderVitals(s.vitals);
    renderNow(s, connected, now);
    renderThinking(s, connected);
    renderBuild(s.build, connected);
    renderProgress(s);
    renderBrain(s.brain, s.uptimeSeconds);
    if (!repaint) renderScenes(s, now);
    fitColumn();
    if (repaint) return;
    viewerSession.update({ reachable: true, connected, running: s.viewer?.status === "running", session: s.viewer?.session ?? "unknown" });
    setText($("viewerStatus"), viewerSession.state);
    renderFreshness();
  }

  // ---- The 3D frame: the same mount/retry lifecycle as the viewer shell ----
  // The scene machine's camera shot (follow until it says otherwise) is sent
  // on every mount and every cut, so the streamer never presses a key.
  let viewerFrame = document.querySelector(".stage iframe");
  function aim() {
    try {
      const win = viewerFrame.contentWindow;
      win.dispatchEvent(new win.CustomEvent("bob-cam", { detail: scenes.camera ?? "follow" }));
    } catch {}
  }
  const viewerSession = new ViewerSession({
    mode: "3d", origin: window.location.origin,
    token: frameToken, random: Math.random, schedule: (run, ms) => setTimeout(run, ms), cancel: (timer) => clearTimeout(timer),
    mount(token) {
      const replacement = viewerFrame.cloneNode(false);
      replacement.removeAttribute("src"); viewerFrame.replaceWith(replacement); viewerFrame = replacement;
      viewerFrame.addEventListener("load", aim);
      viewerFrame.src = `/viewer/?visit=${token}`;
      return viewerFrame.contentWindow;
    },
    release() { viewerFrame.removeAttribute("src"); viewerFrame.src = "about:blank"; },
    changed(state) {
      setText($("viewerStatus"), state);
      renderVeil(state);
      if (state === "connected") aim();
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
    // Without a fresh answer the page can't vouch for the offline scene; the veil says "Reconnecting".
    renderOffline(null, false, Date.now());
    renderScenes(null, Date.now());
    viewerSession.update({ reachable: false, connected: false, running: false, session: lastState?.viewer?.session ?? "unknown" });
    setText($("viewerStatus"), viewerSession.state);
    renderFreshness();
  }

  renderVeil(viewerSession.state);
  void refresh();
  // The minimap polls its own route and shows its slot itself; a failure there never stops the page.
  import("./broadcast-minimap.mjs").then(({ mountMinimap }) => mountMinimap(document.querySelector('[data-panel="minimap"]'))).catch(() => {});
  // Likewise the picture-in-picture of home.
  import("./broadcast-pip.mjs").then(({ mountPip }) => mountPip($("pip"))).catch(() => {});
  setInterval(() => {
    if (document.hidden) return;
    void refresh();
    // Silence counts as a lost connection even while requests hang unanswered.
    if (reachable && lastReceivedAt !== null && Date.now() - lastReceivedAt > STALE_AFTER_MS) markUnreachable();
  }, 1000);
})();
