# Stream backlog

Ideas for making the 24/7 YouTube stream (`tools/stream/`) better to watch.
Not scheduled. Pick these up once CobbleBob reliably does visible work
(see `docs/implementation-prompts/06-…`).

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
