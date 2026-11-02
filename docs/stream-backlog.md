# Stream backlog

Ideas for making the 24/7 YouTube stream (`tools/stream/`) better to watch.
Not scheduled. Pick these up once CobbleBob reliably does visible work
(see `docs/implementation-prompts/06-…`).

## Screen redesign (brainstorm, 2026-11-01)

Today the stream films the interactive viewer page (`viewer-shell.html`) at
1280×720 and hides its controls with injected CSS. Most of the frame is the
game, and the 300px side panel shows little: status, health/hunger, time and
dimension. The idea is to shrink the game and use the space for more of what
CobbleBob is doing and thinking.

**Base: a dedicated broadcast page.** Add a `/broadcast` route made for a
16:9 TV frame. It would have no buttons or tabs, large type that stays readable
at 480p on a phone, and a fixed grid. That beats adding more CSS overrides to
an interactive page. A smaller game canvas also makes WebGL cheaper, and DOM
panels cost little in the screencast. The stream stays at 1280×720 (decided
2026-11-01: no 1080p, to keep encoding cost down on Maia). A first layout:

```
+--------------------------------------+------------------+
|                                      | NOW              |
|   GAME  960×540 (follow cam)         |  Mining iron 3/10|
|   Day 12 · ☀ noon · ♥♥♥♥ 🍗🍗🍗       |  step: find cave |
|                                      | THINKING         |
|                                      |  "I need a stone |
|                                      |   pick before…"  |
|                                      | MINIMAP (no xyz) |
+------------------+-------------------+------------------+
| INVENTORY grid   | STORY ticker      | STATS            |
| (new items glow) | latest 4 events   | day 12 · deaths 2|
+------------------+-------------------+------------------+
```

The game at 75% width keeps its 16:9 shape. That leaves a 320px right
column and a 180px bottom strip.

**Panel ideas** (✓ = already in public state, ✗ = needs a new redacted field):

- **Now / goal** ✗. Goal, current step and progress (merges the "Goal overlay"
  item below). Use the same wording as the private Now card, without places.
- **Thinking bubble** ✗. A shortened LLM rationale ("why he's doing this").
  This is likely the biggest draw for an AI stream. It needs a scrubber for
  coordinates, player names and server details before it goes public.
  Typewriter reveal on each new decision.
- **Minimap** ✗. Centered on Bob, explored terrain and a home icon. No
  coordinate labels, scale bar or grid numbers.
- **Inventory grid** ✓. Item sprites (the viewer already loads
  minecraft-assets textures) with counts. Briefly highlight items he just
  got.
- **Equipment paper-doll** ✓. Armor slots plus held tool, with durability
  bars if we expose them.
- **Story ticker** ✓. The last few story entries, with highlighted ones in
  color. This could host the "Event moments" banners.
- **Session stats** ✗. Days survived, deaths, blocks mined, items crafted,
  distance walked, uptime. Counters you can track across a 24/7 stream.
- **Progression track** ✗. Wood → stone → iron → diamond → nether badges
  that light up as he reaches them. Gives returning viewers a long-term
  "where is he at".
- **Vitals sparkline** ✓ (needs history). Health and hunger over the last
  hour, so damage and eating show as a shape.
- **Day/night dial** ✓. Time of day as a dial with "night in 4 min", which
  sets up the night scene.
- **Build card** ✗. Build name, % done and blocks placed when building
  (redacted version of the private build progress).
- **Brain stats** ✗. Decisions this hour and the last decision's latency.
  Maybe the model name, if we're happy to show it.
- **"What is this?" lower-third** (static). Every few minutes, a short card
  for newcomers: "CobbleBob is an autonomous AI playing Minecraft 24/7 on a
  home server."

**Scenes.** Switch the layout by status instead of keeping one grid:

- *Normal*: the grid above.
- *Action* (combat, building, ore found): the game grows to full frame
  with a compact overlay strip, then shrinks back after ~30s idle. Pairs with
  "Camera rotation".
- *Night/sleeping*: the game shrinks further, and map, stats and story take
  over until dawn (covers "Night handling").
- *Offline/reconnecting*: a branded holding card with the last story
  entries and "back soon", so it doesn't look like a frozen game.

**Picture-in-picture.** A small second camera (overhead view of home, or his
eyes while the main view follows). A second prismarine renderer costs RAM.
A cheaper start: a still overhead snapshot refreshed every minute or two.

**Open questions**

- How much rationale can go public? It may need an allow-list of phrasing,
  not just a scrubber.
- Fonts and sprites have to be local (the page only loads from loopback).

Each ✗ item needs a field in `toPublicViewerState` plus a check in
`public-state.test.ts` that no coordinates or private text leak.

## Other ideas

- **Camera rotation.** Cycle follow (T), his eyes (V) and a wider orbit/overhead
  shot every few minutes. Switch to a closer view during interesting moments
  (combat, building, mining ore). The streamer already sends key presses to the
  page, so this is mostly a schedule plus event hooks.
- **Goal overlay.** Show the current goal more prominently with progress, e.g.
  "Mining iron (3/10)" or "Building: house extension, 42%". It should come from
  the same public facts the page already shows, so nothing private leaks.
- **Background music.** Quiet royalty-free/CC0 tracks mixed into the currently
  silent audio track (ffmpeg `-stream_loop` over a playlist). Check licenses for
  YouTube Content ID.
- **Night handling.** Nights are dark in the viewer. Consider brightening (a gamma
  CSS filter on the canvas), a "night: sleeping/sheltering" card, or the map view
  until dawn.
- **Event moments.** A short on-screen banner for deaths, new tools/armor, a
  completed build or first diamonds. Later, maybe automatic clips/highlights.
- **Health checks.** Alert (push notification) if the stream service restarts
  repeatedly or YouTube ingest drops for more than ~10 minutes. Add a daily frame
  snapshot to catch a frozen or black picture.

Constraints: keep Maia private (outbound only), keep the stream's RAM within the
unit's `MemoryMax`, and never show coordinates, the server address or owner-only
panels.
