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
   ├─ Encoder    one ffmpeg: MJPEG pipe + silent AAC (+ music) → RTMP  (restart w/ backoff, budget)
   │             optional tee slave: rolling clip segments              (STREAM_CLIPS=on; off by default)
   └─ Clips      banner on the live page → joins segments into an MP4   (local only, capped)
                 ▼
YouTube ingest ─► YouTube player (verified only by a person watching; status says "unknown")
```

The streamer never restarts the bot, Minecraft or llama-server. Bot recovery
(reconnect, respawn, death-loop brake, task checkpoints) remains the bot's job;
the stream only chooses what to show while it happens.

## What is covered

| Failure | Covered by | Viewer sees |
|---|---|---|
| Bob disconnected from Minecraft, bot process up, page showing its offline scene | stays live (`withOfflineScene`) | the page's offline card: recent story, milestones, lifetime stats |
| Bot down, dead, stale server observations; disconnected without the page's offline scene | holding card through the healthy encoder | "Reconnecting", then "Taking a break" after 10 min |
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
- **Offline scene:** the one exception. `bot-disconnected` together with
  `#viewerStatus === "offline"` (the page's fresh answer from the bot) and a
  `[data-offline]` frame, with the renderer healthy, counts as healthy for
  both bot and viewer; status and transitions record it as `offline-scene`.
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

## Background music

`music.mjs`. On by default, and a no-op until there are tracks: with none,
the encoder args are the old silent-AAC ones.

| Env | Default | |
|---|---|---|
| `STREAM_MUSIC` | on | `off` keeps the silent track whatever is in the directory |
| `STREAM_MUSIC_DIR` | `~/.local/share/cobblebob-stream/music` | flat directory of tracks (`install.sh` creates it) |
| `STREAM_MUSIC_VOLUME` | `0.15` | linear gain per track (0–1); quiet under the picture |

How it works. At start-up (bounded to 5 s, before the first encoder start)
and every 10 min, the streamer lists the directory (`.mp3 .ogg .oga .opus
.flac .m4a .aac .wav`, ≤ 200 MB each, ≤ 500 files) and runs `ffprobe` once
per new or changed file. Files that don't probe as audio, or are shorter
than 5 s, are skipped and counted as `rejected`. ffmpeg's concat demuxer
feeds one decoder, so only the largest group sharing codec, sample rate,
channel count and stream lineup is used; the rest count as `incompatible`
(a cover-art MP3 has a different lineup from a plain one). **Keep all
tracks in one format**, e.g. all MP3 44.1 kHz stereo without cover art. Each
encoder start writes a fresh shuffled playlist (`music.ffconcat` in the
state directory), repeated to cover 7 days, because ffmpeg 9 can't
`-stream_loop` a concat input. ffmpeg mixes it onto the silent `anullsrc`
input with `amix=duration=first`, so the silent track sets the length. A
playlist that ends, or a track that fails mid-way, leaves the stream
running with silence until the next encoder start. (The concat demuxer
stops at a file it can't open rather than skipping it, which is why tracks
are probed first.)

A bad file can't take the stream down or burn the restart budget. A music
generation that ends without progress or inside 60 s is treated as a music
failure, and the following encoder starts run silent for 30 min (doubling
per repeat, up to 6 h). That way music costs at most one of the 6
restarts per 10 min. A pad-based design (`apad`) failed this way in testing
(ffmpeg 9: `ENOSPC` from the filter graph within 7 s), and the breaker
caught it: the stream went on silent after one restart.

New tracks are picked up at the next encoder start. To start one now:
`streamctl reconnect-encoder` (a short interruption). `streamctl status`
shows `music: { tracks, rejected, incompatible, playing, pausedMinutes }`;
the journal logs `music library` when the usable set changes.

Adding tracks (owner):

```sh
ssh maia 'mkdir -p ~/.local/share/cobblebob-stream/music'
scp *.mp3 maia:.local/share/cobblebob-stream/music/
ssh maia 'node ~/.local/share/cobblebob-stream/streamctl.mjs reconnect-encoder'
```

**Licensing is the owner's call.** Nothing is downloaded or committed here.
Only use tracks whose license allows use in a 24/7 YouTube live stream:
CC0, or a license whose attribution you put in the channel or stream
description. Many "royalty-free"
tracks are registered with Content ID, and a match on a live stream can
mute, block or strike it. Prefer sources that state they are not in
Content ID, keep each track's license text with it, and if YouTube flags a
track, delete the file and reconnect the encoder. Rollback copies made with
`cp -a ~/.local/share/cobblebob-stream …` also copy the music directory.

Measured locally (holding card fed at 30 fps, 50 s windows, ffmpeg 9): the
encoder went from 53 % to 58 % of a core and from 116 to 124 MB RSS with
music. Over the full 200 s fixture run with music there was one ffmpeg, 0
interruptions and 30.6 fps.

## Clips

`clips.mjs`. **Off by default** (`STREAM_CLIPS=on` to enable), because it
changes the encoder's output topology.

**On Maia it is on** since 2026-11-03, through the drop-in
`~/.config/systemd/user/cobblebob-stream.service.d/clips.conf`
(`Environment=STREAM_CLIPS=on`). After enabling it the stream unit sat at about
1.66 GB against `MemoryMax=2500M`, the encoder stayed healthy and YouTube kept
playing. To turn it off, delete the drop-in, `daemon-reload` and restart the unit.

| Env | Default | |
|---|---|---|
| `STREAM_CLIPS` | off | `on` adds the segment slave and cuts clips |
| `STREAM_CLIPS_DIR` | `<state dir>/clips` | saved MP4s (0700 directory) |
| `STREAM_CLIPS_MAX_COUNT` | 30 | retention: newest clips kept |
| `STREAM_CLIPS_MAX_MB` | 600 | retention: total size; a clip over it alone is deleted too |

Recording, without re-encoding. With clips on, the encoder's output becomes
`-f tee "[f=flv]rtmp://…|[f=segment:onfail=ignore:use_fifo=1:…]…/seg%03d.ts"`
plus `-flags +global_header` (the tee can't ask the encoders for the
headers FLV needs). The stream slave keeps tee's default `onfail=abort`, so
losing YouTube still ends ffmpeg and the supervisor restarts it as before.
The segment slave writes 4 s MPEG-TS segments (stream copy) into
`<state dir>/clip-segments/g<generation>/`. `segment_wrap=30` bounds that to
30 files (about 2 min, about 38 MB at 3 Mbit/s), and the previous
generation's directory is removed at each encoder start. It runs behind a
fifo that drops packets when full (`queue_size=600`, about 8 s), so a slow
disk loses segments, not stream frames. `onfail=ignore` means a write error
(disk full, directory gone) drops only that slave. Encoder health is
unchanged: one output, the same `-progress` frame counter and stdin
backpressure.

Triggers. The renderer's 2 s page probe also reads the page's event banner
(`#banner.show` with `data-kind`: `death`, `tier`, `build`, `milestone`;
banners last 6 s). Each new banner seen **while the stream shows the live
picture** (not a holding card) is a moment. Only the kind leaves the
renderer; banner text is never logged. The page contract is `#banner`,
its `show` class and `data-kind`, and `#bannerText`. If the page renames
them, clips just stop triggering.

Cutting. A moment makes a window from 20 s before to 15 s after. Another
banner inside a pending window extends it (up to 75 s). Seven seconds after
the window ends, the closed segments overlapping it (by file mtime) are
joined with `ffmpeg -f concat -c copy -movflags +faststart` into
`clip-<UTC time>-<kinds>.mp4`, written as `.partial.mp4` and then renamed.
Caps: 12 moments an hour, no cut with less than 2 GB free, a 60 s timeout on
the join, then retention. Nothing is uploaded. `streamctl status` shows
`clips: { recording, pending, clips, megabytes, saved, failed, skipped,
lastResult }`.

Costs and caveats: about 1 % of a core and 3 MB RSS more for ffmpeg
(measured as for music), plus about 0.4 MB/s of continuous disk writes
(about 35 GB/day, mostly overwritten in place). The segment files' page
cache is charged to the unit's memory cgroup. It can be reclaimed, but it
raises `MemoryCurrent`; watch it against `MemoryMax=2500M` on Maia before
leaving clips on. Clips start and end on 4 s segment boundaries.

Local evidence (Zeus, 2026-11-03; real Chromium + the fixture `/broadcast`
+ ffmpeg 9 to a local MPEG-TS file, 200 s, music from synthetic test tones):
one ffmpeg throughout (generation 1, 0 interruptions, 30.6 fps). Segments
rotated at 30 files and about 37 MB. A `death` banner and a `tier` banner
10 s later made one 48 s clip (`…-death+tier.mp4`, H.264 + AAC, the death
banner visible at 23 s). A `milestone` banner made a 40 s clip. Separately,
`encoderArgs` with clips streamed 40 s to a loopback RTMP listener. The
segment directory was deleted at 15 s: `Slave muxer #1 failed … continuing
with 1/2 slaves`, frames kept advancing, and the listener received the full
40 s with audio. In that run the playlist held a truncated and a corrupt
track, so music stopped early while the stream continued.
A streamer run with only corrupt files in the music directory reported
`tracks: 0, rejected: 2` and sent silence (−91 dB) with no restart.

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
$ctl alerts 20              # recent alert events and the open incidents (see Alerting)
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

**Alerts.** The streamer evaluates its own alert conditions (see
[Alerting](#alerting)). `soak-sample.mjs` still records the raw signals
(`status.json` age, `encoder.health`, `state`, `holdingAssetsMissing`,
`NRestarts`) for qualification.

## Alerting

Source: `alerts.mjs` (incident book, sink, readers), `frame-watch.mjs`
(frame check, daily snapshot) and `stream-health.mjs` (conditions, restart
counting, the guarded facade `stream.mjs` calls once a second). It is
advisory: `createStreamHealth` never throws, every call is wrapped, and if
the state directory can't be written it logs `health checks unavailable` and
does nothing. The stream doesn't depend on any of it.

**Conditions.**

| Condition | Raised when | Recovered when |
|---|---|---|
| `service-restarting` | ≥ 3 unplanned starts of the service in 30 min | fewer than 3 in the last 30 min |
| `encoder-exhausted` | the encoder used up its restart budget (raised just before the service exits 1) | the encoder is healthy for 5 min (in a later process) |
| `output-stalled` | `encoder.health != ok` (no ffmpeg progress, input blocked, down or restarting) for 10 min | healthy for 2 min |
| `not-live` | not LIVE for 10 min; the operator's MAINTENANCE latch doesn't count | LIVE (or latched) for 2 min |
| `picture-frozen` | while LIVE, every frame sample for 15 min matches the first (≤ 0.2 % of thumbnail pixels moved more than 6 grey levels) | changed, or not live, for 2 min |
| `picture-black` | while LIVE, for 3 min: the whole frame uniform (any colour), dark and flat, or the game area pure black | the same, 2 min |
| `holding-assets-missing` | a holding card fell back to the embedded card | the assets load (next start) |

YouTube ingest itself isn't observable from Maia (no credentials); ffmpeg
progress is the closest local signal, and an uplink loss shows up as
`encoder-exhausted`, then `service-restarting` (the encoder budget runs out
in about 3 min, the service exits 1 and systemd restarts it).

**No storms.** A condition must hold for its window before one `alert`
event, and must stay clear for its clear window before one `recovered` note
(with the same `id`). The book is persisted in `alerts-state.json`, so an
incident that outlives a service restart (a crash loop, an exhausted encoder)
is not raised again by the next process. The push hook is also capped at 6
deliveries an hour; past that, events are still recorded with
`"hook":"rate-limited"`.

**Time.** Durations use CLOCK_MONOTONIC (`process.hrtime`), which every
process of one boot shares, so a pending condition carries across a crash
restart (the gap counts as an outage) without trusting the wall clock. After a
clean stop (exit 0) or a reboot, pending onsets are dropped, so planned
downtime never becomes an alert; open incidents stay open.

**Restart counting.** `lifecycle.jsonl` (last 100 records) gets a `start`
record at start-up and a `stop` record with the exit code from the process's
`exit` handler. A start not preceded by a clean stop is unplanned: a crash, an
OOM or `SIGKILL`, or the encoder budget giving up (exit 1). An operator's
`systemctl --user restart` exits 0 and isn't counted. This is used instead of
systemd's `NRestarts`, which needs a `systemctl` call, resets on a manual
restart and can't tell a crash from a deliberate stop. Across a reboot the
window falls back to wall-clock time.

**Frame check.** Once a minute while LIVE, the current live JPEG is decoded by
a short-lived `ffmpeg` (the stream runtime has no image decoder; the
`canvas` package is the bot's) into a 64×36 greyscale thumbnail, about 2 KB.
That costs about one small ffmpeg process a minute. Leaving LIVE forgets the
evidence, since the holding card is still by design. The first live sample at
or after 12:00 local each day is kept as `snapshots/frame-YYYY-MM-DD.jpg`
(newest 14 kept) for a person to glance at. The stream picture is public, but
the files stay in the private state directory.

**Delivery.** No external destination is approved, so every event goes to:

- `alerts.jsonl` in the state directory (append-only, 0600, rotates to
  `alerts.jsonl.1` past 256 KB);
- the journal, as a `stream alert` line;
- `status.json` → `alerts` (open incidents, the last event, restarts in the
  window, frame-check stats), and `streamctl status` prints `open alerts:`
  from `alerts-state.json`, which is right even while the streamer is down;
- `streamctl alerts [n]`: the last n events and the open incidents.

Optional push hook, **unset by default**: `STREAM_ALERT_COMMAND`, a command
run with `/bin/sh -c`, one event per run as JSON on stdin. Runs are queued
one at a time (at most 10 waiting), killed after 10 s and never awaited by
the stream (shutdown waits up to 5 s for a pending one). The hook's
environment has no variable whose name contains KEY, SECRET or TOKEN, and its
output is discarded; only its exit status is logged. To wire one up later
(after the owner picks a destination), use a drop-in, for example:

```ini
# ~/.config/systemd/user/cobblebob-stream.service.d/alerts.conf
[Service]
Environment="STREAM_ALERT_COMMAND=curl -fsS -m 8 -H 'Title: CobbleBob stream' --data-binary @- https://<push service>/<topic>"
```

An event looks like:

```json
{"time":"…","kind":"alert","condition":"not-live","id":"not-live-20261103T045046","summary":"The broadcast has not shown the live world for 10 minutes.","sinceSeconds":600,"detail":{"state":"holding"}}
```

**Privacy.** Summaries are fixed strings. `detail` passes an allowlist:
known keys only, holding finite numbers, booleans, lowercase reason codes
(`[a-z0-9-]`) or short lists of them. No stream key, server address,
coordinates or free text can reach an alert; tests feed canaries for each.

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

Deploy (from Zeus, after committing). Since the health checks, the runtime
also needs `alerts.mjs`, `frame-watch.mjs` and `stream-health.mjs`, and since
music and clips `music.mjs` and `clips.mjs`:

```sh
scripts/deploy-maia                                     # bot: adds serverObservationAgeMs
ssh maia 'cp -a ~/.local/share/cobblebob-stream ~/.local/share/cobblebob-stream.rollback-$(date +%F)'
cd tools/stream && scp stream.mjs viewer-health.mjs broadcast-state.mjs bot-health.mjs encoder.mjs holding.mjs holding-fallback.mjs publisher.mjs redact.mjs renderer.mjs streamctl.mjs soak-sample.mjs alerts.mjs frame-watch.mjs stream-health.mjs music.mjs clips.mjs maia:.local/share/cobblebob-stream/
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

### Deploying music and clips (not deployed yet)

Stream runtime only; the bot is unchanged. Two new runtime modules, and
three changed ones. `package.json` is unchanged, so there's no npm install.

```sh
ssh maia 'cp -a ~/.local/share/cobblebob-stream ~/.local/share/cobblebob-stream.rollback-pre-music'
cd tools/stream && scp stream.mjs encoder.mjs renderer.mjs music.mjs clips.mjs maia:.local/share/cobblebob-stream/
ssh maia 'mkdir -p ~/.local/share/cobblebob-stream/music && command -v ffprobe'   # ffprobe ships with ffmpeg; without it music stays silent
ssh maia 'systemctl --user restart cobblebob-stream'
```

With an empty music directory and clips off, the ffmpeg command is the old
one plus explicit `-map 0:v -map 1:a`. To try clips, add a drop-in
(`systemctl --user edit cobblebob-stream`: `[Service]`
`Environment=STREAM_CLIPS=on`). Restart, then watch `streamctl status`
(`encoder`, `clips`) and `MemoryCurrent` for a while. Remove the drop-in to
turn clips off. Maia's ffmpeg version was not checked from here. The tee
`onfail`/`use_fifo` slave options, `amix` `duration=first` and `-flags
+global_header` are all old (ffmpeg ≥ 4), but run one local check of
`ffmpeg -h muxer=tee` on Maia first.

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
