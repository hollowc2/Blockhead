# CobbleBob Live Dashboard Development Sequence

## Global rules for every phase

You are working in the existing Blockhead repository:

`https://github.com/hollowc2/Blockhead`

Blockhead is a TypeScript / Node.js Mineflayer autonomous Minecraft agent named CobbleBob.

Before modifying anything, inspect the current repository and understand the existing implementation. Do not assume this prompt perfectly describes the current tree if the repository has changed.

Important architectural rule:

**The dashboard is an observer of Blockhead, not a controller of Blockhead.**

Do not introduce dashboard code that can:
- execute skills
- enqueue tasks
- call LLM tools
- send Minecraft movement commands
- alter scheduler state
- issue shell commands
- mutate SQLite state
- control CobbleBob from the browser

Minecraft chat remains CobbleBob's command interface.
1
Preserve the existing architecture:

LLM tools → deterministic skills → Mineflayer primitives

and:

Mineflayer/events → EventBus/AgentState → Scheduler/DecisionMaker

The dashboard should consume the same state rather than creating another source of truth.

For every development phase:

1. Inspect the relevant existing files before editing.
2. Make the smallest coherent implementation that completes this phase.
3. Avoid unrelated refactors.
4. Keep strict TypeScript typing.
5. Add or update automated tests for meaningful new logic.
6. Run:
   - `npm run typecheck`
   - `npm test`
7. Fix failures caused by your changes.
8. Do not begin work described in later phases.
9. At the end report:
   - files created
   - files modified
   - architectural decisions made
   - tests added
   - `npm run typecheck` result
   - `npm test` result
   - exact manual verification steps
   - any unresolved risks

---

# PROMPT 1 — Dashboard telemetry model and configuration

Implement the internal telemetry foundation for a future CobbleBob web dashboard.

Do NOT implement the browser UI or prismarine-viewer yet.

## Existing code to study

At minimum inspect:

- `src/index.ts`
- `src/tui/app.ts`
- `src/tui/panels.ts`
- `src/events/bus.ts`
- `src/events/types.ts`
- `src/agent/state.ts`
- `src/agent/scheduler.ts`
- `src/agent/goals.ts`
- `src/agent/task.ts`
- `src/agent/maintenance.ts`
- `src/llm/decider.ts`
- `src/llm/client.ts`
- `src/minecraft/inventory.ts`
- `src/minecraft/entities.ts`
- `src/config/schema.ts`
- `config/minecraft.yaml`

The current TUI is especially important. It already assembles a passive dashboard snapshot. Reuse its concepts and pure helper functions where reasonable, but do not break the TUI.

## Goal

Create a reusable, plain-data telemetry snapshot suitable for serialization to a browser.

Suggested directory:

```text
src/dashboard/
    types.ts
    telemetry.ts
```

Names may vary if a cleaner architecture is apparent after inspecting the repo.

## Required snapshot information

Create a serializable snapshot containing approximately:

```ts
interface DashboardSnapshot {
  timestamp: string;

  bot: {
    name: string;
    connected: boolean;
    uptimeMs: number;
  };

  self: {
    health: number;
    hunger: number;
    position: {
      x: number;
      y: number;
      z: number;
    } | null;
    dimension: string | null;
    timePhase: "day" | "night" | null;
    dangerScore: number;
  };

  goal: {
    id: string;
    description: string;
    currentStep: string | null;
    status: string;
  } | null;

  task: {
    id: string;
    type: string;
    source: string;
    objective: string;
    status: string;
    startedAt?: string;
    lastError?: string;
  } | null;

  action: {
    label: string;
  };

  background: {
    activity: string;
    stockpiles: ...
  };

  inventory: ...;

  llm: ...;

  path: ...;

  recentEvents: ...;
  recentFailures: ...;
  recentChat: ...;
}
```

This is a conceptual shape. Adapt types to the actual Blockhead models.

## Important constraints

The telemetry collector must:

- be read-only
- never drive the scheduler
- never mutate AgentState
- never call the LLM
- never touch Mineflayer movement
- never store live Mineflayer objects inside snapshots
- produce JSON-safe plain values
- tolerate `bot === null` during reconnects
- tolerate stockpile/hostile/session services being absent
- survive the Blockhead process being connected, disconnected, reconnecting, or not yet spawned

Do not duplicate complex state when an existing source can be read directly.

Reusing existing helpers from `src/tui/` is acceptable where they are logically generic. Do not perform a large TUI rewrite during this phase.

## Dashboard configuration

Extend `src/config/schema.ts` with an optional dashboard section similar to:

```yaml
dashboard:
  enabled: true
  host: 0.0.0.0
  port: 3000
  viewer_enabled: true
  viewer_port: 3001
  viewer_distance: 6
```

Choose safe sensible defaults.

Add documented values to `config/minecraft.yaml`.

The web dashboard should eventually be accessible from another machine, so do not default to `127.0.0.1` unless there is a strong reason. However, the dashboard will remain read-only.

## Event history

Build a bounded in-memory ring buffer for significant dashboard events.

It should capture useful existing EventBus events such as:

- owner chat command
- task activated
- task paused
- task completed
- task failed
- task blocked
- task cancelled
- goal started
- goal completed
- goal blocked
- goal cancelled
- bootstrap changes
- resource gathering start/result
- expedition changes
- death
- respawn
- death recovery
- hostile detection
- tool breakage
- director decisions

Do not let the buffer grow without bound.

A target of roughly 50–100 events is sufficient.

Each entry should contain:

```ts
{
  at: string;
  category: string;
  severity: "info" | "success" | "warning" | "error";
  message: string;
}
```

Also maintain convenient bounded projections for:

- recentFailures
- recentChat

Do not persist this dashboard history to SQLite yet.

## Tests

Test at least:

- snapshot generation while disconnected
- snapshot generation with a connected bot
- active goal projection
- active task projection
- bounded event history
- failed task appearing in recentFailures
- owner command appearing in recentChat
- telemetry code not throwing with optional session services absent

Stop when this internal telemetry model works.

Do not implement the HTTP server yet.

---

# PROMPT 2 — Add explicit LLM activity / "CobbleBob is thinking" telemetry

Add first-class observability for LLM activity.

The dashboard eventually needs to distinguish:

```text
Standing by
Working in Minecraft
Thinking...
```

Currently Blockhead records the most recent successful LLM call, but the dashboard also needs to know when a request is actively in flight.

Inspect:

- `src/llm/decider.ts`
- `src/llm/client.ts`
- all DecisionMaker decision paths
- dashboard telemetry from Prompt 1

## Required behavior

Expose read-only LLM activity resembling:

```ts
interface LlmActivity {
  thinking: boolean;
  callType:
    | "owner_instruction"
    | "background_director"
    | "goal_decision"
    | null;

  startedAt: string | null;

  lastCall: {
    startedAt: string;
    latencyMs: number;
    tool: string;
    rationale: string | null;
    success: boolean;
    error?: string;
  } | null;
}
```

Use terminology appropriate to the actual code.

## Important implementation requirement

Do not fake `thinking` based on time since the last response.

It must represent a real currently active LLM decision.

A request should become active immediately before the decision process begins and become inactive in a `finally` path so exceptions cannot leave the dashboard permanently stuck on "thinking".

Take retries into account. If one logical decision internally retries an invalid response, it should still appear as one continuous thinking period to the dashboard.

If concurrent requests are theoretically possible, prefer a counter/set over a fragile single boolean. If Blockhead guarantees serialization, document that fact.

## Last decision

Preserve/display:

- model
- endpoint
- latency
- chosen tool/action
- concise rationale

The rationale is the explicit short rationale Blockhead already requests. Do not expose or fabricate hidden chain-of-thought.

## Failure information

If an LLM decision ultimately fails, capture a concise error for dashboard observability.

Do not include:
- secrets
- complete prompts
- API credentials
- giant raw responses

The existing detailed debug log can remain the place for deeper development diagnostics.

## Telemetry integration

Extend the Prompt 1 snapshot so the browser will eventually receive:

```text
LLM state: thinking / idle
Current decision type
Thinking duration
Last tool
Last rationale
Last latency
Last failure, if relevant
```

## Tests

Cover:

- thinking false before a request
- thinking true while an intentionally delayed fake client is running
- thinking false after success
- thinking false after failure
- last-call data after success
- failure metadata after final failure
- retries do not incorrectly clear thinking between retry attempts

Do not build HTTP or UI yet.

---

# PROMPT 3 — Implement the read-only dashboard HTTP + WebSocket server

Implement the backend that delivers CobbleBob telemetry to a browser.

Do not implement prismarine-viewer in this phase.

## Architecture

Keep this lightweight.

Prefer:

- Node built-in `http`
- explicit dependency on `ws` for WebSocket support
- static HTML/CSS/JS later

Do not introduce Express, React, Vite, Next.js, a database, or another large framework unless the existing repo has acquired one and there is a compelling reason.

Suggested structure:

```text
src/dashboard/
    server.ts
    telemetry.ts
    types.ts
```

Static assets can be added in the next prompt.

## Server lifecycle

Create something like:

```ts
const dashboard = new DashboardServer({...});
dashboard.start();
dashboard.stop();
```

Wire it into `src/index.ts`.

The dashboard server is process-lifetime, just like the TUI.

It must survive Mineflayer reconnect cycles.

Its data source should receive the current session through getters, matching the existing TUI pattern, rather than capturing a stale Bot instance.

## HTTP endpoints

Implement:

### `GET /health`

Return small JSON:

```json
{
  "ok": true,
  "service": "blockhead-dashboard"
}
```

### `GET /api/state`

Return the current complete DashboardSnapshot.

Useful both for debugging and browser bootstrapping.

### WebSocket `/ws`

When a browser connects:

1. Immediately send the current full snapshot.
2. Continue sending current snapshots at a moderate rate.

Target:

- 2 updates/second initially
- approximately 500 ms interval

Do not send data every Minecraft tick.

## Message envelope

Use a small explicit protocol such as:

```json
{
  "type": "snapshot",
  "data": { ... }
}
```

Design it so future event-only messages can be added.

## Backpressure

A slow browser must not destabilize CobbleBob.

If a WebSocket client's buffered output grows excessively:

- drop intermediate telemetry frames, or
- skip sending until it catches up

Never queue unlimited snapshots.

## Security boundary

There must be NO endpoints that:

- accept Minecraft instructions
- enqueue tasks
- call the LLM
- mutate goals
- modify config
- alter inventory
- trigger movement

For now the dashboard is strictly read-only.

## Static root

It is fine for `/` to temporarily return a simple placeholder HTML page saying:

`CobbleBob Dashboard`

The actual UI comes later.

## Shutdown

`shutdown()` in `src/index.ts` must cleanly stop the dashboard HTTP/WebSocket server.

No listener or timer leaks.

## Tests

Add tests for:

- health endpoint
- API state endpoint
- WebSocket receives initial snapshot
- WebSocket receives subsequent snapshot
- disconnected Mineflayer session still returns valid dashboard state
- stopping dashboard closes server/timers
- unknown routes return a sensible 404
- mutation-style POST requests are not accepted

Manual verification should include a `curl` example and browser/WebSocket check.

Stop here.

---

# PROMPT 4 — Add CobbleBob's first-person Minecraft viewer

Add the actual live Minecraft view.

Use `prismarine-viewer` rather than implementing rendering yourself.

Inspect current prismarine-viewer documentation before coding because package APIs/version support may have changed.

Add it as an explicit project dependency.

## Desired behavior

When CobbleBob successfully spawns, start a first-person viewer approximately equivalent to:

```ts
mineflayerViewer(bot, {
  port: config.dashboard.viewer_port,
  firstPerson: true,
  viewDistance: config.dashboard.viewer_distance
});
```

Use the actual current API.

## Lifecycle is critical

Blockhead recreates the Mineflayer session during reconnects.

Therefore the viewer must also be session-scoped.

Required sequence:

```text
Blockhead process starts
    dashboard HTTP server starts

Mineflayer session connects/spawns
    viewer starts for THAT bot

Mineflayer disconnects
    viewer closes

new Mineflayer session connects
    new viewer starts against new bot
```

Do not keep a viewer bound to a dead Bot object.

Do not start duplicate viewers on repeated spawn events.

Handle cases where:
- viewer is disabled
- CobbleBob never reaches spawn
- port is already occupied
- prismarine-viewer startup fails
- bot disconnects unexpectedly

A viewer failure should be logged but must NOT kill CobbleBob's primary runtime unless there is an unavoidable library-level limitation. Observability is secondary to the agent.

## Configuration

Respect:

```yaml
dashboard:
  viewer_enabled: true
  viewer_port: 3001
  viewer_distance: 6
```

## Dashboard telemetry

Add viewer status to telemetry:

```ts
viewer: {
  enabled: boolean;
  available: boolean;
  port: number;
}
```

If useful, include a path/URL field that the front-end can derive safely.

Do not hard-code `localhost` into browser-visible URLs because the browser may be running on Zeus or another device while Blockhead runs on Maia.

## Manual acceptance test

With Blockhead running on Maia and Minecraft on Eros:

1. Open the viewer from another machine.
2. Confirm it displays CobbleBob's current perspective.
3. Move CobbleBob via normal Blockhead behavior.
4. Confirm the view follows CobbleBob.
5. Restart/disconnect the Minecraft server.
6. Confirm Blockhead does not crash because of the viewer.
7. Reconnect.
8. Confirm a working viewer is recreated.

Stop here.

Do not build the polished combined UI yet.

---

# PROMPT 5 — Build the first usable CobbleBob Live browser dashboard

Now create the browser interface.

Use plain:

- HTML
- CSS
- browser JavaScript

unless the repo now has a front-end framework for another reason.

Do not introduce a build pipeline merely for this dashboard.

Suggested files:

```text
src/dashboard/public/
    index.html
    app.js
    style.css
```

Adjust if necessary.

Serve them from the DashboardServer.

## Primary desktop layout

Build a layout conceptually like:

```text
┌─────────────────────────────────────────────────────────────────┐
│ COBBLEBOB LIVE    ● CONNECTED            LLM: ● IDLE / THINKING │
├──────────────────────────────────────────┬──────────────────────┤
│                                          │ HIGH LEVEL GOAL      │
│                                          │ Prepare for mining   │
│                                          │                      │
│          FIRST PERSON MINECRAFT           │ CURRENT TASK         │
│                VIEW                      │ Collect coal         │
│                                          │                      │
│                                          │ CURRENT ACTION       │
│                                          │ Searching cave      │
│                                          │                      │
│                                          │ ♥ 20/20  🍗 17/20   │
│                                          │ XYZ 182 64 -91       │
│                                          │ Overworld · Day      │
├──────────────────────────────────────────┴──────────────────────┤
│ LAST DECISION                                                   │
│ Coal is below target → collect_resource(coal)                   │
├──────────────────────────────────┬──────────────────────────────┤
│ INVENTORY                        │ STOCKPILES                   │
│ Iron pickaxe                     │ Wood      64 / 64            │
│ Bread x12                        │ Food      38 / 64            │
│ Torches x42                      │ Fuel      12 / 64            │
│ ...                              │ Torches   42 / 64            │
├──────────────────────────────────┴──────────────────────────────┤
│ ACTIVITY                                                        │
│ 10:17 Goal: Maintain stockpiles                                 │
│ 10:18 Coal below target                                         │
│ 10:18 Searching for coal...                                     │
│ 10:19 Search failed: no reachable coal                          │
└─────────────────────────────────────────────────────────────────┘
```

This is conceptual, not pixel-exact.

## First-person view

Embed the prismarine-viewer in the page.

An iframe is acceptable for the first implementation and is probably the safest integration.

Determine the viewer URL dynamically from:

- current browser hostname
- configured viewer port

Do not assume Maia's IP address.

Example concept:

```js
const viewerUrl =
  `${location.protocol}//${location.hostname}:${viewerPort}`;
```

Account for whatever protocol constraints prismarine-viewer actually requires.

Display a friendly placeholder when the viewer is unavailable:

```text
Minecraft viewer unavailable
Waiting for CobbleBob to spawn...
```

## Live telemetry

On page load:

1. Fetch `/api/state`.
2. Render immediately.
3. Connect `/ws`.
4. Update UI when snapshot messages arrive.
5. Automatically reconnect WebSocket with capped backoff if disconnected.

The page must not require a manual refresh when Blockhead reconnects.

## Required panels

Implement:

### Status header
- CobbleBob name
- connected / disconnected
- uptime
- LLM idle/thinking

### High-level goal
Use GoalManager's current goal.

Show:
- description
- current step

If no active goal:
`No autonomous goal`

### Current task
Show:
- objective
- type
- source
- status

### Current action
Human-readable action derived from task/skill.

### Vitals
- HP
- hunger
- coordinates
- dimension
- day/night
- danger score

### Inventory highlights
Show useful summarized inventory.

Avoid dumping every empty slot.

### Stockpiles
- wood
- food
- fuel
- torches
- current / target

### LLM decision
Show:
- model
- selected tool/action
- concise rationale
- latency
- age of last decision

Never label rationale as hidden chain-of-thought.

### Recent failures
Dedicated small panel:
- action/task
- error
- time

### Recent owner instructions
Show recent `chat.command` events.

### Activity timeline
Show newest significant events, with visual distinction among:
- normal
- success
- warning
- failure

## THINKING indicator

When `snapshot.llm.thinking === true`:

Clearly display something like:

`● COBBLEBOB IS THINKING...`

Optionally animate only the dots/pulse with CSS.

Show elapsed thinking time if the snapshot provides a start time.

When false, show:

`LLM IDLE`

or equivalent.

## Visual style

Aim for:

- dark Minecraft-adjacent control-room aesthetic
- high information density
- large live viewer
- readable at 1920×1080
- responsive enough for laptop/tablet
- no huge UI framework

Do not over-design.

Functionality and legibility are more important.

## Browser safety

Render all dynamic text with `textContent`, not unsanitized `innerHTML`.

Owner chat, task names, LLM rationale, and error messages are untrusted display strings.

## Tests

Where practical, test server-side/static helper behavior.

Provide a manual acceptance checklist covering every panel.

Stop once this dashboard works end-to-end.

---

# PROMPT 6 — Add live intended-path visualization

Add visibility into where CobbleBob intends to walk.

Mineflayer-pathfinder exposes path events. Inspect the installed/current pathfinder API before implementing.

The expected useful events include:

- `path_update`
- `goal_updated`
- `goal_reached`
- `path_reset`
- `path_stop`

## Path telemetry

Create a session-scoped path observer.

When a successful or partial `path_update` occurs, record a bounded serializable path:

```ts
{
  status: "success" | "partial" | "timeout" | "noPath" | ...;
  updatedAt: string;

  points: [
    {x, y, z},
    ...
  ];

  destination?: {
    x: number;
    y: number;
    z: number;
  };
}
```

Do not retain plugin-specific Move objects.

Do not publish thousands of coordinates.

Cap or decimate the path to a reasonable number such as 100–200 display points.

When pathfinding stops/resets/reaches its destination, update or clear telemetry appropriately.

## Draw the route in prismarine-viewer

Use the viewer's drawing functionality where supported.

Expected concept:

```ts
bot.viewer.drawLine("cobblebob-planned-path", points, ...)
```

Use the actual prismarine-viewer API.

The line should be replaced when the path changes, not accumulated indefinitely.

Erase it when no planned route remains.

Do not require this visualization for CobbleBob's pathfinding to work.

If viewer drawing throws or the viewer is unavailable, the agent must continue operating.

## Browser dashboard

Add a small navigation panel:

```text
NAVIGATION

Path: active
Nodes: 37
Destination: 241 68 -117
Last update: 0.4s ago
```

The primary visualization remains the line inside the Minecraft view.

## Important constraint

The dashboard must observe the pathfinder.

It must never change pathfinder goals.

## Tests

Test the path observer using synthetic path events without requiring a Minecraft server where possible.

Test:

- successful path
- partial path
- noPath
- path reset
- path stop
- bounded points
- reconnect/new Bot session does not retain stale path

Manual testing should verify that a visible route updates while CobbleBob travels.

---

# PROMPT 7 — Improve "current skill" and progress observability

The dashboard currently knows the scheduler task, but viewers should also understand what CobbleBob is doing inside a longer deterministic skill.

Implement a lightweight skill activity/progress layer.

Do NOT make the LLM control individual skill steps.

## Desired information

Examples:

```text
Goal:
Maintain stockpiles

Task:
Restore fuel stockpile

Skill:
collect_resource

Step:
Searching for coal

Progress:
12 / 64

Search radius:
128 blocks
```

or:

```text
Task:
Ensure iron pickaxe

Skill:
ensure_item

Step:
Smelting iron

Progress:
2 / 3 ingots
```

## Design

Do not scrape log strings to infer state.

Use explicit structured state/events.

Create a small generic model such as:

```ts
interface SkillActivity {
  taskId: string | null;
  skill: string;
  step: string;
  progress?: {
    current: number;
    target: number;
    unit?: string;
  };
  detail?: string;
  startedAt: string;
  updatedAt: string;
}
```

The exact shape should fit the repo.

## Scope

Instrument only the highest-value existing runners first, especially:

- collect-resource
- ensure-item
- gather-food
- organize-storage
- death-recovery
- bootstrap-survival

Do not rewrite all skills.

Each runner should publish meaningful phase changes, not every block/tick.

Examples:

- searching
- traveling
- gathering
- crafting
- smelting
- returning home
- depositing
- recovering drops

## Event architecture

Prefer typed EventBus events such as:

```text
skill.started
skill.progress
skill.step
skill.completed
skill.failed
```

or another coherent minimal set.

Do not emit at high frequency.

The telemetry collector should maintain the current SkillActivity from these events.

Clear it when the matching task finishes or is cancelled.

## Dashboard

Replace vague `Current action` text where richer skill activity exists.

Display:

```text
CURRENT ACTIVITY
Collect resource
Searching for coal
12 / 64
```

Fall back to the existing task-derived action label when no skill activity has been emitted.

## Tests

Test task/skill correlation carefully so an old skill event cannot overwrite a newer active task.

Stop here.

---

# PROMPT 8 — Make the dashboard resilient enough for unattended operation

Now harden the dashboard so it can remain open while Blockhead runs for hours or days.

This phase is about operational reliability, not new features.

## Required reliability work

Audit:

- HTTP server lifecycle
- WebSocket lifecycle
- viewer lifecycle
- Mineflayer session reconnects
- path observer cleanup
- EventBus subscriptions
- intervals/timeouts
- process shutdown
- browser reconnect behavior

Look specifically for:
- stale session references
- duplicate listeners
- duplicate viewer servers
- unbounded arrays
- timer leaks
- WebSocket send queues
- exceptions that could crash Blockhead
- resources not released after Minecraft disconnect

## Dashboard heartbeat

Include lightweight server status fields:

```text
Blockhead process uptime
Minecraft connected
Viewer available
Telemetry timestamp
WebSocket connected
```

In the browser, if no fresh telemetry has arrived for e.g. 5 seconds, display:

`TELEMETRY STALE`

Do not present old coordinates as if they are current.

## Client reconnect

Use exponential/capped reconnect behavior.

Example conceptual sequence:

```text
1 s
2 s
5 s
10 s
10 s
...
```

Reset delay after a successful connection.

## Viewer reconnect

The viewer iframe may fail while the Minecraft session is gone.

When viewer availability changes from false to true, allow the browser to reload/reconnect the iframe without reloading the entire dashboard.

Avoid a tight reload loop.

## HTTP robustness

Malformed WebSocket/browser behavior should not crash Blockhead.

Add reasonable safeguards around:
- socket errors
- unexpected disconnects
- attempted unsupported methods
- filesystem/static-file paths

Prevent directory traversal when serving static files.

## Graceful degradation

These failures must NOT stop normal CobbleBob operation:

- dashboard port unavailable
- WebSocket failure
- browser disconnect
- prismarine-viewer failure
- path drawing failure
- bad dashboard client

Log them clearly.

## Verification

Include a manual chaos test:

1. Start Blockhead.
2. Open dashboard.
3. Kill Minecraft server.
4. Observe disconnected state.
5. Restart Minecraft server.
6. Confirm reconnect.
7. Confirm viewer returns.
8. Refresh/close/reopen browser repeatedly.
9. Disconnect network temporarily.
10. Verify dashboard reconnects.
11. Stop Blockhead with SIGTERM.
12. Verify clean shutdown.

Run normal tests/typecheck.

---

# PROMPT 9 — Watchability / audience polish

The basic dashboard is working. Improve it specifically so someone watching CobbleBob can understand WHY he is behaving the way he is.

Do not turn the dashboard into a control interface.

## Main storytelling hierarchy

A viewer should understand these five questions within a few seconds:

1. What is CobbleBob trying to accomplish?
2. What is he doing right now?
3. Why did he choose that?
4. Is it working?
5. What went wrong recently?

Arrange the interface around those questions.

## Decision card

Create a prominent decision card like:

```text
WHY?

Goal
Maintain stockpiles

Decision
Fuel below target

Chosen action
Collect coal

Reason
Coal/charcoal is 18 / 64
```

Use real structured state wherever possible.

Do not fabricate explanations that were not produced by either:
- deterministic policy/state
- explicit LLM rationale
- known task metadata

Clearly distinguish:

`LLM decision`

from:

`Automatic maintenance`

from:

`Safety policy`

A viewer should be able to see when CobbleBob did NOT ask the LLM.

## Result timeline

Improve activity entries into an understandable sequence:

```text
10:20:03  GOAL       Maintain stockpiles
10:20:04  DECISION   Fuel below target
10:20:04  THINKING   1.3 s
10:20:05  ACTION     Search for coal
10:20:21  PATH       Cave entrance found
10:21:02  FAILURE    No reachable coal
10:21:03  DECISION   Expanding search
```

Use category badges/icons sparingly.

## Failure card

Show the latest failure separately when one exists:

```text
LAST FAILURE

collect_resource(coal)

PATH_UNREACHABLE

CobbleBob could see coal but could not
find a valid route.

32 seconds ago
```

Use the actual available structured error.

Do not invent a causal explanation beyond the recorded data.

## Inventory highlights

Prioritize visually useful items:

- equipped tools/weapons
- armor if available
- food
- torches
- current target resource
- important materials

Do not make the viewer read 36 inventory slots.

## Responsive design

Desktop:
- Minecraft viewer should dominate the page.

Tablet:
- viewer first
- goal/action immediately below

Phone:
- viewer
- goal/action/vitals
- collapsible details below

Do not spend excessive time reproducing Minecraft's visual theme.

## Accessibility

Use text in addition to color for:
- connected/disconnected
- warning/error
- thinking/idle

Avoid rapid flashing.

---

# PROMPT 10 — Final documentation and operator runbook

Finish the feature with documentation suitable for someone running Blockhead on Maia and opening the dashboard from another computer.

Update README or create:

```text
docs/dashboard.md
```

## Document architecture

Explain:

```text
Eros
  Minecraft server

Maia
  Blockhead
  llama.cpp
  dashboard server
  prismarine-viewer

Browser
  connects to Maia dashboard
```

## Document configuration

Explain every dashboard config option, including:

```yaml
dashboard:
  enabled:
  host:
  port:
  viewer_enabled:
  viewer_port:
  viewer_distance:
```

Use actual final field names/defaults.

## Document how to run

Include actual commands for the current repo.

Example form:

```bash
npm install
npm start
```

Then:

```text
http://maia:3000
```

if host naming/networking resolves it.

Do not claim a hostname will resolve unless the environment supports it; explain that Maia's LAN/Tailscale address can also be used.

## Ports

Clearly document:

```text
3000 dashboard
3001 first-person viewer
```

or whatever final defaults are.

Explain both ports need to be reachable from the viewing device for the iframe architecture.

## Troubleshooting

Document:

### Dashboard loads but Minecraft panel does not
- viewer disabled
- viewer port blocked
- CobbleBob has not spawned
- prismarine-viewer version compatibility
- port conflict

### Dashboard says disconnected
- Minecraft server unavailable
- Blockhead reconnecting

### Thinking indicator never changes
- LLM calls are not being made
- background LLM decisions disabled
- instrumentation problem

### Path not visible
- no active pathfinder route
- viewer drawing unavailable
- skill isn't currently using pathfinder

### Browser stops updating
- check `/health`
- check `/api/state`
- inspect WebSocket
- inspect Blockhead logs

## Final test

Run:

```bash
npm run typecheck
npm test
```

Then perform one end-to-end scenario:

1. CobbleBob idle.
2. Open dashboard.
3. Give owner instruction through Minecraft chat.
4. Dashboard immediately records instruction.
5. Thinking indicator activates during LLM inference.
6. Last decision appears.
7. Scheduler task appears.
8. Skill/activity appears.
9. First-person viewer shows movement.
10. Planned path is visible during pathfinding.
11. Coordinates/vitals update.
12. Task succeeds or fails.
13. Result enters activity timeline.
14. Dashboard returns to idle/background behavior.

Record any limitations honestly in the documentation.

Do not add unrelated features.

---

# OPTIONAL PROMPT 11 — Prepare a safe spectator/public mode

Only perform this phase after the LAN/Tailscale dashboard is stable.

The goal is to make the dashboard suitable for spectators without exposing operator-sensitive data or control surfaces.

Do NOT automatically expose Blockhead to the public internet.

## Add spectator configuration

Design something like:

```yaml
dashboard:
  spectator_mode: false
  show_exact_coordinates: true
  show_owner_name: true
  show_llm_endpoint: false
```

When spectator mode is enabled consider redacting:

- exact owner identity
- exact home coordinates
- internal hostnames
- llama.cpp endpoint
- filesystem paths
- raw stack traces
- configuration values
- internal debugging information

Do not redact gameplay information unnecessarily.

## No control API

Re-audit routes and WebSocket handling.

Public spectator mode must remain completely read-only.

The browser must not be able to:
- send owner commands
- initiate LLM calls
- enqueue tasks
- move CobbleBob
- mutate config

## Deployment boundary

Document options for exposing the dashboard through a separately configured reverse proxy or secure tunnel, but do not silently modify firewall/router/cloud settings.

Keep the application itself simple.

The core Blockhead process should not become an internet-facing administration system.
