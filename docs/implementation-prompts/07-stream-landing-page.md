# A public landing page for CobbleBob at billybitcoin.cloud/cobblebob

CobbleBob's public face is now a YouTube Live stream sent outbound from Maia
(`tools/stream/`, `cobblebob-stream.service`). Maia itself is private: Funnel is
off and Aegis is disabled. Build a static landing page for
`billybitcoin.cloud/cobblebob` that embeds the stream and explains the project.
**Nothing on the home network may be exposed:** no requests to Maia, no
Tailscale URLs, no API calls back home.

## Inputs to get from the owner (ask once, up front)

- The YouTube **channel ID** (starts with `UC…`). It's used in
  `https://www.youtube.com/embed/live_stream?channel=<ID>`, which always shows
  the current live broadcast. Don't use the stream key, ever.
- How `billybitcoin.cloud` is hosted (it resolved to `76.13.48.100` with
  Hostinger nameservers on 2026-11-01, and plain HTTP didn't answer). Find out
  whether it's a Hostinger site builder, File Manager/FTP, or Git deploy. That
  decides the deliverable format.
- Links they want shown (GitHub repo? Aegis-ML repo? socials?), and whether to
  name the owner.

## Page requirements

- One self-contained `index.html` (inline CSS, no build step, no trackers and no
  third-party scripts beyond the YouTube iframe). It must work from a
  `/cobblebob/` subdirectory, so use only relative paths.
- Above the fold: the title, a one-line pitch ("an autonomous Minecraft agent
  that gathers, builds and survives on its own, live 24/7"), and the responsive
  16:9 embed (`allow="autoplay; encrypted-media; picture-in-picture"`,
  `allowfullscreen`, `loading="lazy"`, `title` set). Below the embed, a "Watch on
  YouTube" link.
- An offline state: the embed shows YouTube's own "offline" card. Add a short
  line under it ("If the stream is offline, CobbleBob is probably restarting;
  check back soon").
- "How it works" in a few short sections: a mineflayer bot; a local LLM (Qwen3.5
  9B on a GTX 1070 Ti) as the director for goals/decisions; deterministic skills
  for movement, mining, crafting and combat; a read-only 3D viewer streamed with
  headless Chromium + ffmpeg. Keep it accurate to the repo, and check claims in
  the code and docs rather than guessing.
- **Don't publish:** the Minecraft server address, IPs, tailnet names
  (`*.ts.net`), the world seed, coordinates of the base, or anything from
  `config/`, `.env`, operator files, or `docs/DEPLOYMENT.local.md`.
- Matches the viewer's look (dark slate, teal accent, the cube mark from
  `src/dashboard/public/viewer-shell.html`). Readable on phones (360 px wide, no
  horizontal scroll) and passes a basic accessibility check (contrast, alt text,
  landmarks).
- Open Graph/Twitter meta (title, description, a preview image). For the image,
  use a frame captured from the stream on Maia (`ffmpeg` from the running
  output, or a one-off screenshot through `tools/stream/`). Check the frame shows
  no coordinates or private UI.

## Deliverable

Keep the source in the repo at `site/cobblebob/` (`index.html`, `og.jpg`) with a
short README containing deploy steps for the hosting method the owner uses. If
there's a Git or FTP deploy path the owner authorizes, publish it. Otherwise
hand over the files and exact upload steps. Verify the live URL loads on mobile
and desktop, the embed plays, and the page makes no requests other than to
YouTube and its own origin (check the browser's network panel or a headless
run).
