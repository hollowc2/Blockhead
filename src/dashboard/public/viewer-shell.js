(() => {
  const $ = (id) => document.getElementById(id);
  const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
  const setText = (id, value, fallback) => { $(id).textContent = text(value, fallback); };
  const show = (id, visible) => { $(id).hidden = !visible; };
  let mode = null;
  const ICONS = { day: "☀️", night: "🌙", goal: "🎯", build: "🏠", death: "💀", respawn: "✨", gather: "⛏️", tool: "🔧", hostile: "👾", explore: "🧭", home: "🛏️", fight: "🛡️", milestone: "🏆" };
  const compact = (n) => typeof n !== "number" ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  };
  const el = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; };
  const glyph = (icon) => el("span", `glyph ${icon}`, ICONS[icon] || "•");

  // Panel tabs; the choice is a per-viewer convenience, so storage failures are fine.
  const panel = $("panel");
  function selectTab(name) {
    panel.dataset.active = name;
    document.querySelectorAll("[data-tab-button]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.tabButton === name)));
    if (name === "story") { $("storyUnseen").hidden = true; }
    if (name === "jobs") { $("jobsAlert").hidden = true; }
    if (name === "map") startMapPolling(); else stopMapPolling();
    try { localStorage.setItem("cobblebob.tab", name); } catch {}
  }
  document.querySelectorAll("[data-tab-button]").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tabButton)));
  let savedTab = null;
  try { savedTab = localStorage.getItem("cobblebob.tab"); } catch {}

  const itemName = (name) => name.replace(/^minecraft:/, "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  // Reuse the viewer's bundled Minecraft artwork, including the texture aliases
  // for blocks such as stairs and slabs. Keep a visible fallback for newer items.
  const textureRoot = "/viewer/textures/1.21.4/";
  const itemTextures = new Map();
  const slotTextures = { hand: "sword", "off-hand": "shield", head: "helmet", torso: "chestplate", legs: "leggings", feet: "boots" };
  let lastGearState = {};
  function itemIcon(name, slot, previous) {
    const key = name?.replace(/^minecraft:/, "");
    // These items use entity models rather than a flat inventory texture.
    const symbol = key === "shield" ? "🛡️" : key?.endsWith("_bed") ? "🛏️" : ["chest", "trapped_chest", "ender_chest", "barrel"].includes(key) ? "📦" : null;
    const texture = key ? symbol ? null : itemTextures.get(key) : `gui/sprites/container/slot/${slotTextures[slot]}.png`;
    const artwork = JSON.stringify([key ?? null, texture ?? null]);
    if (previous?.dataset.artwork === artwork) return previous;
    const icon = el("span", `item-icon${key ? "" : " item-icon-empty"}`);
    icon.dataset.artwork = artwork;
    icon.setAttribute("aria-hidden", "true");
    icon.append(el("span", "item-icon-fallback", symbol || (key ? "◇" : "")));
    if (texture) {
      const img = el("img");
      img.alt = "";
      img.width = 32;
      img.height = 32;
      img.addEventListener("load", () => icon.classList.add("item-icon-loaded"), { once: true });
      img.addEventListener("error", () => img.remove(), { once: true });
      img.src = textureRoot + texture;
      icon.append(img);
    }
    return icon;
  }
  fetch(textureRoot + "items_textures.json").then((response) => {
    if (!response.ok) throw new Error("Item artwork unavailable");
    return response.json();
  }).then((items) => {
    for (const item of items) {
      const texture = item.texture.replace(/^minecraft:/, "").replace(/^block\//, "blocks/").replace(/^item\//, "items/");
      if (/^(?:items|blocks)\/[a-z0-9_]+$/.test(texture)) itemTextures.set(item.name, `${texture}.png`);
    }
    renderGear(lastGearState);
  }).catch(() => {}); // Labels and fallback icons remain useful if artwork fails.

  const equipmentRows = new Map();
  const inventoryRows = new Map();
  function updateItem(value, name, slot, label) {
    const previous = value.firstElementChild;
    const icon = itemIcon(name, slot, previous);
    if (!previous) value.append(icon, el("span", "item-label", label));
    else {
      if (icon !== previous) value.replaceChild(icon, previous);
      if (value.lastElementChild.textContent !== label) value.lastElementChild.textContent = label;
    }
  }

  function renderGear(s) {
    lastGearState = s;
    const connected = s.connection?.connected === true;
    const equipment = connected ? s.equipment : null;
    const labels = { hand: "Main hand", "off-hand": "Off hand", head: "Helmet", torso: "Chest armor", legs: "Leggings", feet: "Boots" };
    for (const [slot, label] of Object.entries(labels)) {
      let row = equipmentRows.get(slot);
      if (!row) {
        row = el("div");
        row.append(el("dt", "", label), el("dd"));
        equipmentRows.set(slot, row);
      }
      const item = equipment?.[slot];
      const value = row.querySelector("dd");
      value.className = `equipment-item${item ? "" : " sub"}`;
      updateItem(value, item?.name, slot, !equipment ? "Unavailable" : item ? `${itemName(item.name)}${item.count > 1 ? ` ×${item.count}` : ""}` : "Empty");
    }
    // Keep loaded image nodes alive across status polls and count changes.
    const gearRoot = $("equipment");
    if (gearRoot.firstElementChild !== equipmentRows.get("hand")) gearRoot.replaceChildren(...equipmentRows.values());
    const inventory = connected ? s.inventory : null;
    setText("inventoryCount", inventory ? `${inventory.totalItems} items` : null);
    const items = inventory?.items || [];
    const inventoryRoot = $("inventoryItems");
    const names = new Set(items.map((item) => item.name));
    for (const [name, row] of inventoryRows) if (!names.has(name)) { row.remove(); inventoryRows.delete(name); }
    if (!items.length) {
      const message = inventory ? "Inventory is empty." : connected ? "Inventory data unavailable." : "Inventory unavailable while CobbleBob is offline.";
      if (inventoryRoot.textContent !== message) inventoryRoot.replaceChildren(el("li", "sub", message));
      return;
    }
    if (!inventoryRows.size) inventoryRoot.replaceChildren();
    items.forEach((item, index) => {
      let row = inventoryRows.get(item.name);
      if (!row) {
        row = el("li");
        row.append(el("span", "inventory-item"), el("b", "mono"));
        inventoryRows.set(item.name, row);
      }
      updateItem(row.firstElementChild, item.name, undefined, itemName(item.name));
      const count = `×${item.count}`;
      if (row.lastElementChild.textContent !== count) row.lastElementChild.textContent = count;
      if (inventoryRoot.children[index] !== row) inventoryRoot.insertBefore(row, inventoryRoot.children[index] || null);
    });
  }

  function toast(icon, label, message, kind = "") {
    const root = $("toasts");
    const node = el("div", `toast ${kind}`);
    const body = el("div");
    body.append(el("b", "", label), el("span", "", message));
    node.append(glyph(icon), body);
    root.prepend(node);
    while (root.children.length > 3) root.lastElementChild.remove();
    setTimeout(() => node.remove(), 6200);
  }

  // Story feed: newest first; entries newer than the last poll are "fresh".
  let lastStoryId = null;
  function renderStory(entries) {
    const list = $("story");
    const newest = entries.length ? entries[entries.length - 1].id : 0;
    // A restarted bot numbers its story from 1 again; treat that as a fresh start.
    const firstLoad = lastStoryId === null || newest < lastStoryId;
    const fresh = entries.filter((entry) => !firstLoad && entry.id > lastStoryId);
    if (entries.length === 0) { lastStoryId = 0; return; }
    list.replaceChildren(...entries.slice().reverse().map((entry) => {
      const row = el("li", entry.highlight ? "highlight" : "");
      if (fresh.includes(entry)) row.classList.add("fresh");
      row.append(glyph(entry.icon), el("span", "", entry.text), el("time", "", ago(entry.at)));
      row.lastChild.dateTime = entry.at;
      return row;
    }));
    for (const entry of fresh) if (entry.highlight) toast(entry.icon, entry.icon === "death" ? "Oof" : "Just now", entry.text, entry.icon === "death" ? "death-toast" : "");
    if (fresh.length && panel.dataset.active !== "story") $("storyUnseen").hidden = false;
    lastStoryId = newest;
  }

  // Lifetime stats and milestones; a milestone that flips to unlocked gets a toast.
  let unlocked = null;
  function renderWorld(world) {
    if (!world) return;
    $("dayChip").hidden = world.day === null;
    $("dayCount").textContent = `Day ${world.day ?? "—"}`;
    $("statDay").textContent = world.day ?? "—";
    $("statMined").textContent = compact(world.blocksMined);
    $("statKills").textContent = compact(world.mobsKilled);
    $("statDistance").textContent = typeof world.distanceKm === "number" ? `${compact(Math.round(world.distanceKm))} km` : "—";
    $("statBuilds").textContent = compact(world.buildsCompleted);
    $("statDeaths").textContent = compact(world.deaths);
    $("nemesis").hidden = !world.nemesis;
    $("nemesis").textContent = world.nemesis ? `Nemesis: the ${world.nemesis}. It has the most wins against CobbleBob.` : "";

    const milestones = world.milestones || [];
    const done = milestones.filter((m) => m.unlocked);
    $("milestoneCount").textContent = `${done.length}/${milestones.length}`;
    const ordered = done.concat(milestones.filter((m) => !m.unlocked).sort((a, b) => b.progress - a.progress));
    $("milestones").replaceChildren(...ordered.map((m) => {
      const item = el("li", `milestone${m.unlocked ? " unlocked" : ""}`);
      item.title = m.unlocked ? `${m.title}: unlocked` : `${m.title}: ${Math.round(m.progress * 100)}%`;
      const text = el("div");
      text.append(el("strong", "", m.title), el("small", "", m.description));
      if (!m.unlocked) { const bar = el("div", "mini"); const fill = el("i"); fill.style.width = `${Math.round(m.progress * 100)}%`; bar.append(fill); text.append(bar); }
      item.append(el("span", "medal", "🏆"), text);
      return item;
    }));
    const now = new Set(done.map((m) => m.id));
    if (unlocked !== null) for (const m of done) if (!unlocked.has(m.id)) toast("milestone", "Milestone unlocked", m.title, "milestone-toast");
    unlocked = now;
  }

  function applyMode(isPublic) {
    if (mode === isPublic) return;
    mode = isPublic;
    // The public listener only sends a redacted status; hide private panels.
    document.body.classList.toggle("public", isPublic);
    // On-demand cards (preview, last visit) stay hidden until they have content.
    document.querySelectorAll("[data-private]").forEach((el) => { el.hidden = isPublic || (el.hasAttribute("data-on-demand") && el.hidden); });
    document.querySelectorAll("[data-public]").forEach((el) => { el.hidden = !isPublic; });
    // The owner-only tabs do not exist on the public page.
    const allowed = isPublic ? ["live", "gear", "story", "stats"] : ["live", "jobs", "map", "gear", "story", "stats"];
    const wanted = savedTab ?? panel.dataset.active;
    savedTab = null;
    selectTab(allowed.includes(wanted) ? wanted : "live");
    if (!isPublic) checkVisit();
  }

  // Minecraft-style icon row: 10 icons, each worth 2 points.
  function icons(id, value) {
    const root = $(id);
    if (root.children.length !== 10) root.replaceChildren(...Array.from({ length: 10 }, () => document.createElement("i")));
    const points = typeof value === "number" ? Math.max(0, Math.min(20, Math.round(value))) : 0;
    Array.from(root.children).forEach((icon, i) => {
      const left = points - i * 2;
      icon.className = left >= 2 ? "full" : left === 1 ? "half" : "";
    });
  }

  function badge(id, status) {
    const el = $(id);
    el.hidden = !status;
    if (status) { el.textContent = String(status).replace(/_/g, " "); el.className = `badge ${status}`; }
  }

  function duration(seconds) {
    if (typeof seconds !== "number") return null;
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function setConnection(state, label) {
    $("connection").className = `pill pill-${state}`;
    $("connectionText").textContent = label;
  }

  function render(s) {
    applyMode(Boolean(s.public));
    publicAvailable = { questions: !!s.public && !!s.interactions?.questions, actions: !!s.public && !!s.interactions?.actions };
    updatePublicButtons();
    renderStory(s.story || []);
    renderWorld(s.world);
    renderGear(s);
    lastState = s;
    if (!s.public) { renderJobs(s.jobs); renderGearDetail(s.connection?.connected === true ? s.gear : null); }
    const self = s.self || {};
    const connected = s.connection?.connected === true;
    const wasCommandConnected = commandConnected;
    commandConnected = connected && !s.public;
    if (commandConnected !== wasCommandConnected && !commandBusy) commandStatus.textContent = commandConnected ? "Ready for a task." : "CobbleBob is offline.";
    updateCommandButtons();
    if (!s.public) renderCommandReplies(s.recentChat || []);
    setConnection(connected ? "ok" : "down", connected ? "Online" : "Offline");

    icons("hearts", self.health); icons("food", self.hunger);
    setText("health", self.health); setText("hunger", self.hunger);
    setText("dimension", self.dimension?.replace(/^minecraft:/, "").replace(/_/g, " "));
    setText("time", self.timePhase);
    $("timeIcon").className = `time-icon ${self.timePhase || ""}`;
    setText("viewerStatus", s.viewer?.status);

    const viewerDown = !connected || s.viewer?.status === "failed" || s.viewer?.status === "stopped";
    show("offline", viewerDown);
    $("offlineReason").textContent = !connected ? "Waiting for CobbleBob to reconnect…" : "The 3D viewer is not running right now.";

    if (s.public) {
      setText("healthPublic", typeof self.health === "number" ? `${self.health} / 20` : null);
      setText("hungerPublic", typeof self.hunger === "number" ? `${self.hunger} / 20` : null);
      setText("dimensionPublic", $("dimension").textContent);
      setText("timePublic", self.timePhase);
      return;
    }

    const p = self.position;
    $("position").textContent = p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : "—";

    setText("action", s.action?.label || s.background?.label, "Idle");
    setText("goal", s.goal?.description, "No active goal"); badge("goalStatus", s.goal?.status);
    setText("goalStep", s.goal?.currentStep); show("goalStep", Boolean(s.goal?.currentStep));
    setText("task", s.task?.objective, "No active task"); badge("taskStatus", s.task?.status);
    const phase = s.task?.phase ? `Phase: ${s.task.phase}${s.task.attempts > 1 ? ` · attempt ${s.task.attempts}` : ""}` : null;
    setText("taskPhase", phase); show("taskPhase", Boolean(phase));

    const build = s.buildProject;
    const world = s.worldProject;
    show("buildCard", Boolean(build || world));
    if (build) {
      const total = build.totalOperations || 0, done = build.verifiedOperations || 0;
      setText("buildName", (build.userGoal || build.structureType || "").replace(/_/g, " "));
      $("buildBar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      const blocked = build.blocker || build.lastBlockingReason;
      setText("buildDetail", `${build.phase?.label || build.status} · ${done}/${total} blocks${blocked ? ` · ${blocked}` : ""}`);
    } else if (world) {
      setText("buildName", String(world.kind).replace(/_/g, " "));
      $("buildBar").style.width = world.status === "completed" ? "100%" : "0%";
      setText("buildDetail", `${world.phase?.label || world.status}${world.blocker ? ` · ${world.blocker}` : ""}`);
    }

    const llm = s.llmActivity || {};
    const llmEl = $("llm");
    llmEl.textContent = llm.thinking ? "Thinking…" : text(llm.state, "Standing by").replace(/_/g, " ");
    llmEl.className = `mind-state${llm.thinking ? " thinking" : ""}`;
    setText("rationale", llm.lastRationale, "No decisions yet.");
    const meta = [llm.model, llm.lastLatencyMs ? `${(llm.lastLatencyMs / 1000).toFixed(1)}s` : null, llm.lastFailure ? `last failure: ${llm.lastFailure.kind}` : null].filter(Boolean);
    $("llmMeta").textContent = meta.join(" · ");

    const danger = s.danger;
    const dangerEl = $("danger");
    if (!danger) { dangerEl.textContent = "No threat data"; dangerEl.className = "strong"; $("dangerDetail").textContent = ""; }
    else {
      // hostileCount covers every loaded mob, so lead with the nearest one.
      const near = danger.nearestHostile;
      const level = !near || near.distance >= 24 ? "low" : near.distance >= 12 ? "mid" : "high";
      dangerEl.textContent = near ? `${near.type.replace(/_/g, " ")} ${Math.round(near.distance)} m away` : "All clear";
      dangerEl.className = `strong danger-${level}`;
      $("dangerDetail").textContent = danger.hostileCount ? `${danger.hostileCount} hostile${danger.hostileCount === 1 ? "" : "s"} tracked · danger ${Math.round(danger.score * 100)}%` : "";
    }
    setText("uptime", duration(s.process?.uptimeSeconds));
  }

  async function refresh() {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      render(await response.json());
    } catch {
      setConnection("wait", "Reconnecting…");
      renderGear({});
      publicAvailable = { questions: false, actions: false };
      updatePublicButtons();
      commandConnected = false;
      updateCommandButtons();
    }
  }

  function toggleFullscreen() {
    const stage = $("stage");
    if (document.fullscreenElement) document.exitFullscreen?.();
    else stage.requestFullscreen?.();
  }
  // The viewer's recenter hotkey listens inside the iframe, so it only fired
  // after clicking the 3D view; forward R (and the button) into the frame.
  const viewerFrame = document.querySelector(".stage iframe");
  // Camera modes (orbit, eyes, follow) live in the frame's camera; the shell
  // owns the mode and pushes it in, including after the frame reloads.
  const viewButtons = { eyes: $("povToggle"), follow: $("followToggle") };
  let view = "orbit";
  function sendView() {
    try {
      const win = viewerFrame.contentWindow;
      win.dispatchEvent(new win.CustomEvent("bob-cam", { detail: view }));
    } catch {}
  }
  function setView(mode) {
    view = mode;
    for (const [name, button] of Object.entries(viewButtons)) button.setAttribute("aria-pressed", String(name === mode));
    sendView();
  }
  const toggleView = (mode) => setView(view === mode ? "orbit" : mode);
  viewerFrame.addEventListener("load", sendView);
  function findBob() {
    if (view !== "orbit") { setView("orbit"); return; }
    try {
      const win = viewerFrame.contentWindow;
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "r" }));
    } catch {}
  }
  $("fullscreen").addEventListener("click", toggleFullscreen);
  $("findBob").addEventListener("click", findBob);
  $("povToggle").addEventListener("click", () => toggleView("eyes"));
  $("followToggle").addEventListener("click", () => toggleView("follow"));
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "f" || event.key === "F") toggleFullscreen();
    else if (event.key === "r" || event.key === "R") findBob();
    else if (event.key === "v" || event.key === "V") toggleView("eyes");
    else if (event.key === "t" || event.key === "T") toggleView("follow");
  });

  // Viewer Q&A (private page only): the server answers through the LLM.
  let commandConnected = false, commandBusy = false;
  const commandForm = $("commandForm"), commandInput = $("commandInput"), commandSend = $("commandSend"), commandStatus = $("commandStatus");
  const commandButtons = [...document.querySelectorAll("#commandQuick button")];
  function updateCommandButtons() {
    commandSend.disabled = !commandConnected || commandBusy;
    $("commandPreview").disabled = !commandConnected || previewBusy;
    commandButtons.forEach((button) => { button.disabled = !commandConnected || (commandBusy && button.dataset.command !== "stop"); });
  }
  function renderCommandReplies(entries) {
    const replies = entries.filter((entry) => entry.sender === "reply").slice(-4);
    const key = JSON.stringify(replies);
    const root = $("commandReplies");
    if (root.dataset.replies === key) return;
    root.dataset.replies = key;
    root.replaceChildren(...replies.map((entry) => el("p", "msg msg-bob", entry.message)));
  }
  async function sendCommand(command) {
    if (!command || !commandConnected || (commandBusy && command !== "stop")) return;
    commandBusy = true;
    updateCommandButtons();
    commandStatus.textContent = "Sending task…";
    try {
      const response = await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) });
      const body = await response.json().catch(() => ({}));
      commandStatus.textContent = response.ok ? body.answer : body.error || "Couldn't send this task.";
      if (response.ok && commandInput.value.trim() === command) commandInput.value = "";
    } catch {
      commandStatus.textContent = "Couldn't confirm delivery. Check Bob's task before retrying.";
    } finally {
      commandBusy = false;
      updateCommandButtons();
    }
  }
  commandForm.addEventListener("submit", (event) => { event.preventDefault(); void sendCommand(commandInput.value.trim()); });
  commandButtons.forEach((button) => button.addEventListener("click", () => { void sendCommand(button.dataset.command); }));

  const chatLog = $("chatLog"), chatForm = $("chatForm"), chatInput = $("chatInput"), chatSend = $("chatSend");
  function addMessage(kind, value) {
    chatLog.querySelector(".chat-empty")?.remove();
    const row = document.createElement("p");
    row.className = `msg msg-${kind}`;
    row.textContent = value;
    chatLog.append(row);
    chatLog.scrollTop = chatLog.scrollHeight;
    return row;
  }
  let quickAsked = false;
  const quickButtons = [...document.querySelectorAll("#chatQuick button")];
  const setBusy = (busy) => { chatSend.disabled = busy; quickButtons.forEach((button) => { button.disabled = busy; }); };
  quickButtons.forEach((button) => button.addEventListener("click", () => {
    if (chatSend.disabled) return;
    chatInput.value = button.textContent;
    quickAsked = true;
    chatForm.requestSubmit();
  }));
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = chatInput.value.trim();
    if (!question || chatSend.disabled) return;
    chatInput.value = "";
    setBusy(true);
    addMessage("you", question);
    const pending = addMessage("bob", "Thinking");
    pending.classList.add("msg-pending");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.answer) { pending.textContent = body.answer; pending.classList.remove("msg-pending"); }
      else { pending.remove(); addMessage("error", body.error || "CobbleBob couldn't answer right now."); }
    } catch {
      pending.remove(); addMessage("error", "Couldn't reach CobbleBob.");
    } finally {
      setBusy(false);
      // Refocusing after a chip tap would pop the keyboard on phones.
      if (!quickAsked) chatInput.focus();
      quickAsked = false;
    }
  });

  let publicAvailable = { questions: false, actions: false }, publicBusy = false;
  const publicButtons = [...document.querySelectorAll("#publicActions button")];
  function updatePublicButtons() {
    $("publicAsk").disabled = publicBusy || !publicAvailable.questions;
    publicButtons.forEach(button => { button.disabled = publicBusy || !publicAvailable.actions; });
  }
  async function publicSubmit(feature, body) {
    if (publicBusy || !(feature === "question" ? publicAvailable.questions : publicAvailable.actions)) return;
    publicBusy = true; updatePublicButtons();
    $("publicReply").textContent = "Sending…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8500);
    try {
      const response = await fetch(`/api/public/${feature}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json();
      $("publicReply").textContent = result.text || "Public interaction unavailable.";
    } catch { $("publicReply").textContent = feature === "action" ? "Delivery could not be confirmed." : "Couldn't reach Bob. Try again later."; }
    finally { clearTimeout(timer); publicBusy = false; updatePublicButtons(); }
  }
  $("publicQuestionForm").addEventListener("submit", event => { event.preventDefault(); void publicSubmit("question", { question: $("publicQuestion").value }); });
  publicButtons.forEach(button => button.addEventListener("click", () => { void publicSubmit("action", { action: button.dataset.action }); }));

  // ---- Shared helpers for the owner-only panels ----
  let lastState = null;
  const since = (iso) => {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 45 ? "just now" : `${ago(iso)} ago`;
  };
  const span = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  };
  const words = (value) => String(value ?? "").replace(/^minecraft:/, "").replace(/_/g, " ");
  const roman = (n) => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] || String(n);
  async function postJson(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  }
  function keyed(root, key, build) {
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    build();
  }

  // ---- Jobs: live work with owner controls, and tracked commands ----
  const SOURCE_LABEL = { user: "your task", goal: "goal step", owner: "your goal", background: "self-chosen", director: "self-chosen", maintenance: "upkeep", system: "system" };
  const STATE_LABEL = { active: "running", queued: "queued", paused: "paused", blocked: "blocked" };
  let queueFilter = "all", jobBusy = false;
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    queueFilter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    $("jobQueue").dataset.key = "";
    renderJobs(lastState?.jobs);
  }));
  async function jobAction(job, action) {
    if (jobBusy) return;
    jobBusy = true;
    $("jobStatus").textContent = "Sending…";
    try {
      const { ok, data } = await postJson("/api/job", { kind: job.kind, id: job.id, action });
      $("jobStatus").textContent = ok ? data.answer : data.error || "That didn't work.";
    } catch {
      $("jobStatus").textContent = "Couldn't reach CobbleBob.";
    } finally {
      jobBusy = false;
      void refresh();
    }
  }
  function jobButton(job, label, action, kind = "") {
    const button = el("button", `job-btn ${kind}`, label);
    button.type = "button";
    button.addEventListener("click", () => {
      // Cancelling cannot be undone: the first press asks, the second acts.
      if (action === "cancel" && button.dataset.armed !== "1") {
        button.dataset.armed = "1";
        button.textContent = "Confirm cancel";
        setTimeout(() => { if (button.isConnected) { button.dataset.armed = ""; button.textContent = label; } }, 4000);
        return;
      }
      void jobAction(job, action);
    });
    return button;
  }
  function jobRow(job) {
    const row = el("li", `job job-${job.held ? "paused" : job.state}`);
    const head = el("div", "job-head");
    const status = job.stopping === "cancel" ? "cancelling" : job.stopping === "pause" ? "pausing" : job.held ? "paused by you" : STATE_LABEL[job.state];
    head.append(el("span", "job-title", job.title), el("em", `badge ${job.held ? "paused" : job.state}`, status));
    const meta = [job.kind === "goal" ? "goal" : words(job.type), SOURCE_LABEL[job.source] || job.source,
      job.startedAt ? `started ${since(job.startedAt)}` : `added ${since(job.createdAt)}`];
    const controllable = job.controls.pause || job.controls.resume || job.controls.cancel;
    if (!controllable && job.priority >= 100) meta.push("safety reflex");
    row.append(head, el("p", "sub", meta.filter(Boolean).join(" · ")));
    if (job.detail) row.append(el("p", "job-detail", job.detail));
    if (controllable) {
      const actions = el("div", "job-actions");
      if (job.controls.pause) actions.append(jobButton(job, "Pause", "pause"));
      if (job.controls.resume) actions.append(jobButton(job, "Resume", "resume", "go"));
      if (job.controls.cancel) actions.append(jobButton(job, "Cancel", "cancel", "danger"));
      row.append(actions);
    }
    return row;
  }
  function list(root, items, empty, build) {
    root.replaceChildren(...(items.length ? items.map(build) : [el("li", "sub", empty)]));
  }
  const COMMAND_LABEL = { waiting: "waiting", answered: "answered", queued: "queued", running: "running", paused: "paused", blocked: "blocked", done: "done", failed: "failed", cancelled: "cancelled" };
  function commandRow(command) {
    const row = el("li", `command command-${command.status}`);
    const head = el("div", "job-head");
    head.append(el("span", "job-title", `“${command.text}”`), el("em", `badge ${command.status}`, COMMAND_LABEL[command.status] || command.status));
    const timing = [`sent ${since(command.at)}`];
    if (command.finishedAt) timing.push(`took ${span(Date.parse(command.finishedAt) - Date.parse(command.at))}`);
    else if (["running", "queued", "paused", "blocked"].includes(command.status)) timing.push(`${span(Date.now() - Date.parse(command.at))} so far`);
    row.append(head, el("p", "sub", timing.join(" · ")));
    if (command.steps.length) {
      const steps = el("ul", "steps");
      for (const step of command.steps) {
        const item = el("li");
        item.append(el("span", "", step.title), el("em", `badge ${step.status}`, words(step.status)));
        steps.append(item);
      }
      row.append(steps);
    } else if (command.status === "waiting") row.append(el("p", "job-detail", "Waiting for CobbleBob to pick it up…"));
    for (const reply of command.replies.slice(-2)) row.append(el("p", "msg msg-bob", reply));
    return row;
  }
  function renderJobs(jobs) {
    if (!jobs) return;
    const minute = Math.floor(Date.now() / 60000);
    const active = jobs.active ? [jobs.active] : [];
    keyed($("jobActive"), JSON.stringify([active, minute]), () => list($("jobActive"), active, "Nothing running.", jobRow));
    $("jobActiveCount").textContent = active.length ? "1" : "";
    keyed($("jobGoals"), JSON.stringify([jobs.goals, minute]), () => list($("jobGoals"), jobs.goals, "No goals.", jobRow));
    $("jobGoalCount").textContent = jobs.goals.length ? String(jobs.goals.length) : "";
    const queue = jobs.tasks.filter((job) => queueFilter === "all" || (queueFilter === "paused" ? job.held || job.state === "paused" : job.state === queueFilter && !job.held));
    keyed($("jobQueue"), JSON.stringify([queue, queueFilter, minute]), () => list($("jobQueue"), queue, queueFilter === "all" ? "The queue is empty." : `Nothing ${queueFilter}.`, jobRow));
    $("jobQueueCount").textContent = jobs.tasks.length ? String(jobs.tasks.length) : "";
    const commands = jobs.commands || [];
    keyed($("jobCommands"), JSON.stringify([commands, minute]), () => list($("jobCommands"), commands, "No commands sent from the viewer yet.", commandRow));
    renderLatestCommand(commands[0]);
    const trouble = jobs.tasks.some((job) => job.state === "blocked") || commands.some((command) => command.status === "blocked" || command.status === "failed");
    if (panel.dataset.active !== "jobs") $("jobsAlert").hidden = !trouble;
  }
  function renderLatestCommand(command) {
    const root = $("commandLatest");
    root.hidden = !command;
    if (!command) return;
    keyed(root, JSON.stringify([command.id, command.status, command.steps.length]), () => {
      const line = el("p", "sub");
      line.append(el("span", "", `Last task “${command.text.length > 40 ? `${command.text.slice(0, 39)}…` : command.text}”`), el("em", `badge ${command.status}`, COMMAND_LABEL[command.status] || command.status));
      const open = el("button", "link-btn", "Track in Jobs");
      open.type = "button";
      open.addEventListener("click", () => selectTab("jobs"));
      root.replaceChildren(line, open);
    });
  }

  // ---- Gear condition and supply readiness ----
  function conditionNode(item) {
    const node = el("div", "cond");
    if (item?.durability) {
      const pct = item.durability.percent;
      const bar = el("div", `mini dura ${pct < 25 ? "low" : pct < 50 ? "mid" : ""}`);
      const fill = el("i");
      fill.style.width = `${pct}%`;
      bar.append(fill);
      node.append(bar, el("small", "", `${pct}% · ${item.durability.remaining}/${item.durability.max} uses`));
    }
    if (item?.enchantments?.length) node.append(el("small", "enchants", item.enchantments.map((e) => `${words(e.name)} ${roman(e.level)}`).join(", ")));
    return node;
  }
  function renderGearDetail(gear) {
    for (const [slot, row] of equipmentRows) {
      let cond = row.querySelector(".cond");
      const item = gear?.equipment?.[slot];
      const next = conditionNode(item);
      if (cond && cond.innerHTML === next.innerHTML) continue;
      if (cond) cond.replaceWith(next); else row.append(next);
    }
    $("slotSummary").textContent = gear ? `${gear.slots.free} of ${gear.slots.total} slots free.` : "";
    if (!gear) {
      keyed($("readiness"), "none", () => list($("readiness"), [], "Gear data unavailable while CobbleBob is offline.", () => null));
      $("readyCount").textContent = "—";
      return;
    }
    const ready = gear.readiness.filter((check) => check.ok).length;
    $("readyCount").textContent = `${ready}/${gear.readiness.length}`;
    keyed($("readiness"), JSON.stringify(gear.readiness), () => list($("readiness"), gear.readiness, "", (check) => {
      const row = el("li", check.ok ? "ok" : "bad");
      row.append(el("span", "tick", check.ok ? "✓" : "✗"), el("span", "", check.label), el("b", "mono", check.detail));
      return row;
    }));
    keyed($("supplies"), JSON.stringify(gear.supplies), () => $("supplies").replaceChildren(...gear.supplies.map((supply) => {
      const row = el("tr");
      const short = supply.target !== null && supply.carried + supply.stored < supply.target;
      row.append(el("td", "", supply.label), el("td", "mono", String(supply.carried)), el("td", "mono", String(supply.stored)), el("td", `mono${short ? " short" : ""}`, supply.target === null ? "—" : String(supply.target)));
      return row;
    })));
    $("suppliesSeen").textContent = gear.storageSeenAt ? `Carried versus stored in the home chests (chests last checked ${since(gear.storageSeenAt)}).` : "Carried versus stored. The home chests haven't been opened yet, so stored counts are unknown.";
    keyed($("toolCondition"), JSON.stringify(gear.tools), () => list($("toolCondition"), gear.tools, "No spare tools or armor carried.", (item) => {
      const row = el("li");
      const label = el("span", "inventory-item");
      label.append(itemIcon(item.name), el("span", "item-label", `${itemName(item.name)}${item.count > 1 ? ` ×${item.count}` : ""}`));
      row.append(label, conditionNode(item));
      return row;
    }));
  }

  // ---- Build preview: compile a build without starting it ----
  let previewBusy = false, preview = null, ghostVisible = true;
  function sendGhost() {
    try {
      const win = viewerFrame.contentWindow;
      const detail = preview && ghostVisible ? { palette: preview.ghost.palette, blocks: preview.ghost.blocks, footprint: preview.footprint, facing: preview.facing } : null;
      win.dispatchEvent(new win.CustomEvent("bob-preview", { detail }));
    } catch {}
  }
  viewerFrame.addEventListener("load", () => { if (preview) setTimeout(sendGhost, 1500); });
  function clearPreview() {
    preview = null;
    $("previewCard").hidden = true;
    sendGhost();
  }
  function showPreview(next) {
    preview = next;
    ghostVisible = true;
    $("previewLook").textContent = "Hide ghost";
    $("previewName").textContent = `${next.name}${next.resumes ? " (resumes)" : ""}`;
    const f = next.footprint;
    $("previewFootprint").textContent = `${f.width} × ${f.depth}, ${f.height} tall`;
    $("previewFacing").textContent = next.facing ? next.facing : "no door";
    $("previewBlocks").textContent = `${next.blocks}${next.site.placed ? ` (${next.site.placed} done)` : ""}`;
    const bob = lastState?.self?.position;
    const distance = bob ? Math.round(Math.hypot((f.minX + f.maxX) / 2 - bob.x, (f.minZ + f.maxZ) / 2 - bob.z)) : null;
    $("previewSite").textContent = `${f.minX}, ${f.minY}, ${f.minZ}${distance !== null ? ` · ${distance} m away` : ""}`;
    $("previewMaterials").replaceChildren(...next.materials.map((m) => {
      const row = el("tr");
      row.append(el("td", "", words(m.material)), el("td", "mono", String(m.needed)), el("td", "mono", String(m.carried)), el("td", "mono", String(m.stored)), el("td", `mono${m.missing ? " short" : " ok"}`, m.missing ? String(m.missing) : "✓"));
      return row;
    }));
    const notes = [...next.notes];
    if (next.ghost.truncated) notes.push("The ghost shows the first part of a very large build.");
    $("previewNotes").replaceChildren(...notes.map((note) => el("li", "", note)));
    $("previewCard").hidden = false;
    sendGhost();
  }
  async function previewBuild() {
    const command = commandInput.value.trim();
    if (!command) { commandStatus.textContent = "Type a build request first, like “build a tower at home”."; return; }
    previewBusy = true;
    updateCommandButtons();
    commandStatus.textContent = "Planning the build…";
    try {
      const { ok, data } = await postJson("/api/preview", { command });
      if (ok && data.preview) { showPreview(data.preview); commandStatus.textContent = "Preview ready. Nothing has started yet."; }
      else commandStatus.textContent = data.error || "Couldn't preview that build.";
    } catch {
      commandStatus.textContent = "Couldn't reach CobbleBob for a preview.";
    } finally {
      previewBusy = false;
      updateCommandButtons();
    }
  }
  $("commandPreview").addEventListener("click", () => { void previewBuild(); });
  $("previewClear").addEventListener("click", clearPreview);
  $("previewLook").addEventListener("click", () => {
    ghostVisible = !ghostVisible;
    $("previewLook").textContent = ghostVisible ? "Hide ghost" : "Show ghost";
    sendGhost();
  });
  $("previewStart").addEventListener("click", () => {
    if (!preview) return;
    const command = preview.command;
    clearPreview();
    void sendCommand(command);
  });

  // ---- Map: remembered places, Bob, his destination and route ----
  const map = { data: null, cx: 0, cz: 0, scale: 3, follow: true, timer: null, drag: null, picked: null, layers: { trail: true, path: true, resources: true, chests: true, deaths: true, locations: true } };
  const canvas = $("mapCanvas");
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  async function loadMap() {
    try {
      const response = await fetch("/api/map", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      map.data = await response.json();
      if (map.follow && map.data.bob) { map.cx = map.data.bob.x; map.cz = map.data.bob.z; }
      drawMap();
      renderMapFacts();
    } catch {
      $("mapInfo").textContent = "The map is unavailable right now.";
    }
  }
  function startMapPolling() {
    if (map.timer !== null || mode !== false) return;
    void loadMap();
    map.timer = setInterval(loadMap, 2000);
  }
  function stopMapPolling() {
    if (map.timer !== null) clearInterval(map.timer);
    map.timer = null;
  }
  const resourceColor = (name) => /ore|iron|coal|gold|copper|diamond|redstone|lapis|emerald|quartz/.test(name) ? "#f2b84b"
    : /log|wood|leaves|sapling/.test(name) ? "#3ccf7e" : /stone|cobble|deepslate|granite|diorite|andesite|tuff/.test(name) ? "#b8c4cc"
    : /wheat|carrot|potato|beet|melon|pumpkin|sugar|berry/.test(name) ? "#f58fb0" : "#2ee6f0";
  function project(x, z, w, h) { return [(x - map.cx) * map.scale + w / 2, (z - map.cz) * map.scale + h / 2]; }
  function markers() {
    const d = map.data;
    if (!d) return [];
    const out = [];
    if (d.home) out.push({ ...d.home, type: "home" });
    if (d.build) out.push({ ...d.build, type: "build" });
    if (d.destination) out.push({ ...d.destination, type: "destination" });
    if (map.layers.locations) for (const m of d.locations) out.push({ ...m, type: "spot" });
    if (map.layers.chests) for (const m of d.chests) out.push({ ...m, type: "chest" });
    if (map.layers.resources) for (const m of d.resources) out.push({ ...m, type: "resource" });
    if (map.layers.deaths) for (const m of d.deaths) out.push({ ...m, type: "death" });
    if (d.bob) out.push({ ...d.bob, label: "CobbleBob", type: "bob" });
    return out;
  }
  function drawMap() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width, h = rect.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css("--empty") || "#12181d";
    g.fillRect(0, 0, w, h);
    // Chunk grid: one line per 16 blocks, fading out when zoomed far.
    const step = 16 * map.scale;
    if (step >= 6) {
      g.strokeStyle = "#ffffff10";
      g.lineWidth = 1;
      g.beginPath();
      const [ox, oz] = project(Math.floor((map.cx - w / 2 / map.scale) / 16) * 16, Math.floor((map.cz - h / 2 / map.scale) / 16) * 16, w, h);
      for (let x = ox; x < w; x += step) { g.moveTo(Math.round(x) + .5, 0); g.lineTo(Math.round(x) + .5, h); }
      for (let y = oz; y < h; y += step) { g.moveTo(0, Math.round(y) + .5); g.lineTo(w, Math.round(y) + .5); }
      g.stroke();
    }
    const d = map.data;
    if (!d) return;
    const line = (points, color, width, dash) => {
      if (points.length < 2) return;
      g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.lineJoin = "round"; g.lineCap = "round";
      g.beginPath();
      points.forEach(([x, z], i) => { const [px, py] = project(x, z, w, h); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.stroke();
      g.setLineDash([]);
    };
    if (map.layers.trail) line(d.trail, "#2ee6f066", 2, []);
    if (map.layers.path && d.path.length) line(d.bob ? [[d.bob.x, d.bob.z], ...d.path] : d.path, "#f2b84b", 2.5, [6, 5]);
    else if (map.layers.path && d.destination && d.bob) line([[d.bob.x, d.bob.z], [d.destination.x, d.destination.z]], "#f2b84b88", 1.5, [2, 5]);
    const labels = [];
    for (const m of markers()) {
      const [x, y] = project(m.x, m.z, w, h);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      g.lineWidth = 2;
      if (m.type === "resource") {
        g.fillStyle = resourceColor(m.label); g.strokeStyle = resourceColor(m.label);
        g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2);
        if (m.depleted) g.stroke(); else g.fill();
      } else if (m.type === "chest") {
        g.fillStyle = "#a0794a"; g.fillRect(x - 3.5, y - 3.5, 7, 7); g.strokeStyle = "#1d252c"; g.lineWidth = 1; g.strokeRect(x - 3.5, y - 3.5, 7, 7);
      } else if (m.type === "death") {
        g.strokeStyle = m.recovered ? "#ef5a5a88" : "#ef5a5a"; g.lineWidth = 2.4;
        g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke();
      } else if (m.type === "spot") {
        g.fillStyle = "#b892ff"; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.fill();
        labels.push([m.label, x, y]);
      } else if (m.type === "home") {
        g.fillStyle = "#3ccf7e"; g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x + 5, y); g.lineTo(x + 5, y + 6); g.lineTo(x - 5, y + 6); g.lineTo(x - 5, y); g.lineTo(x - 7, y); g.closePath(); g.fill();
        labels.push(["Home", x, y + 4]);
      } else if (m.type === "build") {
        g.strokeStyle = "#ffd166"; g.lineWidth = 2; g.strokeRect(x - 5, y - 5, 10, 10);
      } else if (m.type === "destination") {
        g.strokeStyle = "#f2b84b"; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.moveTo(x + 2.5, y); g.arc(x, y, 2.5, 0, Math.PI * 2); g.stroke();
      } else if (m.type === "bob") {
        // Mineflayer yaw 0 faces north (-z) and grows toward the west.
        const dx = -Math.sin(m.yaw), dz = -Math.cos(m.yaw);
        g.fillStyle = "#2ee6f0"; g.strokeStyle = "#0b1a1c"; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x + dx * 9, y + dz * 9); g.lineTo(x - dz * 6 - dx * 5, y + dx * 6 - dz * 5); g.lineTo(x + dz * 6 - dx * 5, y - dx * 6 - dz * 5); g.closePath(); g.fill(); g.stroke();
      }
      if (map.picked && m.x === map.picked.x && m.z === map.picked.z && m.type === map.picked.type) { g.strokeStyle = "#ffffff"; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.stroke(); }
    }
    if (map.scale >= 1.5) {
      g.font = "600 11px Inter, system-ui, sans-serif"; g.textAlign = "center";
      for (const [label, x, y] of labels) { g.fillStyle = "#0b1015cc"; const width = g.measureText(label).width + 8; g.fillRect(x - width / 2, y + 7, width, 15); g.fillStyle = "#e6edf2"; g.fillText(label, x, y + 18); }
    }
    // Scale bar.
    const blocks = [8, 16, 32, 64, 128, 256, 512].find((n) => n * map.scale >= 50) || 512;
    g.fillStyle = "#e6edf2"; g.fillRect(10, h - 14, blocks * map.scale, 2);
    g.font = "10px ui-monospace, monospace"; g.textAlign = "left"; g.fillText(`${blocks} m`, 10, h - 19);
  }
  function describeMarker(m) {
    const bob = map.data?.bob;
    const distance = bob && m.type !== "bob" ? ` · ${Math.round(Math.hypot(m.x - bob.x, m.z - bob.z))} m from Bob` : "";
    const extra = [m.detail, m.at ? `seen ${since(m.at)}` : null, m.depleted ? "depleted" : null].filter(Boolean).join(" · ");
    return `${m.label}: ${Math.round(m.x)}, ${Math.round(m.y)}, ${Math.round(m.z)}${distance}${extra ? ` · ${extra}` : ""}`;
  }
  function renderMapFacts() {
    const d = map.data;
    $("mapDimension").textContent = words(d.dimension || "");
    const bob = d.bob;
    const dest = d.destination;
    $("mapDestination").textContent = dest ? `${dest.label} (${Math.round(dest.x)}, ${Math.round(dest.z)})` : "None right now";
    $("mapDistance").textContent = dest && bob ? `${Math.round(Math.hypot(dest.x - bob.x, dest.z - bob.z))} m` : "—";
    $("mapFromHome").textContent = d.home && bob ? `${Math.round(Math.hypot(d.home.x - bob.x, d.home.z - bob.z))} m` : "—";
    $("mapRoute").textContent = d.path.length ? `${d.path.length} waypoints planned` : dest ? "Planning…" : "No route";
    if (!map.picked) $("mapInfo").textContent = bob ? `CobbleBob at ${Math.round(bob.x)}, ${Math.round(bob.y)}, ${Math.round(bob.z)}. Tap a marker for details.` : "CobbleBob is offline.";
  }
  function zoom(factor, at) {
    const rect = canvas.getBoundingClientRect();
    const next = Math.max(0.25, Math.min(16, map.scale * factor));
    if (at && !map.follow) {
      const wx = map.cx + (at[0] - rect.width / 2) / map.scale, wz = map.cz + (at[1] - rect.height / 2) / map.scale;
      map.cx = wx - (at[0] - rect.width / 2) / next; map.cz = wz - (at[1] - rect.height / 2) / next;
    }
    map.scale = next;
    drawMap();
  }
  function setFollow(on) {
    map.follow = on;
    $("mapFollow").setAttribute("aria-pressed", String(on));
    if (on && map.data?.bob) { map.cx = map.data.bob.x; map.cz = map.data.bob.z; drawMap(); }
  }
  $("mapZoomIn").addEventListener("click", () => zoom(1.6));
  $("mapZoomOut").addEventListener("click", () => zoom(1 / 1.6));
  $("mapFollow").addEventListener("click", () => setFollow(!map.follow));
  $("mapHome").addEventListener("click", () => { if (!map.data?.home) return; setFollow(false); map.cx = map.data.home.x; map.cz = map.data.home.z; drawMap(); });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.25 : 0.8, [event.clientX - rect.left, event.clientY - rect.top]); }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => { map.drag = { x: event.clientX, y: event.clientY, cx: map.cx, cz: map.cz, moved: false }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => {
    const drag = map.drag;
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { drag.moved = true; setFollow(false); }
    map.cx = drag.cx - dx / map.scale; map.cz = drag.cz - dy / map.scale;
    drawMap();
  });
  canvas.addEventListener("pointerup", (event) => {
    const drag = map.drag;
    map.drag = null;
    if (!drag || drag.moved) return;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    let best = null, bestDistance = 14;
    for (const m of markers()) {
      const [x, y] = project(m.x, m.z, rect.width, rect.height);
      const distance = Math.hypot(x - px, y - py);
      if (distance < bestDistance) { best = m; bestDistance = distance; }
    }
    map.picked = best;
    $("mapInfo").textContent = best ? describeMarker(best) : "Tap a marker for details.";
    drawMap();
  });
  document.querySelectorAll("#mapLegend [data-layer]").forEach((box) => box.addEventListener("change", () => { map.layers[box.dataset.layer] = box.checked; drawMap(); }));
  if (typeof ResizeObserver === "function") new ResizeObserver(() => drawMap()).observe(canvas);

  // ---- History and "since your last visit" ----
  const VISIT_KEY = "cobblebob.lastVisit";
  const readVisit = () => { try { return localStorage.getItem(VISIT_KEY); } catch { return null; } };
  const markVisit = () => { try { localStorage.setItem(VISIT_KEY, new Date().toISOString()); } catch {} };
  let visitChecked = false;
  async function fetchHistory(sinceIso) {
    const response = await fetch(`/api/history${sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }
  function summaryLines(history) {
    const s = history.summary;
    const lines = [];
    if (s.buildsFinished.length) lines.push(["build", `Finished ${s.buildsFinished.length === 1 ? `a ${s.buildsFinished[0]}` : `${s.buildsFinished.length} buildings: ${s.buildsFinished.join(", ")}`}`]);
    else if (s.buildsStarted) lines.push(["build", `Started ${s.buildsStarted} build${s.buildsStarted === 1 ? "" : "s"}`]);
    if (s.gathered.length) {
      const top = s.gathered.slice(0, 4).map((g) => `${g.count} ${g.resource}`).join(", ");
      lines.push(["gather", `Gathered ${top}${s.gathered.length > 4 ? ` and ${s.gathered.length - 4} more kinds` : ""}`]);
    }
    if (s.goalsCompleted) lines.push(["goal", `Completed ${s.goalsCompleted} goal${s.goalsCompleted === 1 ? "" : "s"}`]);
    if (s.deaths) lines.push(["death", `Died ${s.deaths === 1 ? "once" : `${s.deaths} times`}${s.killers.length ? ` (${s.killers.join(", ")})` : ""}${s.recoveries ? `, recovered his items ${s.recoveries === 1 ? "once" : `${s.recoveries} times`}` : ""}`]);
    if (s.toolsBroken.length) lines.push(["tool", `Wore out ${s.toolsBroken.join(", ")}`]);
    return lines;
  }
  function problemRows(problems) {
    return problems.map((problem) => {
      const row = el("li", `problem problem-${problem.kind}`);
      row.append(el("strong", "", problem.title));
      const detail = [problem.detail, problem.since ? since(problem.since) : null].filter(Boolean).join(" · ");
      if (detail) row.append(el("span", "sub", detail));
      return row;
    });
  }
  async function showVisit(previous) {
    try {
      const history = await fetchHistory(previous);
      const lines = summaryLines(history);
      if (!lines.length && !history.unresolved.length) return;
      $("visitWhen").textContent = `You were last here ${since(previous)}. ${history.entries.length ? `${history.entries.length}${history.truncated ? "+" : ""} things happened.` : "Things were quiet."}`;
      $("visitSummary").replaceChildren(...(lines.length ? lines.map(([icon, text]) => { const row = el("li"); row.append(glyph(icon), el("span", "", text)); return row; }) : [el("li", "sub", "No buildings, gathering or deaths.")]));
      $("visitProblemsWrap").hidden = !history.unresolved.length;
      $("visitProblems").replaceChildren(...problemRows(history.unresolved));
      $("visitCard").hidden = false;
    } catch {}
  }
  function checkVisit() {
    if (visitChecked) return;
    visitChecked = true;
    const previous = readVisit();
    markVisit();
    // Only a real absence earns the card; a reload a minute later does not.
    if (previous && Date.now() - Date.parse(previous) > 10 * 60_000) void showVisit(previous);
    setInterval(() => { if (document.visibilityState === "visible") markVisit(); }, 30_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { markVisit(); return; }
      const before = readVisit();
      if (before && Date.now() - Date.parse(before) > 30 * 60_000) void showVisit(before);
      markVisit();
    });
    window.addEventListener("pagehide", markVisit);
  }
  $("visitDismiss").addEventListener("click", () => { $("visitCard").hidden = true; });
  $("visitStory").addEventListener("click", () => { selectTab("story"); void loadHistory(); });
  async function loadHistory() {
    $("historyInfo").textContent = "Loading…";
    try {
      const history = await fetchHistory(null);
      const root = $("history");
      const days = new Map();
      for (const entry of history.entries.slice().reverse()) {
        const day = new Date(entry.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(entry);
      }
      root.replaceChildren(...[...days].map(([day, entries]) => {
        const group = el("section", "history-day");
        const items = el("ol", "story");
        items.append(...entries.map((entry) => {
          const row = el("li", entry.highlight ? "highlight" : "");
          const time = el("time", "", new Date(entry.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
          time.dateTime = entry.at;
          row.append(glyph(entry.icon), el("span", "", entry.text), time);
          return row;
        }));
        group.append(el("h3", "", day), items);
        return group;
      }));
      $("historyInfo").textContent = history.entries.length ? `The last ${history.entries.length} events, kept across restarts.` : "Nothing recorded yet.";
      if (history.unresolved.length) {
        const wrap = el("div", "history-problems");
        const problems = el("ul", "problems");
        problems.append(...problemRows(history.unresolved));
        wrap.append(el("h3", "", "Still unresolved"), problems);
        root.prepend(wrap);
      }
      $("historyLoad").textContent = "Refresh";
    } catch {
      $("historyInfo").textContent = "History is unavailable right now.";
    }
  }
  $("historyLoad").addEventListener("click", () => { void loadHistory(); });

  refresh(); setInterval(refresh, 1000);
})();
