(() => {
  const $ = (id) => document.getElementById(id);
  const text = (value) => value === null || value === undefined || value === "" ? "—" : String(value);
  function render(s) {
    const self = s.self || {}; const position = self.position;
    $("health").textContent = text(self.health); $("hunger").textContent = text(self.hunger);
    $("position").textContent = position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : "—";
    $("dimension").textContent = text(self.dimension); $("time").textContent = text(self.timePhase);
    $("action").textContent = text(s.action?.label); $("goal").textContent = s.goal ? `${s.goal.description} (${s.goal.status})` : "No active goal";
    $("task").textContent = s.task ? `${s.task.objective} (${s.task.status})` : "No active task";
    const llm = s.llmActivity || {}; $("llm").textContent = llm.thinking ? "Thinking…" : text(llm.state, "Standing by");
    $("viewerStatus").textContent = text(s.viewer?.status);
    $("connection").textContent = s.connection?.connected ? "CobbleBob connected" : "CobbleBob disconnected";
  }
  async function refresh() { try { const response = await fetch("/api/state", { cache: "no-store" }); render(await response.json()); } catch { $("connection").textContent = "Stats reconnecting…"; } }
  refresh(); setInterval(refresh, 1000);
})();
