# A dedicated broadcast screen for the YouTube stream

Implements the "Screen redesign" brainstorm in [`docs/stream-backlog.md`](../stream-backlog.md).
Each phase is one agent prompt. The orchestrator runs them in the order
below, reviews each diff, runs `npm run check`, and commits per phase.
Phases P1 and P2 run in parallel in separate worktrees. Everything else
runs sequentially on main.

## Shared rules for every phase (read first)

- Read `README.md`, `docs/stream-backlog.md`, `docs/stream-resilience.md`,
  and this file's section for your phase. The current code is the source of truth.
- **Local work only.** Do not deploy to Maia, restart services, ssh to Maia,
  touch YouTube, or change the running stream. A 24 h soak is in progress and
  the broadcast is Public. Do not commit; the orchestrator commits.
- **Privacy is the main constraint.** The broadcast page loads only from the
  public listener (`:3003`) and only reads what `toPublicViewerState`
  (`src/dashboard/public-state.ts`) allows. Never expose coordinates
  (including relative offsets with labeled scale), player names (owner
  `Barnabyisbig` in `config/minecraft.yaml`, whitelist, anyone seen in chat),
  the server address, world seed, chat text, owner-only panels, or free text
  that hasn't passed a scrubber. Build every public field by allowlist and
  template, never by copying a snapshot object. Every new field gets a test in
  `src/dashboard/public-state.test.ts` that feeds hostile input (coords,
  names, hostnames, digits) and asserts that none of it leaks.
- The stream stays **1280×720** (no 1080p). Text must stay legible when
  YouTube scales to 480p on a phone. Minimum body text is about 20px at
  1280×720, labels about 16px.
- The page may load only loopback assets. No external fonts, CDNs or images.
  Item sprites come from the textures the viewer already serves
  (`/viewer/textures/...`, see `itemTextures` in `public/viewer-shell.js`).
- Look: match `viewer-shell.css`. That means the dark slate background, teal
  accent `#2ee6f0`, green `#3ccf7e`, and the cube mark.
- Budget: the stream unit has `MemoryMax=2500M` and Maia has about 2.2 GB
  free. Don't add a second WebGL renderer. DOM panels are cheap; avoid
  per-frame JS work (update on the 1 s state poll, use CSS animations).
- Match the surrounding code style and comment density. Keep the existing
  interactive viewer (`/`) working unchanged.
- Finish with `npm run check` (typecheck + all tests + `git diff --check`).
  Report the files changed, tests actually run, screenshots taken, and open
  questions.

## Target layout (normal scene, 1280×720)

```
+--------------------------------------+------------------+
|                                      | NOW              |
|   GAME  960×540 (follow cam)         | THINKING         |
|   day · time · hearts/hunger overlay | BUILD / BRAIN    |
|                                      | (minimap, P5)    |
+------------------+-------------------+------------------+
| INVENTORY grid   | STORY ticker      | STATS / BADGES   |
+------------------+-------------------+------------------+
```

That gives a 320px right column and a 180px bottom strip. The game keeps
its 16:9 shape.

---

## P1: public-state contract (worktree, parallel with P2)

Extend `PublicViewerState` in `src/dashboard/public-state.ts` with these
optional fields. Gather their inputs through `DashboardSnapshot`
(`types.ts`, `telemetry.ts`) or a small new module. Give each one leak tests.

1. **`now`**: `{ label, step, progress: {done, total} | null }`. Build it
   only from templates plus registry item names: goal `successCriteria`
   (item + min) and inventory counts give e.g. "Collect iron ingot · 3/10".
   Fall back to `publicStatus().detail`. Never copy goal `description`,
   `currentStep`, task `objective`, or `lastError` verbatim. If a step label
   is wanted, map task types to fixed phrases, like `public-status.ts` does.
2. **`build`**: `{ structure: humanized structureType, percent, blocksPlaced }`
   or null. Exclude `userGoal`, `origin`, `bounds`, `blocker` and shortage text.
3. **`brain`**: `{ thinking: boolean, decisionsLastHour, lastLatencyMs, model }`.
   `model` is a fixed display string from config (e.g. "Qwen3.5 9B"; it is
   already public on the landing page), never the endpoint.
4. **`thinking`**: `{ text, at } | null`, the latest decision rationale
   (`llmActivity.lastRationale` / `director.decided`) after a strict
   **scrub + reject-on-doubt** filter (owner decision, 2026-11-02):
   - Cap it at 120 chars on a word boundary.
   - Reject the whole text if it contains any digit, any known player name
     (config owner, whitelist, bot username, names seen in recent chat or
     entity lists, case-insensitive), a hostname, IP, URL, `@`, or private
     place words (home/base/chest **with** a direction or a number). Also
     reject anything `stripCoordinates` would change.
   - On rejection, return a fixed phrase for the task type, e.g.
     "Deciding what to gather next…". Never return a partially scrubbed
     original.
   - Put this in its own module (e.g. `src/dashboard/public-thinking.ts`)
     with a table-driven test of good/bad rationales, including real ones
     from `src/llm/prompts.ts` examples.
5. **`vitals`**: the last 60 minutes of `{health, hunger}` sampled once a
   minute (a ring buffer in memory, not SQLite) for a sparkline.
6. **`uptimeSeconds`**: the bot process uptime (already in the snapshot).

Keep `cachedPublicState` cheap. Nothing here may add per-request DB queries
beyond the existing snapshot. Export the new types for P3. **Write the final
TypeScript interface at the top of your report** so P2/P3 can bind to it.

## P2: broadcast page shell (worktree, parallel with P1)

Create `src/dashboard/public/broadcast.html`, `broadcast.css` and
`broadcast.js`. Serve them from `viewer-shell.ts` `serveShellAsset` at
`/broadcast` (+ the asset paths) on **both** listeners, with the same
security headers as the shell. Add route tests next to the existing
viewer-shell/viewer-server tests.

- Fixed 1280×720 layout (above). No buttons, tabs, forms, scrollbars or
  hover UI. Not responsive: it is a TV frame. It may scale down to fit a
  smaller window for local preview.
- The game embeds the same `/viewer/` iframe in a `.stage` element and uses
  `viewer-session.mjs` for the mount/retry lifecycle, like
  `viewer-shell.js`. **Keep the renderer contract** in
  `tools/stream/renderer.mjs`: a `.stage iframe`, a `#viewerStatus` element
  with the session state text (`connected`/`offline`/…), and follow camera
  enabled. Either keep a hidden `#followToggle` that `t` toggles, or apply
  follow mode automatically. If the latter, note it in your report so P6
  can drop the key press. The rAF probe must keep working inside the iframe.
- Poll `/api/state` once a second, like the shell does, and render only
  fields that exist today:
  - an **overlay on the game**: day number, time phase, hearts/hunger icons
  - an **inventory grid** with sprites and counts (items newly gained since
    the last poll glow for about 5 s)
  - an **equipment paper-doll** (armor + hand/off-hand)
  - a **story ticker** with the latest 4 entries and highlighted ones in color
  - **stats**: day, deaths, blocks mined, items crafted, km walked, nemesis
  - **progression badges** (wood → stone → iron → diamond → nether), derived
    from `world.milestones` and inventory/equipment item tiers, which light
    up as he reaches them
  - a **day/night dial**
- Leave clearly marked empty slots (`data-panel="now|thinking|build|brain|minimap"`)
  for P3/P5. Hide them gracefully when the field is absent.
- Render it locally against fixture data: add a `?fixture=1` mode, or extend
  `tools/stream/fixture-server.mjs` to serve the broadcast page with canned
  `/api/state` JSON. Take Playwright screenshots at 1280×720 and also scaled
  to 854×480. Check legibility and that nothing overflows. Save them in the
  scratchpad, not the repo, and list the paths in your report.

## P3: new panels (after P1 and P2 are merged)

Bind P1's fields into P2's empty slots:

- **Now** card with a progress bar.
- **Thinking** bubble. It reveals the text typewriter-style when `thinking.at`
  changes and shows a subtle "thinking…" pulse while `brain.thinking` is
  true.
- **Build** card (structure, % bar, blocks placed). It shows only while
  building.
- **Brain** stats (decisions/hour, last latency, model).
- **Vitals** sparkline (health and hunger, 60 min) as inline SVG.

Update the fixture states so every panel shows populated, empty, and edge
values (long names, zero, null). Add screenshots and run the 480p legibility
check again.

## P4: scenes and moments (after P3)

Build a small client-side scene machine in `broadcast.js`, driven only by
public state:

- *Normal*: the layout above.
- *Action*: triggered by `status.activity === "building"` starting, a new
  `fight`/`hostile`/`death` story entry, or a highlighted entry. The game
  grows to full frame (CSS transform/grid change, not a reload of the
  iframe) with a compact overlay strip. It returns to normal after 30 s with
  no new trigger. Debounce it so it can't flap.
- *Night*: `timePhase === "night"` and resting/sheltering. The game shrinks
  to about 50% and stats/story/(minimap) take over until dawn. Consider a
  mild brightness filter on the stage.
- **Event banners**: a 6 s banner for deaths, new tool/armor tiers, completed
  builds, and milestone unlocks (reuse the shell's milestone diff logic).
  Show one at a time, queued.
- **"What is this?" lower-third**: every ~5 min for 12 s. "CobbleBob is an
  autonomous AI playing Minecraft 24/7 on a home server." Fixed text.

The iframe must never be detached or reloaded by a scene change, because the
renderer watches it. Add unit tests for the scene machine (extract it as a
pure module the page imports, e.g. `public/broadcast-scenes.mjs`, tested
from a `.test.ts`).

## P5: minimap (optional, after P3)

A new public projection (e.g. `publicMinimap()` beside `owner-map.ts`)
served at `GET /api/public/minimap` on the public listener and polled about
every 5 s:

- Bob is at the center and the map rotates with his heading or stays
  north-up. Pick one and justify it.
- It shows his recent trail and a home icon, quantized to a coarse grid (≥4
  blocks) and clipped to a fixed radius. Home is clamped to the edge as an
  arrow when it is out of range.
- No numbers, scale bar, grid labels, chest/death/resource markers, or
  dimension names beyond overworld/nether/end. Values are small relative
  integers only.
- Leak tests check that the response contains no absolute coordinates for
  fixtures far from the origin, and is rate-limited like other public routes.

Render it as a small canvas or SVG in the `minimap` slot.

## P6: stream integration (after P4)

- Point the streamer at `/broadcast`: the default `STREAM_PAGE` in
  `tools/stream/stream.mjs` and the unit/env in `cobblebob-stream.service`
  or `install.sh`. Remove `BROADCAST_CSS` injection if it is no longer
  needed. Keep `bypassCSP` only if still required, and say why.
- Update `renderer.mjs` if P2 changed the follow contract. Update
  `fixture-server.mjs` and `*.test.mjs`.
- Run the full streamer locally against the fixture server, encoding to a
  local file (not RTMP). Confirm the live → holding → live transitions still
  work (`streamctl`), and measure Chromium + ffmpeg RSS/CPU against the old
  page. Report the numbers.
- Update `docs/stream-resilience.md` (deploy file list, page URL) and
  `docs/stream-backlog.md` (mark the done items, keep picture-in-picture and
  the rest as backlog). Write the Maia deploy steps, but don't run them.

## P7: independent review (last)

Use a fresh-context reviewer. Audit the whole diff since the start of P1 for
privacy leaks: every public field, the thinking filter, the minimap, and any
new route on the public listener (headers, rate limits, path traversal).
Then check correctness and resource cost. Report findings only; the
orchestrator applies fixes.
