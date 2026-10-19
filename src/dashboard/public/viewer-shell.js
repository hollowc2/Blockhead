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
    try { localStorage.setItem("cobblebob.tab", name); } catch {}
  }
  document.querySelectorAll("[data-tab-button]").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tabButton)));
  try { const saved = localStorage.getItem("cobblebob.tab"); if (saved === "story" || saved === "stats") selectTab(saved); } catch {}

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
    document.querySelectorAll("[data-private]").forEach((el) => { el.hidden = isPublic; });
    document.querySelectorAll("[data-public]").forEach((el) => { el.hidden = !isPublic; });
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
      const blocked = build.currentShortage ? "waiting on materials" : build.lastBlockingReason;
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
  function findBob() {
    try {
      const win = viewerFrame.contentWindow;
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "r" }));
    } catch {}
  }
  $("fullscreen").addEventListener("click", toggleFullscreen);
  $("findBob").addEventListener("click", findBob);
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "f" || event.key === "F") toggleFullscreen();
    else if (event.key === "r" || event.key === "R") findBob();
  });

  // Viewer Q&A (private page only): the server answers through the LLM.
  let commandConnected = false, commandBusy = false;
  const commandForm = $("commandForm"), commandInput = $("commandInput"), commandSend = $("commandSend"), commandStatus = $("commandStatus");
  const commandButtons = [...document.querySelectorAll("#commandQuick button")];
  function updateCommandButtons() {
    commandSend.disabled = !commandConnected || commandBusy;
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

  refresh(); setInterval(refresh, 1000);
})();
