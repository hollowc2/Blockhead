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

## Backlog

- **Offline scene with recent story.** The streamer's holding card is
  deliberately fixed copy. A richer offline state with the last story
  entries would have to come from the page, while the bot is up but Bob is
  disconnected.
- **More public thinking.** Prompt the model for a short spectator-facing
  line with no numbers or places, instead of relaxing the filter, so the
  bubble shows real reasoning more often.
- **Durability bars** on the equipment hotbar. This needs a redacted durability
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
