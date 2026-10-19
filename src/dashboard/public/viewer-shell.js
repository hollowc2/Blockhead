(() => {
  const $ = (id) => document.getElementById(id);
  const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
  const setText = (id, value, fallback) => { $(id).textContent = text(value, fallback); };
  const show = (id, visible) => { $(id).hidden = !visible; };
  let mode = null;

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
    const self = s.self || {};
    const connected = s.connection?.connected === true;
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
    }
  }

  function toggleFullscreen() {
    const stage = $("stage");
    if (document.fullscreenElement) document.exitFullscreen?.();
    else stage.requestFullscreen?.();
  }
  $("fullscreen").addEventListener("click", toggleFullscreen);
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "f" && !event.ctrlKey && !event.metaKey && !event.altKey) toggleFullscreen();
  });

  // Viewer Q&A (private page only): the server answers through the LLM.
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
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = chatInput.value.trim();
    if (!question || chatSend.disabled) return;
    chatInput.value = "";
    chatSend.disabled = true;
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
      chatSend.disabled = false;
      chatInput.focus();
    }
  });

  refresh(); setInterval(refresh, 1000);
})();
