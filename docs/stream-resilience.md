# Stream resilience and the holding screen

Implements [prompt 08](implementation-prompts/08-stream-resilience-and-holding-screen.md).
Source: `tools/stream/`. Runtime: `~/.local/share/cobblebob-stream` on Maia.
Private state: `~/.local/state/cobblebob-stream/`.

## The chain and who supervises what

```
Minecraft ─► blockhead.service (bot, /health on 127.0.0.1:8155, viewer on 127.0.0.1:3003)
                 │ own reconnect loop (backoff ≤ 1/min), death recovery + death-loop brake, watchdog
                 ▼
cobblebob-stream.service (one node process, Nice=10, MemoryMax=2500M, Restart=always)
   ├─ Renderer   headless Chromium → loopback viewer → CDP JPEG frames   (relaunch w/ backoff)
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

## Readiness decision

**INCOMPLETE QUALIFICATION.** The 24-hour soak started after this deployment
and has not finished (and includes one manual unit restart); no
fault has been injected on Maia; host/WAN loss is uncovered until the owner
decides on the off-host publisher. This is not a decision to go public.
