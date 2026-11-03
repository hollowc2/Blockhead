# Stream resilience and the holding screen

Implements [prompt 08](implementation-prompts/08-stream-resilience-and-holding-screen.md).
Source: `tools/stream/`. Runtime: `~/.local/share/cobblebob-stream` on Maia.
Private state: `~/.local/state/cobblebob-stream/`.

## The chain and who supervises what

```
Minecraft ─► blockhead.service (bot, /health on 127.0.0.1:8155, public listener 127.0.0.1:3003)
                 │ own reconnect loop (backoff ≤ 1/min), death recovery + death-loop brake, watchdog
                 ▼
cobblebob-stream.service (one node process, Nice=10, MemoryMax=2500M, Restart=always)
   ├─ Renderer   headless Chromium → :3003/broadcast → CDP JPEG frames  (relaunch w/ backoff)
   ├─ BotHealth  polls /health, keeps only booleans + reason codes
   ├─ BroadcastState  STARTING / LIVE / RECOVERING / HOLDING / MAINTENANCE
   ├─ Publisher  30 fps pacing of the live frame or a holding card     (bounded, latest-only)
   └─ Encoder    one ffmpeg: MJPEG pipe + silent AAC → RTMP           (restart w/ backoff, budget)
                 ▼
YouTube ingest ─► YouTube player (verified only by a person watching; status says "unknown")
```

The streamer never restarts the bot, Minecraft or llama-server. Bot recovery
(reconnect, respawn, death-loop brake, task checkpoints) remains the bot's job;
the stream only chooses what to show while it happens.

## What is covered

| Failure | Covered by | Viewer sees |
|---|---|---|
| Bot down, disconnected, dead, stale server observations | holding card through the healthy encoder | "Reconnecting", then "Taking a break" after 10 min |
| Viewer socket loss, capacity refusal, "offline", stalled UI retries | holding card + page reload after 2 min stall | same |
| Browser launch failure, page/context crash, browser exit, stuck navigation, WebGL failure | holding card; Chromium relaunched with 5 s→5 min backoff; **encoder untouched** | same |
| Frozen 3D frame behind a still-animating shell | rAF counter inside the 3D iframe | same |
| Missing/corrupt holding asset | embedded last-resort card (`holding-fallback.mjs`) | plain "CobbleBob · Back soon." |
| ffmpeg crash, no progress, input blocked | ffmpeg restarted alone, 2 s→60 s backoff, 6 per 10 min, then the service restarts | **a short interruption** (recorded) |
| Node process crash / OOM | systemd restart after 15 s; holding card from the first frame | an interruption |
| Maia power/OS loss, home internet loss | **not covered** — needs the off-host publisher below | YouTube's own "offline" state |
| YouTube-wide outage | not coverable from another YouTube publisher | — |

A holding card can't go through a dead encoder or a lost uplink. Complete
outage coverage is **not implemented**; it needs the off-host option below and
an owner decision.

## Broadcast states and budgets

Time comes from `performance.now()` (monotonic); wall-clock jumps cannot move it.

| Parameter | Default | Why |
|---|---|---|
| Health-loss debounce | 5 s | with 2 s polls and the 3 s probe timeout, holding appears ≤ 10 s after viewer/renderer loss |
| Hard failure (crash/close/disconnect) | immediate | a crashed page can't show the world truthfully |
| Bot server-observation freshness | 30 s | Minecraft sends a time update every second even to an idle bot; 30 s matches the client keep-alive timeout, so a quiet connection is never "stale" |
| Bot /health unreachable | 10 s | the status server shares the bot's event loop, so long synchronous planning can delay a reply |
| Live frame freshness | 10 s | still scenes send no screencast frames; a screenshot every 5 s keeps them fresh |
| Admission back to live | 15 s healthy **and** a frame rendered inside that window | a cached frame from before the outage cannot re-admit |
| Flap control | admission doubles for each extra live exit in 10 min, max 120 s | no rapid live/holding toggling |
| "Reconnecting" → "Taking a break" | 10 min | after that, automatic recovery is not a believable promise |
| Our own late evaluation (> 8 s gap) | restarts the debounce | a stall in the streamer is not evidence against the viewer |
| Scheduled renderer refresh | 6 h | bounds Chromium memory; it shows ~20–30 s of "Reconnecting" each time |

Precedence: maintenance latch > hard failure > debounced health loss.
Unknown health counts as unhealthy. Degraded autonomy (paused by the owner,
user work, death-loop brake, model outage, repeated task failures) is recorded
as `autonomy` in the status but **never** selects the holding card: the world
is still truthfully presentable.

Health questions and their evidence:

- **Bot/session:** `minecraft.connected`, `health > 0`, and the new
  `minecraft.serverObservationAgeMs` (age of the last server time packet for the
  current session; reset on death/respawn/disconnect). Reuses the existing
  `PublicSafetyObservations` tracker.
- **Viewer:** `#viewerStatus === "connected"` (only set after the current
  token's socket delivered rendered chunk geometry) and an advancing rAF
  counter inside the 3D iframe.
- **Renderer:** a page probe answering within 3 s, and a live frame from the
  current renderer generation in the last 10 s. Frames from older generations
  are dropped; holding frames never refresh live freshness.
- **Encoder:** ffmpeg's own `-progress` frame counter advancing (not bytes
  Node accepted), plus `stdin` backpressure. Writes are dropped, never queued,
  while ffmpeg isn't draining.
- **YouTube playback:** not observable from Maia without new credentials; the
  status always says `"playback": "unknown"`. Check it by watching.

## The page the stream renders

`STREAM_PAGE` defaults to `http://127.0.0.1:3003/broadcast`, a fixed
1280×720 TV layout made for the stream ([prompt 09](implementation-prompts/09-broadcast-screen.md)).
The unit doesn't set it. The bot serves it (`blockhead.service`, from
`src/dashboard/public/broadcast*` via `viewer-shell.ts`) on its public
listener, so a change to the page ships with the bot, not with the stream
runtime. The interactive viewer at `/` is unchanged but no longer streamed.

Renderer contract (`renderer.mjs`, checked by `viewer-shell.test.ts` and
`renderer.test.mjs`): exactly one `.stage iframe` (the 3D frame the rAF probe
reads) and `#viewerStatus` holding the session state. The page applies the
camera itself (the scene machine's shot, follow by default; see
stream-backlog.md) and re-applies it when the 3D frame reloads. Scene
changes rescale the iframe and never detach or reload it. The renderer
doesn't inject CSS, press keys or click. It also no longer sets Playwright's
`bypassCSP`, which was only there for the injected stylesheet. The page and
the viewer frame run under the same CSP as for any visitor
(`SHELL_SECURITY_HEADERS` and `VIEWER_SECURITY_HEADERS`). The rAF init script
goes in through CDP, which CSP doesn't govern.

To go back to the old page, roll the runtime back (see below). Setting
`STREAM_PAGE=http://127.0.0.1:3003/` on the new runtime would stream the
interactive page with its question box and view toggles showing, and the
camera in orbit mode.

## The holding screen

Assets in `tools/stream/assets/` (generated by `build-holding.mjs`, which needs
`rsvg-convert` and `ffmpeg`; text is real SVG text in Noto Sans, SIL OFL):

- `holding-{starting,reconnecting,break}.svg` — editable sources
- `holding-*.png` — 1280×720 review images; `holding-*.jpg` — runtime frames
- `previews/*-crop-9x16.png`, `*-crop-guide.png`, `*-854x480.png`, `*-480x270.png`
- `../holding-fallback.mjs` — the embedded last-resort card

Copy is fixed and allowlisted (a test enforces it): **CobbleBob**,
**Back soon.**, **His adventure will continue. Thanks for waiting.**, and one
status: **Starting up** (STARTING), **Reconnecting** (RECOVERING),
**Taking a break** (HOLDING, MAINTENANCE). The status pill names its state in
words, not colour alone. All essential content sits inside the centred 405×720
9:16 crop with ≥ 47 px on each side (measured on the rendered image).

## Operator procedures (on Maia, as corey)

```sh
ctl="node ~/.local/share/cobblebob-stream/streamctl.mjs"
$ctl status                 # scene, reason codes, encoder frame/fps, interruptions, totals
$ctl transitions 50         # recent scene changes with health reason codes
$ctl hold                   # maintenance latch: "Taking a break" until cleared; survives recovery
$ctl auto                   # clear it; live returns after the admission window
$ctl reconnect-encoder      # restart ffmpeg only (brief interruption)
journalctl --user -u cobblebob-stream -n 100 --no-pager
```

**YouTube shows "Preparing stream" but Studio says "Excellent".** Check
`$ctl status`: if `encoder.health` is `ok` and `encoder.frame` advances, the
problem is downstream. First reload the Studio preview / watch page in a fresh
tab. If it still doesn't play after a minute, run `$ctl reconnect-encoder`
once (this cleared the 2026-11-01 incident). If YouTube ended the previous
broadcast and created a new one that sits at "Live stream offline" (the watch
page's `playabilityStatus` is `LIVE_STREAM_OFFLINE` while `ss` shows the RTMP
socket acked and growing), a 2 s reconnect is not enough: stop the unit, wait
60 s, start it (`systemctl --user stop cobblebob-stream; sleep 60; systemctl
--user start cobblebob-stream`). This cleared the 2026-11-02 incident within
10 s of the restart; Studio's own "start stream" button did not. Don't restart
the bot or rotate the stream key as a generic fix.

**Alerts.** Prepared as local conditions only (no external destination is
approved): `status.json` older than 10 s; `encoder.health != ok` for > 2 min;
`state == HOLDING`; `holdingAssetsMissing` non-empty; `NRestarts` rising.
`soak-sample.mjs` records all of them.

## Privacy

The streamer reads private `/health` but keeps only `{ok, reason}` plus a
coarse autonomy word; a canary test checks that no coordinates, names, task
text or model endpoint survive. `status.json` and `transitions.jsonl` are 0600
and contain only reason codes. ffmpeg stderr is reassembled across chunks,
then every `rtmp(s)://…` URL, the literal key and key-shaped tokens are masked
before logging; overlong lines are dropped whole. Nothing new listens; no page
or asset makes a remote request; the landing page and YouTube visibility are
unchanged.

## Evidence so far (2026-11-02)

Local, on Zeus, with `fixture-server.mjs` (fake shell + fake /health) and a
real Chromium + ffmpeg writing MPEG-TS:

- Unit tests: `node --test tools/stream/*.test.mjs` — 46 pass (state machine,
  publisher backpressure/generations, redaction with split chunks/RTMPS/
  multiline/canaries, encoder supervision with fake processes, bot-health
  projection canaries, assets).
- Scenario A (150 s): bot absent at start → holding from frame 1; live 15 s
  after bot healthy; viewer "offline" → holding in 6 s → live 15 s after
  return; 14 s frozen 3D frame → holding in 10 s; browser killed → relaunch
  5 s later, live after a 30 s (flap-extended) admission. One ffmpeg the whole
  time: 4496 frames for 149.9 s (30.0 fps), keyframes every 2.00 s, no
  timestamp gaps, AAC audio for the full length. Extracted frames match the
  logged state at each sample. No Chromium or fixture processes left over.
- Scenario B (75 s): Chromium launch failing (5→10→20→40 s backoff) with
  continuous holding output; maintenance latch held, then cleared to
  RECOVERING; ffmpeg killed → restarted alone in 2 s, interruption recorded;
  `streamctl reconnect-encoder` → ffmpeg restarted, interruption recorded.

Not yet observed: anything on YouTube, a 24-hour soak, the real viewer's
behaviour under these faults on Maia.

### The switch to /broadcast (local, Zeus, 2026-11-02)

I used the same Chromium build as Maia (headless shell 141, Playwright
1.56.1) and a runtime copy laid out like `install.sh`'s. Output went to a
local MPEG-TS file, not RTMP.

- **Fixture `/broadcast` (175 s).** Live 18 s after start. `streamctl hold`
  switched to the "Taking a break" card at once. `auto` went to RECOVERING,
  then live 17 s later. `bot=down` went to "Reconnecting" in 5 s, and
  `bot=up` brought live back 16 s after the viewer reconnected. One ffmpeg
  ran the whole time (generation 1, 0 interruptions, 30.7 fps), the
  renderer opened once, and no Chromium was left over. Frames extracted
  from the file show the broadcast layout with "camera follow" in the fake
  3D frame, and the holding cards at the logged times.
- **Real CSP.** The real public `ViewerShellServer` served the real
  prismarine viewer with a fake bot and fixture state. There were 0
  `securitypolicyviolation` events in the page or the 3D frame and no
  console errors. `#viewerStatus` read `connected`, the rAF counter
  advanced and the follow camera was on, in the normal, action and night
  scenes.
- **Cost, old `/` against `/broadcast`.** Both ran against the same real
  viewer and fixture state, in a scope with `MemoryMax=2500M`. Figures are
  means of 5 s samples after a 30 s warm-up, over 3–4 min per run. CPU is %
  of one core. Zeus has a different CPU and GPU from Maia, so compare the rows
  with each other, not with Maia's absolute numbers.

  | Page | Chromium PSS (6 procs) | node PSS | ffmpeg PSS | cgroup mean / peak | Chromium CPU | ffmpeg CPU | node CPU | Encoded |
  |---|---|---|---|---|---|---|---|---|
  | `/` (old runtime: injected CSS, T, `bypassCSP`) | 929 MB | 109 MB | 95 MB | 1060 / 1651 MB | 148 % | 95 % | 11 % | 30.5 fps |
  | `/broadcast` normal (P4: 1280×720 iframe at 0.75) | 961 MB | 107 MB | 92 MB | 1073 / 1625 MB | 147 % | 86 % | 12 % | 30.3 fps |
  | `/broadcast` night (iframe at 0.5 + brightness) | 962 MB | 105 MB | 93 MB | 1153 / 1625 MB | 136 % | 71 % | 11 % | 30.3 fps |

  Before P4, when the iframe was 960×540 and unscaled, `/broadcast` measured
  951 MB Chromium PSS, 154 % Chromium CPU and 81 % ffmpeg CPU, so it was
  level with `/`. Taken together, the page costs the same as the old one to
  within noise (about +30 MB PSS), and the night scene uses less CPU. The
  peak of about 1.65 GB is the Chromium start-up transient, and it is the
  same for both pages. On Maia the old page ran at 1.78 GB service memory,
  so expect about the same there.

## Fault-injection plan for an authorized private trial

Run only with the stream private and the owner watching the YouTube preview.
Each row: trigger → expected → independent check → recovery bound → cleanup.

1. `systemctl --user stop blockhead.service` → "Reconnecting" ≤ 15 s → watch
   page + `$ctl status` reason `bot-unreachable` → start it; live ≤ 15 s after
   the bot reports connected → `pgrep -fc ms-playwright/chromium` unchanged.
2. Server console `kick CobbleBob test` → holding ≤ 15 s, bot reconnects by
   itself → live after admission → one bot in `list`.
3. `pkill -f 'headless_shell.*--type=renderer'` → holding immediately
   → relaunch → live ≤ 60 s → Chromium count back to baseline.
4. `kill -STOP` the ffmpeg pid for 30 s, then `-CONT` → `encoder-stalled`
   restart, a recorded interruption → YouTube resumes ≤ 1 min.
5. `$ctl hold` / `$ctl auto` → card within 1 s / live after admission.
6. Repeat 3 ten times → Chromium count, `MemoryCurrent`, fd count stable.

## Independent coverage for host/WAN loss (proposal — not deployed)

YouTube offers a backup ingest per stream key (`backupIngestionAddress`, and
`rtmpsBackupIngestionAddress` for RTMPS; e.g. `b.rtmp.youtube.com/live2?backup=1/<key>`),
documented as a simultaneous copy of the primary. Its precedence and
switch-back behaviour when the backup carries different content (a card) is
not documented; it must be tested privately before relying on it.

- **Host:** a small VPS that is not on the home network (1 vCPU, 1 GB,
  ~$5/month); no inbound ports beyond SSH from the tailnet.
- **Publisher:** `ffmpeg -re -stream_loop -1 -i holding-break.mp4 -c copy -f flv <backup URL>`
  from a pre-encoded 10 s clip of the "Taking a break" card, encoded with the
  same settings (1280×720, 30 fps, H.264 `-g 60`, AAC 44.1 kHz stereo 128k).
  `-c copy` keeps CPU near zero.
- **Gating:** Maia sends an outbound authenticated heartbeat (HMAC'd POST
  every 15 s, containing only `encoder.health` and `state`) to the VPS. The VPS
  starts its publisher after 60 s without a good heartbeat and stops it after
  5 min of good ones (switch-back hysteresis). In normal operation only Maia
  publishes. Nothing on the VPS connects back to Maia.
- **Credentials:** the stream key stored only on the VPS in a 0600 file; the
  heartbeat secret separate from it.
- **Rollback:** stop and disable the VPS unit; Maia is unaffected.
- **Testing:** with a private test broadcast, stop Maia's streamer, confirm
  the card plays on YouTube, restart it, confirm YouTube returns to the
  primary. Then pull Maia's uplink in a scheduled window.

Needs, before anything is built: confirmation that the channel shows a backup
server URL for this key, the owner's approval for an off-host resource and for
copying the key to it, and a chosen alert destination.

## Deployment and rollback

Pre-deployment runtime (2026-11-02, recorded before this change):
`stream.mjs` sha256 `57ec2e37…d92d63e`, `viewer-health.mjs` `593277ec…b11225`;
`cobblebob-stream.service` NRestarts=0. Rollback copies are kept in
`~/.local/share/cobblebob-stream.rollback-<date>/`.

Deploy (from Zeus, after committing):

```sh
scripts/deploy-maia                                     # bot: adds serverObservationAgeMs
ssh maia 'cp -a ~/.local/share/cobblebob-stream ~/.local/share/cobblebob-stream.rollback-$(date +%F)'
cd tools/stream && scp stream.mjs viewer-health.mjs broadcast-state.mjs bot-health.mjs encoder.mjs holding.mjs holding-fallback.mjs publisher.mjs redact.mjs renderer.mjs streamctl.mjs soak-sample.mjs maia:.local/share/cobblebob-stream/
ssh maia 'mkdir -p ~/.local/share/cobblebob-stream/assets'
scp assets/holding-{starting,reconnecting,break}.jpg maia:.local/share/cobblebob-stream/assets/
scp cobblebob-stream.service maia:.config/systemd/user/
ssh maia 'systemctl --user daemon-reload && systemctl --user restart cobblebob-stream'
```

Rollback: `systemctl --user stop cobblebob-stream`, copy the rollback
directory back over the runtime, restore the old unit (`git show
HEAD~1:tools/stream/cobblebob-stream.service`), daemon-reload, start.

### Deploying the broadcast page (prompt 09)

The page and its data come from the bot. The stream runtime only changes
where it points and stops restyling the page. **Deploy the bot first.** A new
streamer pointed at an old bot gets a 404 on `/broadcast`, finds no
`.stage iframe` and stays on the holding card while it relaunches with
backoff.

Before you start:

- The P7 review is done and main is committed in `/mnt/Repos/Games/Blockhead`
  with no tracked changes (`scripts/deploy-maia` refuses otherwise).
  `npm run check` passes.
- The owner knows that this restarts the 24-hour soak window, because the
  runtime changes. The bot restart also drops Bob from the world for a few
  seconds.
- `config/minecraft.yaml` has `dashboard.public_viewer.model_label: Qwen3.5 9B`
  (committed with the public fields). It must name the model llama-server
  really serves. Check it read-only with `ssh maia 'systemctl --user cat
  llama-server.service | grep -E -- "-m |--model"'`. The schema allows
  letters, digits, spaces, dots and dashes, up to 32 characters. The bot
  reads the file from its working directory (the source checkout) at
  start-up, so a change needs the bot restart in step 1.

- No drop-in overrides the page: `ssh maia 'systemctl --user cat
  cobblebob-stream | grep STREAM_PAGE'` prints nothing. Step 3 replaces the
  unit file but not drop-ins, and a `STREAM_PAGE` there would keep the old page.

Steps, from Zeus:

```sh
# 1. Bot: typecheck + tests on Maia, rsync to ~/.local/share/blockhead-runtime, restart blockhead.service.
#    The old streamer keeps filming / and shows "Reconnecting" until the bot is back.
scripts/deploy-maia

# 2. The bot serves the page and its data (expect 200, then the label, then 200; 503 while Bob is disconnected).
ssh maia 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3003/broadcast
  curl -s http://127.0.0.1:3003/api/state | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);console.log(j.brain?.model, !!j.now, !!j.vitals)})"
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3003/api/public/minimap'

# 3. Stream runtime: keep a rollback copy, then copy the two changed modules and the unit (comment only).
#    No new runtime files; package.json is unchanged, so no npm install.
ssh maia 'cp -a ~/.local/share/cobblebob-stream ~/.local/share/cobblebob-stream.rollback-pre-broadcast'
cd tools/stream && scp stream.mjs renderer.mjs maia:.local/share/cobblebob-stream/
scp cobblebob-stream.service maia:.config/systemd/user/

# 4. Restart the streamer (an output gap of about 15–20 s).
ssh maia 'systemctl --user daemon-reload && systemctl --user restart cobblebob-stream'

# 5. Check: LIVE within about 30 s, viewerState "connected", about 30 fps, memory well under 2500M.
ssh maia 'node ~/.local/share/cobblebob-stream/streamctl.mjs status | head -40
  journalctl --user -u cobblebob-stream -n 30 --no-pager | grep -E "page open|viewer state|broadcast state|renderer"
  systemctl --user show cobblebob-stream -p MemoryCurrent -p MemoryPeak -p NRestarts'
```

Then watch the YouTube preview. It should show the broadcast layout with
the follow camera (his eyes or the overhead orbit for a minute every few
minutes), and no question box or view buttons. If the watch page
sits at "Live stream offline" after the restart, use the stop-60 s-start
procedure under Operator procedures.

Rollback: `systemctl --user stop cobblebob-stream`, copy
`~/.local/share/cobblebob-stream.rollback-pre-broadcast/` back over the
runtime, `git show <pre-P6 commit>:tools/stream/cobblebob-stream.service` into
`~/.config/systemd/user/`, daemon-reload, start. The bot doesn't need rolling
back, because `/` is unchanged and `/broadcast` is only an addition.

## 24-hour qualification

```sh
systemd-run --user --unit=cobblebob-soak node ~/.local/share/cobblebob-stream/soak-sample.mjs --hours 24 --interval 60
```

Writes `~/.local/state/cobblebob-stream/soak-<date>.jsonl` with start/end
records and deployed hashes. A missing `"kind":"end","complete":true` means
the soak is incomplete; a runtime change restarts the window. Launch criteria
are listed in the prompt (≥ 99.5 % live-world, ≥ 99.9 % output availability,
≥ 29 fps average encoded, no unexplained restarts, playback checked at
start/middle/end by a person).

## Deployment record (2026-11-02)

- Bot: `scripts/deploy-maia` → runtime at `4abbe7b`, restarted 10:10:48 PST;
  `/health` reports `serverObservationAgeMs` ≈ 0.4 s while connected.
- Stream: targeted copy of the runtime modules, three holding JPEGs and the
  unit; restarted 10:11:06 PST. Holding card from the first frame; live
  admitted at 10:11:28 (15 s after the viewer connected).
- First checks on Maia: 30 fps encoded over a 60 s window, 0 interruptions,
  one ffmpeg, publisher RSS 144 MB, service memory 1.78 GB (limit 2.5 GB),
  memory pressure avg10 0.00. The stream key and RTMP URL appear 0 times in
  the journal and state directory; state files are 0600 in a 0700 directory.
- Rollback material: `~/.local/share/cobblebob-stream.rollback-2026-11-02/`
  (old runtime plus `cobblebob-stream.service.unit`).
- 10:51 PST: Maia lost its network for about 70 s ("Network is
  unreachable"). The encoder restarted 4 times with backoff and recovered by
  itself; the RTMP URL appeared only as `rtmp://[redacted]`.
- Afternoon: the broadcast was made Public. YouTube had already ended it
  (replay 1:33:54) and created a new Public broadcast stuck at "Live stream
  offline" despite an acked RTMP socket. One `reconnect-encoder` (13:45) and
  Studio's start button didn't help; stopping the unit for 60 s (13:57:50 →
  13:58:51) did. YouTube reported `OK`/`isLiveNow` at 13:59:05, live admitted
  13:59:21, and playback on billybitcoin.cloud/cobblebob/ was seen working.
  This restart is inside the soak window, so the soak records it.
- Not yet checked: fault injection on Maia.

## Deployment record (2026-11-02 evening, prompt 09)

- Bot: `scripts/deploy-maia` → runtime at `d24ce89`, restarted 20:05:43 PST.
  `/broadcast` 200, `/api/state` carries `brain.model` "Qwen3.5 9B",
  `now`, `vitals`, `self.timeOfDay`; `/api/public/minimap` 200.
- Stream: rollback copy `~/.local/share/cobblebob-stream.rollback-pre-broadcast`,
  `stream.mjs` + `renderer.mjs` + unit copied, restarted 20:06:02. LIVE at
  20:06:43 (healthy), about 30.8 fps, 0 encoder interruptions, NRestarts 0.
  Memory 1.69 GB after settling (peak 2.22 GB at start-up).
- This restarted the 24-hour soak window, with the owner's approval.

## Readiness decision

**INCOMPLETE QUALIFICATION.** The 24-hour soak started after this deployment
and has not finished (and includes one manual unit restart); no
fault has been injected on Maia; host/WAN loss is uncovered until the owner
decides on the off-host publisher. This is not a decision to go public.
