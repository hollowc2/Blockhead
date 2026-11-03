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

## Done: offline scene and durability bars (2026-11-03, not yet deployed)

- **Offline scene.** While the bot answers but Bob is disconnected, the page
  sets `data-offline` on the frame and covers the game with a card: "CobbleBob
  is offline", how long he has been away, his last six story entries (the same
  filtered public feed) and the four milestones closest to done. The strip
  swaps inventory and story for one row of big lifetime stats. The streamer
  now counts exactly that case as presentable (`withOfflineScene` in
  `tools/stream/broadcast-state.mjs`): bot `/health` says disconnected, the
  page reports `#viewerStatus` "offline" *and* its offline scene, and the
  renderer is healthy. A down, dead or stale bot, a crashed or frozen
  renderer, or an older page without the scene still get the fixed holding
  card. On reconnect the viewer must reach "connected" within the 5 s
  debounce, or the stream shows "Reconnecting" until the usual 15 s
  admission. Local run (fixture, real Chromium + ffmpeg, 130 s): live → bot
  disconnected → offline card on the encoded stream → back, all without
  leaving LIVE, 0 encoder interruptions, ~31 fps.
- **Durability bars.** `equipment.<slot>.durability` in the public state is
  what is left as a tenths bucket (rounded up; absent for items that never
  wear), taken from the private gear projection only when it names the same
  item in the same slot. Raw use counts and enchantments stay private
  (`public-state.test.ts`). The hotbar draws a Minecraft-style bar, green to
  red, once an item is worn; the armor material strip moved to the slot's top.

Deploy the bot first (page and state), then copy `stream.mjs`, `renderer.mjs`
and `broadcast-state.mjs` to the stream runtime and restart it. Either half
alone is safe: an old streamer shows the holding card while Bob is offline,
and a new streamer with an old page sees no `data-offline` and does the same.

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
- **More public thinking.** Prompt the model for a short spectator-facing
  line with no numbers or places, instead of relaxing the filter, so the
  bubble shows real reasoning more often.
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
