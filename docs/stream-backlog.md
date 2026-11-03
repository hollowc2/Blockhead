# Stream backlog

Ideas for making the 24/7 YouTube stream (`tools/stream/`) better to watch.
Not scheduled. Pick these up once CobbleBob reliably does visible work
(see `docs/implementation-prompts/06-…`).

## Done: the broadcast screen (2026-11-02, deployed to Maia at d24ce89)

The 2026-11-01 "Screen redesign" brainstorm was built as
[prompt 09](implementation-prompts/09-broadcast-screen.md). The stream now
renders `/broadcast` (`src/dashboard/public/broadcast*`, served by the bot on
the public listener) instead of the interactive viewer with injected CSS.
See [stream-resilience.md](stream-resilience.md#the-page-the-stream-renders).

- **Base page.** A fixed 1280×720 TV layout with no controls and 480p-legible
  type. The game sits in a 960×540 area, beside a 320px right column and
  above a 180px bottom strip. It loads only loopback assets. The stream stays
  1280×720.
- **Panels.** Now/goal with progress (this also covers the old "Goal
  overlay" idea), a thinking bubble (scrub plus reject-on-doubt filter,
  `public-thinking.ts`), a coarse coordinate-free minimap
  (`/api/public/minimap`), an inventory grid with new-item glow, an
  equipment hotbar on the game view (it replaced the paper-doll to free the column), a story ticker, lifetime stats, wood → nether
  progression badges, a vitals sparkline (60 min), a day/night dial, a build
  card, brain stats (decisions/hour, latency, model label) and the "What is
  this?" lower-third.
- **Scenes** (`broadcast-scenes.mjs`). *Normal*. *Action* (building starts,
  fights, deaths and highlights make the game full frame, and it returns
  after 30 s quiet). *Night* (sheltering after dark shrinks the game and
  brightens it, and map, stats and story take over). This covers the old
  "Night handling" idea.
- **Event moments.** Queued 6 s banners for deaths, new tool/armor tiers,
  completed builds and milestone unlocks.

Each public field is built by allowlist and template in `public-state.ts`,
with hostile-input leak tests in `public-state.test.ts`. An independent
privacy review (P7) found no blockers; its fixes landed before deploy. The
thinking filter now also rejects the start of a private name, mid-sentence
capitalised words, spelled-out or signed coordinates and digits near a
private place, while plain item counts ("Gather 20 oak logs") pass. Build
story lines are re-rendered from a checked structure name so an owner's
build request never reaches the public feed.

What we learned on Maia:

- The stream unit settled at about 1.7 GB (start-up peak 2.2 GB) against
  `MemoryMax=2500M`, about the same as the old page.
- Replaying 14,687 real rationales through the filter, about 3% pass whole.
  The rest are mostly rejected for numbers ("…stockpile to reach 128…"), so
  the bubble usually shows a fixed phrase per task type.
- With the daylight cycle frozen, the dial shows "Daytime" with no countdown.

## Done: more public thinking (2026-11-02, not yet deployed)

The director and goal-driver prompts (`src/llm/prompt.ts`) now ask for an
optional `"spectator"` field: one short, friendly, first-person sentence (at
most 12 words) with no numbers, coordinates, directions, names or places.
The bubble shows it in preference to the rationale, and falls back to the
rationale and then the fixed phrase. The filter is unchanged, and the
spectator line goes through every check a rationale does
(`public-thinking.ts`).

- **Cheap.** The instruction is static text before the live state, so
  llama.cpp's prompt cache covers it, and the line adds about 15 output
  tokens. Owner-instruction prompts don't ask for it, because those
  thoughts never go public.
- **Can't break parsing.** The schema field never fails validation
  (`schemas.ts`). A line that is missing, not text, blank or over 160
  characters becomes null without a repair retry. `spectatorLine` and
  `spectator_line` are accepted too, and a line nested inside the action is
  lifted out.
- **Private.** The line is kept on `lastDecision` only, not on `lastCall`,
  which owner status copies whole.

Still to measure on Maia: how often the model writes the line, and how
often it passes the filter, compared with the 3% of rationales that do.

## Done: local health checks (2026-11-03, not deployed)

The streamer now raises its own alerts: the service restarting repeatedly
(counted across process lifetimes in `lifecycle.jsonl`), the encoder budget
running out, no encoder progress or no live world for 10 minutes, and a
frozen or black live picture (a 64×36 thumbnail decoded by ffmpeg once a
minute). One alert per incident plus a "recovered" note, persisted across
restarts. It keeps one live frame a day (14 kept). Alerts go to
`alerts.jsonl`, the journal, `streamctl status` and the new `streamctl alerts`.
An optional `STREAM_ALERT_COMMAND` hook is unset: **no push destination has been
chosen yet; the owner needs to pick one.** See
[stream-resilience.md](stream-resilience.md#alerting). Deploying it needs three
new runtime modules (`alerts.mjs`, `frame-watch.mjs`, `stream-health.mjs`).

## Done: camera rotation and picture-in-picture (2026-11-03, not yet deployed)

- **Camera rotation.** The scene machine (`broadcast-scenes.mjs`) also picks
  the shot, and the page sends it to the viewer as a `bob-cam` event; the
  `.stage iframe` is never touched. It cycles follow (150 s), his eyes
  (40 s), follow, and a slow overhead orbit (45 s). Anything that starts the
  action scene (fights, deaths, highlights, a build starting), or ore landing
  in the inventory while gathering, cuts to a close shot for 20 s after the
  last trigger; sheltering at night holds follow. Cuts are at least 6 s
  apart. The two new shots ("wide", "close") are added to the viewer bundle
  by `scripts/viewer-shots.mjs` via the patch script, which deploy-maia
  re-runs; an unpatched bundle shows them as the orbit camera.
- **Picture-in-picture.** The cheap start: a still, north-up, top-down
  picture of the 39×39 blocks around home (`public-home-view.ts`), one pixel
  per block, sitting between the dial and the hotbar in the normal scene.
  It is served as `/api/public/home.png` on both listeners. It is built only
  from home and block names (no entities, sign text, containers or map
  layers), as a bare PNG (IHDR/IDAT/IEND). It renders only when every column
  is loaded, so chunk edges never show, and the same scene anywhere in the
  world gives the same bytes. Requests never render: they start at most one
  background render per 90 s, and none while nobody watches. A render takes
  a few ms and the image is under 8 KB. The last picture stays while he is
  away from home; a new home drops it. A second live renderer (his eyes
  beside follow) is still out of reach on RAM.

## Done: background music and clips (2026-11-03, built locally, not deployed)

See [stream-resilience.md](stream-resilience.md#background-music).

- **Background music** (`music.mjs`). On by default and a no-op without
  tracks. Tracks go in `~/.local/share/cobblebob-stream/music/`; choosing
  them and checking their licenses and Content ID is the owner's call. They
  are probed with ffprobe, kept to one compatible format, shuffled into a
  repeated concat playlist (ffmpeg 9 can't `-stream_loop` a concat input)
  and mixed quietly (0.15) onto the silent track. A bad file is skipped, and
  if an encoder generation with music fails early, music pauses for a
  cool-off.
- **Clips** (`clips.mjs`). Off by default (`STREAM_CLIPS=on`). A tee slave
  writes a bounded rolling window of copy-codec segments with
  `onfail=ignore` behind a dropping fifo. Each event banner on the live
  picture becomes a 35–75 s MP4 in `~/.local/state/cobblebob-stream/clips/`,
  capped at 30 clips / 600 MB and 12 an hour. Nothing is uploaded.

## Backlog

- **Offline scene with recent story.** The streamer's holding card is
  deliberately fixed copy. A richer offline state with the last story
  entries would have to come from the page, while the bot is up but Bob is
  disconnected.
- **Durability bars** on the equipment hotbar. This needs a redacted durability
  field.
- **Health checks: push destination.** The local half is done (above). The
  owner still needs to pick a push destination (ntfy, Pushover, email, …)
  and set `STREAM_ALERT_COMMAND` in a unit drop-in.

Constraints: keep Maia private (outbound only), keep the stream's RAM within the
unit's `MemoryMax`, and never show coordinates, the server address or owner-only
panels.
