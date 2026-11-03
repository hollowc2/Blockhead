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

- **Picture-in-picture.** A small second camera: an overhead view of home,
  or his eyes while the main view follows. A second prismarine renderer
  costs RAM; the stream unit already runs at about 1.7 GB of its 2.5 GB
  limit on Maia. A cheaper
  start is a still overhead snapshot refreshed every minute or two.
- **Camera rotation.** Cycle follow, his eyes and a wider orbit/overhead
  shot every few minutes, and cut to a closer view in interesting moments
  (combat, building, mining ore). The streamer no longer sends key presses,
  so drive this from the page's scene machine. Keep the `.stage iframe`
  attached so the renderer's probe keeps working.
- **Offline scene with recent story.** The streamer's holding card is
  deliberately fixed copy. A richer offline state with the last story
  entries would have to come from the page, while the bot is up but Bob is
  disconnected.
- **More public thinking.** Prompt the model for a short spectator-facing
  line with no numbers or places, instead of relaxing the filter, so the
  bubble shows real reasoning more often.
- **Durability bars** on the equipment hotbar. This needs a redacted durability
  field.
- **Health checks.** Send an alert (push notification) if the stream service
  restarts repeatedly or YouTube ingest drops for more than about 10
  minutes. Add a daily frame snapshot to catch a frozen or black picture.
  The local alert conditions are listed in stream-resilience.md; no external
  destination has been approved yet.

Constraints: keep Maia private (outbound only), keep the stream's RAM within the
unit's `MemoryMax`, and never show coordinates, the server address or owner-only
panels.
