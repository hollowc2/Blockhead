# Qualify CobbleBob for public streaming and build a recovery holding screen

## Objective and authorization

Before Corey takes CobbleBob's YouTube stream public, make the stream reliable,
prove that CobbleBob remains connected and capable of useful autonomous work,
and provide a finished branded holding graphic whenever the live world is
unavailable. Keep the audience informed while recovery runs, then return to the
real world automatically when it is safe and healthy.

This prompt is an implementation assignment when separately invoked. **Writing
it does not execute it.** Its implementation scope covers repository changes,
graphic assets, isolated tests, and a concrete deployment/qualification plan.
Check the current session's authorization before any live rollout, service
restart, production fault injection, external notification, or new off-host
resource. Honor approval already granted for that specific work; do not infer
approval for this new feature from an earlier, completed stream repair. Do not
change YouTube visibility or publish the landing page as part of this task.

Read applicable repository and server-management instructions. Preserve the
existing working tree: recent viewer and streamer repairs may be uncommitted.
Do not reset, overwrite, or reimplement them blindly.

## Current system and lessons to preserve

Verify these against the current code before editing:

- `tools/stream/stream.mjs` uses Playwright/headless Chromium to render the
  redacted viewer, captures JPEG frames through CDP, and feeds ffmpeg for
  outbound YouTube RTMP video plus silent AAC audio.
- The current format is **1280 × 720, 16:9, 30 fps**, approximately 3000 kbps
  video and 128 kbps audio. Keep this format; do not introduce 1080p or a second
  local portrait encoder. YouTube currently supplies the vertical auto-crop.
- `tools/stream/cobblebob-stream.service` runs separately from
  `blockhead.service`, with lower scheduling priority and a 2500M memory limit.
  Check actual installed units and drop-ins rather than assuming this template
  is the full deployment configuration.
- Source lives in the repository; both services use isolated runtime copies.
  See `docs/deployment-maia.md` and the installed stream tooling. Editing the
  checkout does not demonstrate that a running process has the new code.
- `tools/stream/viewer-health.mjs` adds bounded recovery when the interactive
  viewer exhausts its retries. Preserve useful behavior and tests.
- `src/dashboard/viewer-server.ts` now paces all outbound viewer message types
  through bounded queues and coalesces entity updates. Healthy synchronous
  bursts previously tripped the connection guard. Requiring an empty transport
  queue and using short wall-clock timers also caused false disconnects during
  busy bot work. Preserve queue limits, fairness, cleanup and redaction.
- The existing streamer still has lifecycle coupling to browser startup and
  ffmpeg. Its frame pacing begins after `open()` succeeds, and some recovery
  failures shut down the entire stream. A holding screen must work during those
  exact failure paths, including failure before the first world frame.
- Local validation and a short private observation passed after recent
  repairs. These observations do not constitute a 24-hour qualification.
- YouTube once remained on **“Preparing stream” while showing “Excellent”**.
  Source frames and TCP acknowledgements continued. Reconnecting only the
  encoder cleared the preview. A running process, a frame-write counter, an
  acknowledged TCP connection and a green Studio badge are each incomplete
  evidence of playable end-to-end video.

Relevant sources include `src/dashboard/public/viewer-shell.html`, its CSS and
JavaScript, `viewer-session.mjs`, `src/dashboard/public-state.ts`,
`src/status/snapshot.ts`, `src/status/server.ts`, `src/agent/heartbeat.ts`,
`src/agent/watchdog.ts`, `src/agent/public-action-safety.ts`, and the reconnect,
death-recovery, scheduler and survival code reached from `src/index.ts`.

## 1. Establish a baseline and explicit failure coverage

Map the actual chain: Minecraft → bot/session → redacted state and world viewer
→ browser renderer → frame publisher → ffmpeg → YouTube ingest → playable
YouTube preview/watch output. Identify existing supervisors, retry budgets,
memory limits, ownership boundaries and sources of health evidence.

Collect a private baseline without printing credentials or raw process
arguments. Record versions, runtime hashes, service restart counts, bot
connection/liveness, viewer counters, CPU/RAM/GPU use, memory pressure, source
frame rate, encoder output progress and YouTube playback observations. Used
swap alone is not proof of current swapping; examine pressure and activity.

State the coverage honestly:

- A holding frame sent through a healthy publisher/encoder can cover bot,
  viewer, browser and model-related degradation.
- A graphic cannot pass through a dead encoder or a lost internet connection.
  Local supervision can reconnect output, but that creates an interruption.
- Maia power loss, OS failure or loss of home internet requires an independent
  off-host publisher to keep a placeholder on YouTube.
- A YouTube-wide outage cannot be hidden by another broadcaster on YouTube.

Deliver local resilience and a fully specified independent failover option.
Do not describe complete outage coverage as implemented unless that independent
path has actually been authorized, deployed and privately tested. If the owner
accepts a narrower scope, document the accepted gaps in the readiness decision.

## 2. Design and deliver the holding graphic

Produce finished assets, not just a description. Match the existing viewer:
dark slate, restrained teal/green accents, and the exact cube mark from
`viewer-shell.html`. Use an original, calm voxel scene—such as a small floating
cobblestone island with a pickaxe resting on it—to make the screen recognizable
as CobbleBob. Avoid a generic error dialog or a screenshot of a broken viewer.

Use this art direction:

> A quiet Minecraft-inspired intermission card for CobbleBob, an autonomous
> Minecraft companion. Dark slate background, subtle block shapes and depth,
> teal rim lighting, a small cobblestone island and a resting pickaxe. The
> established CobbleBob cube mark is the brand anchor. Keep the scene uncluttered
> and friendly. Reserve a clear central area for crisp, separately rendered
> text. No coordinates, maps, console windows, chat, server details, fake game
> statistics, loading percentages or fabricated recovery times.

Required text:

- Brand: **CobbleBob**.
- Main message: **Back soon.**
- Supporting line: **His adventure will continue. Thanks for waiting.**
- A short controlled status label appropriate to the scene, such as
  **Starting up**, **Reconnecting**, or **Taking a break**.

Make wording truthful. Use “Reconnecting” only while automatic recovery is
running; use neutral break/maintenance copy when intervention is required.
Never display exception messages, task text or LLM-generated prose as status.

Graphic requirements:

- Native 1280 × 720 artwork with editable source. Prefer the existing SVG/vector
  system for the mark and a lightweight illustration; use available image tools
  only if raster artwork materially improves the result. Render text separately
  so it stays sharp and correctly spelled.
- Supply an SVG source, PNG review image and a pre-rendered JPEG compatible with
  the current MJPEG input. Ship all required runtime assets with the installation.
- Essential logo, message and status must fit the central **405 × 720** area
  retained by a centered 9:16 crop of this 16:9 frame. Leave additional padding;
  test the actual crop rather than assuming centered text is sufficient.
- Inspect at 1280 × 720, 854 × 480 and a 480 × 270 preview. Keep the critical
  copy readable, with sufficient contrast and no text dependent on color alone.
- Use local fonts/assets with appropriate licenses. No CDN, trackers, external
  font requests, flashing effects or expensive WebGL animation. A static image
  is sufficient; any animation must be inexpensive and optional.
- Use a neutral background, not the last game screenshot, as the default
  holding screen. Do not accidentally present a stale scene as current action.

Keep artwork under a clear source-controlled location such as
`tools/stream/assets/`. Include preview images for each text variant and the
vertical crop. The operator must be able to review the real exported result.

## 3. Add a health-driven broadcast state machine

Separate broadcast presentation from individual service health. Implement and
test explicit states such as `STARTING`, `LIVE`, `HOLDING`, `RECOVERING` and
`MAINTENANCE`, with private reason codes identifying the affected component.

Define precedence: an operator maintenance latch overrides automatic return;
unknown or stale required health selects the holding scene; recovery returns
to live only after its admission conditions are satisfied.

Use documented, configurable defaults:

- Begin output with the holding frame as soon as the encoder is ready, without
  waiting for Minecraft, the status endpoint, Chromium or the first world frame.
- Select holding immediately for a confirmed browser crash/closed page. For
  transient health loss, debounce briefly and show holding within 10 seconds.
  Establish separate, justified freshness budgets for server observations;
  do not apply a 10-second packet-age rule to a legitimately quiet connection.
- After failure, require 15 seconds of sustained healthy required signals and
  a fresh rendered world frame before returning to live.
- Apply hysteresis, retry backoff and cooldowns so scenes do not flap and a
  failure cannot create a rapid restart loop.
- Track local durations with monotonic clocks. Test wall-clock jumps and delayed
  callbacks; synchronous bot work alone must not be interpreted as a dead viewer.

Health must cover distinct questions:

- **Bot/session:** connected, spawned/alive, fresh server-derived observations
  and a responsive session. A non-null entity or HTTP 200 alone is insufficient.
- **Autonomy:** functioning scheduler and safety/maintenance behavior, with
  evidence of useful work when appropriate. Idle time, sleeping, safe waiting,
  blocked prerequisites, an owner pause and normal slow tasks are legitimate.
  Reuse existing stall/watchdog policies rather than inventing a generic
  “has not moved recently” restart rule.
- **Viewer:** current session, live socket and genuinely rendered world data.
  Canvas existence, a CSS animation or a single historical “ready” event is not
  continuing proof of a healthy 3D connection.
- **Renderer:** browser/context/page responsiveness and fresh source frames.
  A still scene or nighttime darkness is not a failure by itself. Identical
  image hashes do not prove a frozen game.
- **Encoder/output:** process state plus advancing encoded output, bounded input
  buffering and a functioning output connection. Frame writes accepted by Node
  are not equivalent to video encoded or accepted downstream.
- **YouTube playback:** separately observed playable preview/watch output.
  Distinguish “healthy ingest”, “playback verified” and “playback unknown”.

Record source kind (`live` or `holding`) explicitly. Repeated fallback frames
must not reset a failed renderer's health or count as recovered gameplay.
Ignore frames and health events from an obsolete session/generation after a
reconnect. Never clear a failure just because an overlay or timer is advancing.

## 4. Keep output running while local components recover

Choose the smallest architecture that keeps the holding source independent of
the failed browser and bot. A fallback HTML page in the same crashed Chromium
process is not sufficient. Preload a validated JPEG before browser startup and
retain a low-cost last-resort graphic if a packaged decorative asset is missing.

Keep the ffmpeg output session alive across scene changes whenever it remains
healthy. Switch frame sources at the publisher without reconnecting RTMP for
ordinary bot/viewer outages. Keep dimensions, frame format, frame rate, silent
audio, timestamps and keyframe behavior consistent. A clean cut is acceptable;
do not add expensive transitions for this task.

Inspect current ffmpeg startup and shutdown paths. Browser launch failures,
navigation timeouts, WebGL failures, page/context crashes and renderer replacement
must lead to holding output plus bounded renderer recovery, not automatic
termination of an otherwise healthy encoder. Decide whether a separate render
worker is needed; do not introduce a collection of new services without a clear
failure-isolation benefit. Account for systemd's process-group kill behavior.

Honor `stdin.write()` backpressure and `drain`. Retain only a bounded latest-frame
buffer and drop obsolete frames rather than building a queue. Detect a blocked
or dead encoder independently: writing a holding frame to the same blocked pipe
is not recovery. Add sanitized ffmpeg progress instrumentation where appropriate.

If ffmpeg or the publisher fails, perform a bounded reconnect/restart with
backoff and an explicit recorded interruption. Startup must immediately have
holding frames available. Do not claim an uninterrupted YouTube session for a
case that tears down its publisher.

If local output stalls while YouTube reports “Excellent”, first distinguish
preview/browser failure from a broken ingest association. Provide an operator
procedure to refresh the preview and reconnect only the encoder when justified.
Do not restart the bot or rotate the stream key as a generic remedy.

Keep one bot, one active normal renderer and one primary encoder. Retire old
workers, sockets, listeners, timers and queues before replacements accumulate.
Preserve the existing public-viewer resource caps, redaction and read-only
boundary. Keep bot safety and inference ahead of rendering/encoding, and remain
within the current stream memory limit without enlarging it to conceal a leak.

## 5. Recover CobbleBob safely

Audit existing reconnect, respawn, death recovery, task resumption and watchdog
behavior before adding another supervisor. Distinguish an unavailable viewer
from a bot that actually needs recovery.

- Use normal reconnect/respawn and persistent task recovery for expected events.
  Preserve SQLite state, inventory accounting, goals, task checkpoints and
  session ownership; verify one connected bot after recovery.
- During death/reconnect, display the holding graphic if the world cannot be
  presented truthfully. Return only after the new session is healthy and rendered.
- Respect protected areas, safety gates, owner pauses and the death-loop brake.
  Do not force repeated respawns into danger, clear failure cooldowns, erase
  memory, reset the world or abandon owner work to manufacture apparent uptime.
- A model outage can leave deterministic survival/maintenance available. Treat
  this as degraded autonomy when appropriate, rather than automatically stopping
  the broadcast or restarting every service.
- Restart only the failed component, with a documented budget and cooldown.
  Persistent failure selects a holding/maintenance state and a private operator
  alert condition. Do not reboot a host or restart Minecraft/model services as
  an incidental viewer repair.

Provide a local operator override to force holding and later restore automatic
selection. Keep it private and consistent with existing authorization. A
maintenance override must not silently disappear during an unrelated recovery.

## 6. Specify independent coverage for complete stream failure

Prepare a concrete optional off-host holding publisher for encoder/host/WAN
outages. It must not require inbound access to the home network or use Maia's
public API as a dependency. An authenticated outbound heartbeat from Maia to an
approved off-host service is acceptable if explicitly authorized.

Before choosing an implementation, verify current official YouTube guidance and
actual channel capabilities for primary/backup ingest and failover. Do not
assume two publishers on the same primary URL are safe, that a backup URL is
enabled, or that matching “Excellent” labels prove correct precedence.

The proposal must identify the host, cost/resource budget, credentials handling,
startup behavior, heartbeat semantics, failure detection, primary-versus-backup
ownership, switchback hysteresis, rollback and safe private testing. Verify codec,
audio, keyframe and timestamp compatibility. Reuse a pre-encoded looping card
where feasible to keep remote CPU use low.

Do not provision infrastructure, copy stream credentials to another host, enable
new listeners, send alerts, or activate a second publisher without current
explicit authorization for that work. Prepare a reviewable result first. If
backup capability is unavailable or unapproved, clearly state that complete
host/WAN failure remains uncovered and requires an owner scope decision before
claiming full resilience.

## 7. Preserve privacy and provide useful operator evidence

No home-network exposure: no Funnel enablement, internet exposure of viewer/API
listeners, new public home ports, tailnet addresses in assets, or browser requests
back home from the public landing page. Preserve the existing loopback viewer
used by the encoder. Leave the landing page and YouTube visibility unchanged.

The graphic and any public status may contain only allowlisted static copy and
approved coarse state. Never forward private `/health` JSON directly: it
contains coordinates, task/goal details and model endpoint information. Keep
the private-to-public projection explicit and covered by canary tests.

Never reveal the Minecraft address, IPs, hostnames, base coordinates, seed,
player names, chat, config/operator values, filesystem paths or exception
messages on stream. Do not send private telemetry to an external model to
decide what can be shown. The holding screen must work without model inference.

Logs and diagnostics must never expose the stream key, RTMP URL credentials,
tokens or full ffmpeg command line. Test split stderr chunks, multiline errors
and both RTMP/RTMPS forms; filtering only complete URL strings in a single read
is insufficient. Use safe reason codes and secret canaries in regression tests.

Record private structured state transitions, source kind, health ages, retry
counts, actual encoder progress, outage/recovery durations and resource use.
Keep retention bounded. Prepare owner alerts as local events or a proposed
integration; do not send external messages without an approved destination.

## 8. Test failures before the public launch

Use fake clocks, synthetic streams, file output and disposable processes first.
Never start by killing production processes, disconnecting the home network,
altering the real Minecraft world or intentionally breaking the live stream.
Prepare a specific fault-injection plan for any later authorized private trial.

Each test needs a trigger, expected scene/output, independent observation,
recovery condition, time bound and cleanup proof. Cover at least:

- Bot absent at startup; holding video begins before any world is available.
- Bot disconnect, normal respawn and replacement session; old frames are rejected.
- Legitimate idle/sleeping, owner pause, safe waiting and a slow valid task.
- Repeated task failure, death-loop brake and a policy-blocked action.
- Model unavailable while deterministic behavior remains safe and functional.
- Viewer socket loss, capacity refusal, stale status and exhausted UI retries.
- Browser page/context crash, WebGL failure, launch failure and a stuck navigation.
- Stale render activity hidden by an animated overlay; a legitimate still/dark scene.
- Slow/blocked ffmpeg input, output failure, encoder crash and publisher crash.
- Missing graphic/font asset; last-resort holding output remains presentable.
- Mixed entity/terrain/position bursts, delayed server ticks and wall-clock jumps.
- Repeated live/holding/live transitions, maintenance latch and recovery flapping.
- Runtime restart with the bot down; startup does not depend on a successful viewer.
- Credential canaries, private-state canaries and malicious/raw error strings.
- A clean shutdown and at least ten failure/recovery cycles with no accumulating
  browser processes, listeners, sockets, timers, buffers or task ownership.

For approved off-host coverage, additionally test loss of the primary publisher
and an isolated simulated primary-host/WAN loss. Prove actual YouTube playback
switches to the card and returns to the correct primary. Simulation in a unit
test is not proof that YouTube's deployed failover works.

Produce short file recordings that show startup holding, live → holding → live,
and the vertical crop. Check frame dimensions, audio presence, timestamps,
keyframe intervals and decoded frame content with appropriate media tools.
Inspect the recordings visually and confirm that no private UI appears.

Run the repository's appropriate checks, including `npm run check` and relevant
public-boundary/stream regressions. Preserve the abandoned-client and mixed
traffic protections from the recent repair. Report commands actually run;
do not treat an old test count as evidence for a new revision.

## 9. Require a 24-hour private qualification

After an authorized rollout, first run a supervised smoke test and the approved
fault scenarios. Then run a **continuous 24-hour private soak** on Maia under
representative real bot activity, including gathering, crafting, movement,
combat/survival, idle/night, inference and ordinary reconnect behavior.
Exercise the six-hour renderer refresh rather than disabling it for the test.

Provide a repeatable sampler with bounded logs and an unambiguous start/end,
deployed hashes, settings and service identities. A session ending early means
the soak is incomplete. Do not label accelerated clocks or a five-minute test
as 24 hours of observed stability. A corrective runtime change restarts the
qualification window; preserve evidence from the failed attempt.

Separate planned fault injection from spontaneous incidents. Track live-world
availability, holding time and publisher output availability independently;
a day of continuous holding video is not successful autonomous gameplay.

Default launch criteria, subject to an explicit owner scope decision:

- All required regressions and visual/media checks pass.
- No spontaneous crashes, OOM kills, restart loops or unexplained viewer drops
  during the clean 24-hour window; no accumulating resource use or leaked workers.
- At least 99.5% healthy live-world availability and 99.9% video-output
  availability during the clean soak. Output may include correctly selected
  holding video; report both numerators, denominators and durations separately.
- Holding appears within the documented failure-detection budget and never
  masquerades as live gameplay. Healthy recovery returns after the admission
  window without repeatedly toggling scenes or duplicating the bot.
- Actual encoded video averages at least 29 fps in normal operation, with no
  unexplained sustained encoder stalls. Monitor short windows as well as the
  average, and explain any duplicated/dropped frames rather than hiding them.
- CPU, RAM, GPU memory and memory pressure remain within measured safe budgets;
  the stream does not impair bot survival or existing host workloads.
- Private YouTube playback is checked at the beginning, during the soak, after
  relevant recoveries and at the end. Record evidence or an owner observation.
  Ingest health and TCP acknowledgements alone do not pass this criterion.
- Every claimed failure mode has demonstrated coverage or an explicitly
  accepted limitation. Full host/WAN continuity requires the independent path.
- Operator actions, rollback and the finished graphic have been reviewed.

Return one clear outcome: **READY FOR OWNER REVIEW**, **NOT READY**, or
**INCOMPLETE QUALIFICATION**, with the measured evidence and remaining gaps.
Even a successful qualification does not authorize making the stream public.

## Deliverables and handoff

Deliver the code and tests, finished source/exported holding assets and crop
previews, installation/package updates, private health/override tooling, a
coverage/recovery explanation, a concrete independent-backup proposal, and
private recordings plus the qualification evidence and readiness decision.

Include exact deployment/rollback steps and preserved pre-deployment runtime
hashes. Copy only the intended files into the correct isolated runtimes;
include new modules and graphic assets. Do not install them into the live bot
directory accidentally or run a broad installer that changes unrelated services.

Before any approved deployment, record the current release/runtime and service
state, preserve rollback material and persistent bot data, then validate the
actual installed revision, one bot runtime, one normal renderer/encoder,
private bindings and a real playable private YouTube session. If validation
fails, restore the recorded runtime before further live experimentation.

At completion, explain what is implemented, what was observed on Maia and
YouTube, what is only simulated or proposed, and what still needs authorization
or owner input. Keep public launch and website publication as separate decisions.
