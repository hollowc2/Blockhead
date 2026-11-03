# Stream backlog

Ideas for making the 24/7 YouTube stream (`tools/stream/`) better to watch.
Not scheduled. Pick these up once CobbleBob reliably does visible work
(see `docs/implementation-prompts/06-…`).

## Done: the broadcast screen (2026-11-02)

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
  equipment paper-doll, a story ticker, lifetime stats, wood → nether
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
with hostile-input leak tests in `public-state.test.ts`.

## Backlog

- **Picture-in-picture.** A small second camera: an overhead view of home,
  or his eyes while the main view follows. A second prismarine renderer
  costs RAM; the page currently costs about the same as the old one, about
  1.1 GB for the stream unit on Zeus (see stream-resilience.md). A cheaper
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
- **Durability bars** on the paper-doll. This needs a redacted durability
  field.
- **Clips/highlights.** Cut clips automatically around event banners.
- **Background music.** Mix quiet royalty-free/CC0 tracks into the
  currently silent audio track (ffmpeg `-stream_loop` over a playlist).
  Check the licenses for YouTube Content ID.
- **Health checks.** Send an alert (push notification) if the stream service
  restarts repeatedly or YouTube ingest drops for more than about 10
  minutes. Add a daily frame snapshot to catch a frozen or black picture.
  The local alert conditions are listed in stream-resilience.md; no external
  destination has been approved yet.

Constraints: keep Maia private (outbound only), keep the stream's RAM within the
unit's `MemoryMax`, and never show coordinates, the server address or owner-only
panels.
