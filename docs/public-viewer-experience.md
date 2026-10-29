# Public spectator experience — local implementation evidence

Run-order step 02 builds on [security hardening](public-viewer-security.md).
No live configuration, services, gesture settings or world actions were changed.

The shell waits for the visitor's actual transport and first worker-generated
geometry to appear in a rendered frame. It distinguishes connecting, loading
world, watching, reconnecting, full capacity, unavailable, offline bot and
WebGL failure. The status pill describes the independent API/bot connection;
a graphics failure does not label Bob offline. Renderer events contain only a
fixed enum, version and random per-frame-load token. The shell checks exact
schema, same origin, source WindowProxy and current token; stale frames fail.
Bot-session replacement changes the public opaque viewer session tag and
replaces the frame. The redacted public shell has process lifetime and serves
offline status before the first bot connection and between reconnects; only
the raw renderer/private shell are bot-session scoped. The dependency patch installs this bridge reproducibly.

Capacity/unavailable/disconnected frames are destroyed, with at most three
jittered retries (15/30/60 seconds plus 0–5 seconds). Then manual retry remains
available. No waiting queue or queue position is invented. Pausing releases the
seat immediately. Visible watchers are never ejected just for not clicking.
Hidden tabs stop status polling/rendering, retain their seat for 60 seconds,
then unload 3D; return fetches a fresh snapshot before reacquiring a seat.
Pending handshakes still obey the five-second server bound from step 01.
Private viewers keep four seats outside the configured public maximum of six.

Lightweight mode never loads a renderer iframe or allocates a seat. It retains
status, vitals, story and optional Q&A. Only bounded mode/help preferences are
stored locally; storage failures are caught. Conversation text stays in the
current document, with a maximum of eight question/result pairs and a clear
control. Suggestions use the same submission path. Visitor/model strings are
textContent only, no HTML, links, Markdown actions or tools. One pending request
at a time has a bounded wait, no automatic submission retry, and keeps drafts
on failure/refusal. Successful non-refusal answers clear an unchanged draft.
Model, basic status fallback and refusal have safe response classifications.

Controls follow server admission flags and explanations for disabled, busy,
offline and cooldown states. Reasons are associated through aria-describedby;
results are announced through one live region, not by rereading the transcript.
Cooldowns anchor at request start to avoid adding network latency repeatedly.
Visitor/shared waits remain separate. Hello has its own cooldown; a refusal
on hello does not consume unrelated gesture admission. Delivery uncertainty is
never presented as a successful gesture and is never replayed automatically.
Keyboard focus, touch camera hints, 44-pixel mobile camera buttons, first-use
help and reduced-motion CSS are included. Owner maps/jobs/previews/cameras and
commands remain private.

## Checks actually run

- `npm run typecheck`: passed.
- `npm run test:public`: passed during implementation; lifecycle, server contract
  and renderer-bridge tests added afterward are included in the full suite.
- `npm test`: **997 passed, zero failed**, 37.1 seconds at step completion. Final lifecycle
  validation also covers offline startup/disconnection/replacement, adapter
  shutdown during startup and cryptographic frame tokens on ordinary private
  HTTP origins; see the final launch report for the combined count.
- `git diff --check`: passed.
- `node scripts/patch-prismarine-viewer.mjs` twice: passed/idempotent.
- Real `npm ci --no-audit --no-fund --cache /tmp/blockhead-npm-cache` in isolated
  `/tmp/blockhead-clean-install-check`: passed, 280 packages, including native
  install scripts and postinstall. The resulting viewer bundle hash matches
  the workspace bundle: `0636597c08377c0af0b72a22865ee5b94cbfff206dcdc5f1030af44bb8df8c35`.
- Fake-timer/transport tests exercise capacity retries, source/origin/token
  validation, stale messages, readiness, session replacement, WebGL failure,
  pause, hidden grace/recovery, lightweight zero mounts and request timing.
- Firefox headless, isolated `/tmp` profile, actual local shell → renderer → fake
  world: real geometry rendered and shell reached `connected`; zero browser
  errors. Desktop 1440×1000 and narrow 390×844 layouts inspected. No horizontal
  overflow; mobile focus remained in the question input. Q&A used the real
  local basic-status endpoint; additional model/refusal results were mocked
  only within the test page. Eight-turn bound, clear history, HTML inertness,
  no seat in lightweight and draft retention passed. Additional real-browser
  checks passed for Enter-key submission, model refusal labels, shared busy
  controls, disabling questions during pending work and API/offline recovery.
- Separate browser preload disabled localStorage and forced WebGL context
  creation to fail: page reached `webgl-failed`, API stayed Online, switching
  to lightweight unloaded the iframe. Recovery/capacity/background transitions
  are also tested with controllable transport and timers.

The Browser plugin had no connected browsers. Visual work used an isolated
headless Firefox via its local WebDriver BiDi port. No real mobile device,
Safari, touch gestures, screen reader or reduced-motion browser emulation was
available; reduced-motion CSS is implemented, but those usability observations
remain deployment/acceptance follow-ups. Fake flat terrain does not establish
production frame rates or real-world capacity.

## Reproduce optional browser checks locally

Do not start `src/index.ts`. Start only `npx tsx scripts/public-viewer-fixture.ts`
and use its printed loopback URL. The fixture has no Minecraft/model/database
connection and disables gestures; its accelerated test clock avoids waiting
between Q&A assertions. In another terminal, use a **new isolated profile**:

```sh
mkdir -p /tmp/blockhead-fixture-firefox
firefox --headless --no-remote --profile /tmp/blockhead-fixture-firefox --remote-debugging-port 9223 about:blank
```

Then `node scripts/public-viewer-browser-check.mjs http://127.0.0.1:<fixture-port>`.
It accepts loopback fixtures only, writes screenshots/results under `/tmp`,
uses DOM keyboard-form submission and injects controllable answers for failure
cases. Stop the fixture and isolated Firefox after testing. The protocol port
must never be publicly exposed. The normal Node suite has no browser dependency.
