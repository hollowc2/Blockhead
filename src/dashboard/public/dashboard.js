(() => {
  const $ = (id) => document.getElementById(id);
  const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
  const safe = (value) => { const node = document.createElement("span"); node.textContent = text(value); return node; };
  const list = (id, entries, render) => { const root = $(id); root.replaceChildren(); if (!entries?.length) { root.textContent = "None recorded"; root.className = "feed muted"; return; } entries.forEach((entry) => { const row = document.createElement("div"); render(row, entry); root.append(row); }); };
  const when = (value) => value ? new Date(value).toLocaleTimeString() : "";
  const meta = (row, value) => { const time = document.createElement("time"); time.textContent = value; row.prepend(time); };
  function render(s) {
    $("health").textContent = text(s.self?.health); $("hunger").textContent = text(s.self?.hunger);
    const p = s.self?.position; $("position").textContent = p ? `${p.x}, ${p.y}, ${p.z}` : "—";
    $("dimension").textContent = text(s.self?.dimension); $("timePhase").textContent = text(s.self?.timePhase);
    $("goal").textContent = s.goal ? `${s.goal.description} (${s.goal.status})` : "No active goal";
    $("task").textContent = s.task ? `${s.task.objective} (${s.task.status})` : "No active task"; $("action").textContent = text(s.action?.label);
    const project = s.buildProject; const phase = project?.phase;
    $("project").textContent = project ? `${project.structureType} (${project.status})` : "No active project";
    $("projectPhase").textContent = phase ? `${phase.label} (${phase.status})` : "—";
    $("projectProgress").textContent = project ? `${project.verifiedOperations} / ${project.totalOperations}` : "—";
    $("projectBlock").textContent = project?.currentShortage ? `${project.currentShortage.material}: ${project.currentShortage.required - project.currentShortage.available} missing` : (project?.lastBlockingReason || "—");
    const llm = s.llmActivity || {}; $("llmState").textContent = llm.thinking ? "Thinking..." : text(llm.state, "Unknown"); $("decision").textContent = text(llm.decisionType); $("rationale").textContent = text(llm.lastRationale || s.llmLastCall?.rationale); $("llmFailure").textContent = llm.lastFailure ? `${llm.lastFailure.kind}: ${llm.lastFailure.error}` : "None";
    const stocks = $("stockpiles"); stocks.replaceChildren(); const deficits = s.stockpiles?.deficits || []; if (!deficits.length) stocks.textContent = s.stockpiles ? "No deficits" : "No stockpile data"; deficits.forEach((d) => { const row = document.createElement("div"); row.textContent = `${d.kind}: ${text(d.level, "?")} / ${text(d.target, "?")}${d.crisis ? " · CRISIS" : ""}`; stocks.append(row); });
    const items = s.inventory?.items || []; list("inventory", items, (row, item) => { row.textContent = `${item.name}: ${item.count}`; });
    list("events", s.recentEvents, (row, e) => { row.append(safe(e.message)); meta(row, `${when(e.at)} · ${e.kind}`); }); list("failures", s.recentFailures, (row, e) => { row.append(safe(e.message)); meta(row, `${when(e.at)} · ${e.kind}`); }); list("chat", s.recentChat, (row, e) => { row.append(safe(`${e.sender}: ${e.message}`)); meta(row, when(e.at)); });
  }
  function status(kind, label) { $("connection").className = `status status-${kind}`; $("connection").textContent = label; }
  async function load() { try { render(await (await fetch("/api/state", { cache: "no-store" })).json()); } catch { status("reconnecting", "Reconnecting..."); } }
  function connect() { status("reconnecting", "Connecting..."); const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); ws.onopen = () => { status("live", "Connected"); load(); }; ws.onmessage = (event) => { try { const message = JSON.parse(event.data); if (message.type === "snapshot") render(message.data); } catch {} }; ws.onclose = () => { status("offline", "Disconnected"); setTimeout(connect, 1500); }; ws.onerror = () => ws.close(); }
  load(); connect();
})();
