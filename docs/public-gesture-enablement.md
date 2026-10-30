# Public gesture enablement — qualification and supervised-trial package

Prepared 2026-10-29 under [implementation prompt 05](implementation-prompts/05-public-gesture-validation.md).

**Rollout update (2026-10-29 20:52 PDT):** after the user approved items A–C, A and B were completed on Maia. The bot runs `5eb20ae`, and the observer is installed with 22/22 hooks; its dry run reported `ready: true`. Actions are still off. Item C, the supervised window, was blocked for the agent by the permission classifier. The user then ran it on 2026-10-30, 14:08–14:18 UTC. It ended `window_expired`: no eligible moment occurred, so **zero requests were sent**. Actions were disabled and verified off. No gesture has been invoked, and acceptance remains unverified. See the [rollout receipt](investigations/public-gestures-2026-10-30-rollout.json).

**Gestures remain disabled. No live gesture effect has been accepted.** This
package contains an implemented, locally qualified candidate: admission and
cancellation repairs, honest visitor feedback, and an independent server-side
effect observer with its evaluator. It also contains a prepared trial and
rollback procedure. Nothing here was committed, deployed, installed on Maia or
invoked live. Local HTTP success is not a launch approval.

## Decision

**Technically ready for a bounded supervised trial. Not recommended to authorize
yet, because production offered no eligible window.**

- The candidate passes 1,069 tests. The observer passes 134 self-checks on the
  production Java runtime.
- On the real 1.21.4 server, the observer independently confirmed each of the
  four gestures locally. It refused to pass five deliberately broken gestures,
  even though every one of them returned HTTP 200 `sent`
  ([local qualification](investigations/public-gestures-2026-10-29-local-qualification.json)).
- A read-only sample of Maia's live admission predicate found **0 eligible
  moments in 60** samples over 10 minutes
  ([production windows](investigations/public-gestures-2026-10-29-production-windows.json)):
  - An autonomous task held the world lease in 59 samples.
  - A loaded enderman triggered the all-actions refusal in all 60 samples.
  - Movement or digging failed the physical gate in 51.

  A trial run now would very likely end `window_expired` with actions off. That
  is the designed outcome, but it would not establish acceptance.

Named gaps before any live trial:

1. **Eligibility.** Normal operation must produce safe windows. Clearing tasks,
   pausing autonomy, removing mobs or narrowing the enderman refusal to force a
   demo is not acceptable. Measure over a longer, read-only period first (Stage 0
   below).
2. **Authorization.** Three separate items need explicit approval: deploying the
   bot runtime, installing the observer (a Minecraft restart), and the trial
   window itself (see [Authorization items](#authorization-items)).
3. **Launch gates unchanged.** Offline Minecraft owner identity (an allowlist
   alone cannot prove it), owner-only tailnet ACLs, forwarding-address trust,
   log retention and a paired SQLite/world restore rehearsal remain open, as in
   the [launch assessment](public-viewer-launch-readiness.md). They do not block
   a supervised trial with actions off afterward. They do block persistent
   enablement.

## 1. What changed

### Evidence classes, kept separate

| Class | What it shows | Where |
|---|---|---|
| Implementation tests | Controller, wiring, HTTP, evaluator, collector and trial-runner logic against fakes and a real scheduler/lease | `npm test` (1,069 pass) |
| Independent server effects (local, disposable) | The real 1.21.4 server with the observer agent, real Mineflayer clients, the real controller and HTTP handler | [local qualification](investigations/public-gestures-2026-10-29-local-qualification.json) |
| Production observations | Read-only: versions, service state, listener bindings and 60 private admission diagnostics. No change, command or gesture | [production windows](investigations/public-gestures-2026-10-29-production-windows.json), this document |

### Bot runtime (candidate on base `15487ee`; Maia runs code-identical `d2e8371`)

- **Dispatch outcomes** (`src/agent/public-actions.ts`). `execute()` returns:
  - `refused`: nothing sent.
  - `dispatched`: the primitive was handed to the client and settled with the
    same session.
  - `interrupted`: sent, then cancelled or the session changed. Recorded as an
    irreversible dispatch, never as a cancellation.
  - `uncertain`: threw after starting, or not settled within the 1-second
    budget.

  The previous code returned `false` for both "nothing sent" and "sent then
  interrupted".
- **Turn settlement.** A forced Mineflayer look only changes local orientation;
  the packet is written on the next physics tick. Previously the lease was
  released as soon as `look()` resolved, before the packet existed, so another
  owner's orientation could merge into the same packet. The lease is now held
  until that tick, or until the connection ends, which counts as `interrupted`.
- **Quarantine.** Explicitly process-lifetime, with a cause (`timeout` or
  `primitive_error`). It survives session replacement and re-enabling actions,
  and is cleared only by restarting the bot service after review. A primitive
  that throws after starting now quarantines too; before, it was a silent
  `false`. Private diagnostics carry dispatch counters.
- **Admission wiring** (`src/agent/public-admission-wiring.ts`). The gate list
  moved out of `index.ts` into `createPublicAdmission`, so tests run the same
  function with a real `Scheduler`, `WorldActionExecutor` and `EventBus`. A new
  `alive` gate requires Mineflayer's `isAlive` (health can read positive just
  after a death packet).
- **Owner-chat interrupt** (`bindPublicOwnerChatInterrupt`). Found by review:
  owner chat routed to the LLM decision path emitted no `chat.command` until it
  created a task, so it did not cancel an in-flight gesture. Any owner chat now
  cancels.
- **HTTP and UI.** Action responses carry `delivery: sent | not_sent |
  uncertain` with matching text:
  - sent: "Sent to Bob's game client. Minecraft hasn't independently confirmed
    it."
  - interrupted: "Sent, but Bob was interrupted right after…"
  - uncertain: "Delivery could not be confirmed. Gestures are paused until an
    operator checks."
  - refused: "…Nothing was sent."

  "Done!" is gone. Private logs record `dispatch`. The page marks
  `data-delivery` (amber for uncertain) and never retries. Private diagnostics
  add `configuredQuestions`.
- **Unchanged:** the four fixed effects and no visitor-supplied arguments, strict
  schemas, Origin/Fetch Metadata checks, limits and cooldowns (separate hello
  cooldown), redacted public state, the 1-second budget, no public queue, no
  owner-command or tool-registry path, and the enderman refusal for all four
  actions.

### Gate matrix (every gate blocks all four actions; unknown or throwing reads refuse)

| Gate | Source | Real-wiring test |
|---|---|---|
| session | same READY bot object | `public-admission-wiring.test.ts` (connection) |
| physical | entity, **alive**, grounded, dry, finite orientation, stationary, health > retreat, food > emergency, awake, unmounted, no item use/eating/digging/window/combat target/controls/path movement/mining/building/goal | `public-actions.test.ts`, `public-action-admission.test.ts` |
| freshness | server `time` ≤ 2.5 s and physics ≤ 250 ms; reset on death/respawn/end | `public-action-safety.test.ts` |
| threats | live registry scan; reviewed mobs with reflex geometry and solid-cover ray; any unreviewed hostile (enderman included, at any loaded distance; false/missing metadata proves nothing) refuses | wiring and safety tests |
| death_loop, scheduler (halted), projects (incl. paused), goal, bootstrap, decision, background | process objects | wiring test, one case each |
| lease_owner, lease_waiters, active_task, queued_tasks, interrupt | real scheduler/lease | wiring tests using `runWorldAction`, `enqueue`, `claim`, `requestPause` |

The same predicate runs before reservation, again inside the immediate lease
before the effect, and in private diagnostics. These interrupt and cancellation
sources were tested:
- owner chat (LLM path) and owner commands;
- damage, hunger, night, hostile detection, task creation/activation and death;
- disabling actions, HTTP disconnect, session end or replacement, and shutdown.

Each prevents an effect that has not started, and leaves no lease, waiter or
listener behind. None of them can recall a packet already handed to the client:
those outcomes are reported as `interrupted`.

### Independent effect observer (`tools/gesture-observer`, `src/observer`)

A dependency-free Java agent (`-javaagent`) for vanilla 1.21.4 (protocol 769)
inserts a static call at the **entry** of 22 server methods. It changes nothing
else and calls no method that sends packets or mutates state. Patching is a
self-contained classfile edit:
- the prefix is NOP-padded to keep switch alignment;
- absolute offsets are shifted in the exception table, StackMapTable (including
  `uninitialized` types), and line/local-variable tables;
- methods with any other Code attribute are refused.

The agent patches nothing unless the loaded `version.json` reports exactly
1.21.4/769. Obfuscated names come from the official mappings for the exact
server JAR Maia runs.

- **Observation point 1, decoded inbound packets:** `Connection.channelRead0`
  for Bob's connection only. The packet class maps through a table of every 1.21.4
  serverbound packet; anything else is `unknown`. Move packets carry
  `hasRot/yaw/pitch`, chat carries only `fixedHello: boolean`, and swing carries
  the hand.
- **Observation point 2, applied effects and broadcasts:**
  - `PlayerList.broadcastChatMessage` (Bob as sender, fixed-text boolean);
  - `LivingEntity.swing`, plus `ServerChunkCache.broadcast` and
    `broadcastAndSend` of the animate packet, with action and recipient count;
  - the authoritative pose from `MinecraftServer.tickServer` every tick;
  - prohibited effects: `Player.attack`, `interactOn`, `useItem`, `useItemOn`,
    `handleBlockBreakAction`, `destroyBlock`, drop, `openMenu`, and damage dealt
    by Bob via `hurtServer`;
  - interference: corrections (`teleport`, `forceSetRotation`) and damage taken;
  - lifecycle: login, respawn, death, disconnect and entity changes.
- **Records:** typed NDJSON with server-run UUID, sequence, tick and wall time.
  They carry no chat text, no other player's identity or packets, and no raw
  dumps. Pose is private evidence and is never published; evaluator output holds
  only counts and deltas.
- **Collection:**
  - Only while a client holds `ARM <1–300 s>` on a Unix socket in an owner-only
    0700 directory (socket file 0600).
  - Bounded queue of 8,192 records. Drops keep consuming sequence numbers and
    are reported in-band, so a gap is visible.
  - Nothing is written to disk.
  - `UNHOOK` restores the original bytecode by retransformation.
  - Any setup failure leaves the agent inert. This was learned locally: an
    exception in `premain` aborted JVM startup.

### Correlation and tolerance rules (fixed in `GESTURE_RULES` before any trial)

- **Baseline:** ≥ 20 contiguous ticks before the send, settled (no move or turn).
- **Window:** from the send to response + 1,000 ms.
- **Post-window:** ≥ 40 contiguous ticks.
- **Turns:** Notchian server yaw. Mineflayer's `toNotchianYaw(y) = deg(π − y)`,
  so `look_left` = **−45°** and `look_right` = **+45°**. This was declared from
  source before running, and the local server agreed exactly.
  - **Yaw tolerance 0.01°.** Mineflayer quantizes to its 0.15° sensitivity grid,
    and 45° is exactly 300 steps. float32 spacing below 1,024° is
    ≤ 6.2 × 10⁻⁵°. So 0.01° is far above serialization error and far below one
    0.15° step.
  - **Pitch 0.001°.** It is resent unchanged.
  - **Position 0.001 block.**
  - **Change epsilon 0.001°.**
- **Outcome precedence:** `fail` on a definite violation, otherwise `unknown` on
  any doubt, otherwise `pass` only with the one expected effect present.
- **Always `unknown`:**
  - missing status, unsupported version or incomplete hooks;
  - a different server run, a sequence gap, or duplicate/reordered records;
  - overflow, an observer fault, invalid or truncated capture;
  - tick discontinuity, clock regression, or capture ending early;
  - lifecycle changes or Bob absent/removed;
  - unknown or unexpected packet types;
  - corrections or damage taken;
  - movement, other chat, or prohibited activity outside the window;
  - gesture activity outside the window;
  - an unsettled baseline, or post-window activity.
- **Always `fail`:**
  - prohibited packets or effects in the window (attack, interaction, use,
    use-on-block, dig, inventory/containers, commands, input changes, vehicles,
    creative slots, …);
  - an off-hand swing;
  - an effect the controller reported as not sent.
- **Overlap:** when owner or survival work overlaps the window, gesture-specific
  failures become `unknown` (`*_during_overlap`); that work is never suppressed.
- **Hello:** exactly one fixed chat packet and one accepted fixed broadcast from
  Bob.
- **Wave:** exactly one main-hand swing packet and one action-0 broadcast with a
  known recipient count; no off-hand swing. Zero self-echoes is expected and
  inconclusive.
- **Turns:** exactly one pose change of the expected signed size; pitch and
  position unchanged.
- **HTTP 200 with no effect:** `fail` with `effect_absent`.

Qualified with synthetic traces (`gesture-evaluator.test.ts`) and on the real
server with deliberately broken primitives (below).

### Local independent qualification (real server, disposable)

Setup:
- Official 1.21.4 `server.jar`, byte-identical to Maia's, run on a copy of
  Maia's Temurin 25.0.4.1+1 runtime.
- A scratch flat, peaceful world on 127.0.0.1:25613.
- Disposable `QualBob` (gestures) and `QualViewer` (tracking cross-check).
- The real Mineflayer plugins, `PublicActionController` and `PublicInteractions`.

Results, all reproduced in two runs:
- **Coverage:** all 22 hooks installed.
- **Confirmed effects:**
  - `hello`, `wave`, `look_left` (−45.0°) and `look_right` (+45.0°) each **pass**.
  - The wave broadcast reached 1 tracker; the viewer saw one main-arm animation
    and one fixed hello.
- **Broken primitives, all HTTP 200 `sent`, none passed:**
  - suppressed chat → `fail effect_absent`;
  - off-hand swing → `fail off_hand_swing`;
  - use-item → `fail prohibited_packet`;
  - wrong direction → `fail wrong_turn`;
  - second turn → `fail extra_turn`.
- **Quiet period:** zero non-ambient packets or effects while armed with no
  request.
- **Tick timing while armed:** mean 49.99 ms, max 51 ms. Armed hook cost:
  about 118 µs per tick/inbound call (≈ 0.24 % of a tick).
- **Teardown:** `UNHOOK` removed every hook and a later capture held zero tick
  records. The server exited 0 with no `VerifyError`.
- **Inert check:** with an unusable socket path, the server started normally and
  the agent printed one "disabled" line.

### Visitor feedback ([browser evidence](investigations/public-gestures-2026-10-29-browser.json))

Tested in headless Firefox against the isolated fixture (`FIXTURE_GESTURES=1`):
- idle, submitting (all buttons disabled, "Sending…") and sent (never
  "confirmed");
- refused, uncertain, interrupted and lost, each with exactly one POST and no
  retry;
- per-visitor cooldown and the separate hello cooldown label;
- busy/unsafe and disabled explanations;
- 390-pixel layout: no horizontal scroll, buttons inside the viewport, 44 px
  tall.

Zero console errors.

Not established:
- **Keyboard activation:** synthetic BiDi Enter/Space reached the focused
  button, but headless Firefox fired no native activation. Tab order and native
  `<button>` elements are verified.
- No real phone, Safari or screen reader was used.

## 2. Usability constraint

Even an otherwise idle Bob is refused whenever any enderman is loaded (by
design, after the 2026-10-20 review), and the autonomous loop keeps him busy
almost continuously. Expect gestures to be available rarely or never in the
current world. Decide whether gestures are worth offering on that basis. Do not
work around it by weakening the threat policy or suppressing autonomy.

## 3. Deltas, hashes, budget, services

| Item | Delta | Service affected | Restart |
|---|---|---|---|
| Bot runtime | `bot_runtime_delta` files in the [manifest](investigations/public-gestures-2026-10-29-manifest.json) (controller, safety, admission wiring, `index.ts`, interactions, viewer shell, `src/observer/*`); scripts `gesture-trial.ts` and `gesture-observer-qualify.ts`. No dependency, lock (`45dfeaa9…`), DB schema or config change | user `blockhead.service` | bot only |
| Observer | new `/home/corey/mc-server/observer/gesture-observer.jar` (SHA-256 `23ebd5166c7e99ed3a9db1f2a0fa4c280257633dd56685941939c49641503419`, reproducible); one `-javaagent` argument in `~/mc-server/start.sh`; socket directory `/home/corey/.local/state/blockhead-observer` (0700, created by the agent; `~/.local/state` is already 0700) | user `minecraft-server.service` | **Minecraft restart** |
| Config | none. `actions_enabled: false` stays the startup default; trial enablement is runtime-only through the authenticated private control | — | — |

Proposed `start.sh` line (only change):

```sh
exec ./java/bin/java -Xms1G -Xmx4G -XX:+UseG1GC -javaagent:/home/corey/mc-server/observer/gesture-observer.jar=socket=/home/corey/.local/state/blockhead-observer/o.sock,player=CobbleBob -jar server.jar --nogui
```

**Resource budget.**

Disarmed (always loaded):
- one volatile read per hooked call, plus a tick counter;
- no threads except one blocked `accept`;
- no disk, network port or memory growth.

Armed (≤ 300 s, one client):
- ≤ 8,192 queued lines (≈ 2 MB worst case);
- one writer and one reader thread;
- measured ≈ 118 µs per tick plus inbound call locally.

Stop the trial if any of these occur:
- Maia tick intervals exceed 55 ms on average during a capture;
- the observer reports drops or faults;
- `minecraft-server.service` logs any `blockhead gesture observer` error.

Not yet measured on Maia's live load.

**Startup:** server start installs the hooks lazily as classes load. `STATUS`
shows `complete: true` only after CobbleBob has joined, because some target
classes load then. **Teardown:** disarm (client close) stops collection;
`UNHOOK` removes every hook without a restart; removing the start-script
argument plus one restart unloads the agent entirely.

## 4. Staged trial (prepared; nothing below has been run on Maia)

- **Stage 0 — eligibility (read-only, no change).**
  - Sample `GET /public-interactions` admission on Maia (as in the production
    evidence) for several hours across normal activity.
  - Proceed only if eligible moments occur at a usable rate. Otherwise stop
    here and report.
- **Stage 1 — deploy bot runtime (needs authorization A).**
  - Follow the existing staged rollout in the
    [deployment receipt](public-viewer-deployment.md):
    1. stop only the bot at a safe boundary;
    2. take a SQLite `.backup` with `PRAGMA integrity_check`;
    3. archive the current runtime;
    4. sync the committed candidate; `npm ci` only if the lock changed (it
       did not);
    5. run typecheck and tests in the runtime;
    6. start the bot once.
  - Verify the remaining checks:
    - `GET /public-interactions` shows `configuredActions: false`,
      `gesture.dispatches` and `configuredQuestions`;
    - unauthenticated requests are refused;
    - no restart loop.
  - Actions stay off.
- **Stage 2 — install the observer (needs authorization B, a Minecraft
  restart).**
  1. At a safe boundary, stop `blockhead.service`.
  2. `systemctl --user stop minecraft-server` (saves the world), then back up
     the world (§6).
  3. Install the jar, verify its hash, and edit `start.sh`.
  4. `systemctl --user start minecraft-server`; check `logs/latest.log` for
     `Done` and no observer error.
  5. Start the bot.
  6. From the runtime:
     `tsx scripts/gesture-trial.ts --observer-socket /home/corey/.local/state/blockhead-observer/o.sock --origin https://maia.tailceb694.ts.net --out <0600 report> --dry-run`.
     The report must show `ready: true`: supported, complete, 22 installed
     hooks, ≥ 80 ticks in a 5-second capture with Bob present, zero invalid
     lines, actions still off and no quarantine. The trial itself re-checks
     ≥ 40 ticks in 3 s before enabling.
- **Stage 3 — supervised window (needs authorization C).**
  - Same command with `--authorized-window --window-seconds 600`.
  - The runner:
    - re-checks observer health and a baseline with actions **off**;
    - enables actions (questions keep their current setting);
    - for each gesture, waits (bounded) until **every** admission gate passes in
      the same session and no cooldown applies;
    - sends exactly one public POST to the loopback public shell with the
      allowed Origin;
    - evaluates the independent records.
  - Any outcome other than `pass` stops the trial, with no retry:
    - a lost, not-sent or uncertain response;
    - another visitor's dispatch;
    - quarantine;
    - an expired window or an abort.
  - In every case the runner disables actions and verifies
    `configuredActions: false`.
  - An expired window ends with actions off. A supervisor watches the viewer
    and the server console throughout and keeps the emergency disable ready.

## 5. Stop conditions and emergency disable

Stop and disable on:
- any non-pass evaluation;
- threats or stale telemetry (gates fail);
- observer drop, fault, invalid line, unhook or coverage loss;
- unexpected packets or effects;
- owner activity (it preempts; `unknown`);
- uncertain or interrupted dispatch;
- quarantine;
- HTTP or service errors;
- tick-interval regression;
- the supervisor's judgement.

The runner handles SIGINT/SIGTERM by disabling. Manual emergency disable, on
Maia (private, authenticated, loopback):

```sh
set -a; . ~/.config/blockhead/operator.env; set +a
printf '{"questions_enabled":true,"actions_enabled":false}' | python3 ~/.local/share/blockhead-runtime/scripts/operator-request.py public-interactions
python3 ~/.local/share/blockhead-runtime/scripts/operator-request.py public-interactions --get
```

For an ownership or boundary incident, also stop `blockhead.service`.

An effect already handed to the client cannot be undone. The private log
records it as `dispatch: "interrupted"` or `"uncertain"`, never as cancelled.
An uncertain dispatch quarantines gestures until a reviewed bot restart.

## 6. Backups and rollback

Before Stage 1, the bot runtime: a SQLite online backup plus
`PRAGMA integrity_check`, an archive of the current runtime, and the effective
unit and drop-ins, all recorded with SHA-256. Use a new owner-only directory
under `/home/corey/.local/share/blockhead-backups/` (the prior procedure).

Before Stage 2, the world, after `systemctl --user stop minecraft-server` has
saved and exited:

```sh
cd ~/mc-server && ts=$(date -u +%Y%m%dT%H%M%SZ) && mkdir -p backups/observer-$ts
cp -a start.sh backups/observer-$ts/start.sh
tar -C ~/mc-server -czf backups/observer-$ts/cobblebob-fresh-20261021.tgz cobblebob-fresh-20261021
sha256sum backups/observer-$ts/* > backups/observer-$ts/SHA256SUMS
```

Rollback commands:
- **Actions:** the emergency disable above.
- **Observer, no restart:** `printf 'UNHOOK\n' | socat - UNIX-CONNECT:/home/corey/.local/state/blockhead-observer/o.sock`
  (socat is installed on Maia; nc is not). This restores the original bytecode;
  the agent stays loaded but inert.
- **Observer, full removal:** at a safe boundary stop the bot and
  `minecraft-server`, then `cp ~/mc-server/backups/observer-<ts>/start.sh ~/mc-server/start.sh`,
  then start `minecraft-server` and then the bot. Leave the jar file in place
  or delete it; it is not loaded without the argument.
- **Bot runtime:** the captured archive and procedure from Stage 1 (as in the
  [deployment receipt](public-viewer-deployment.md)).

Preserve current world and database progress. Never restore an older save or
database to undo a feature deployment. The world archive is for a separately
demonstrated corruption only.

## 7. Criteria for any later persistent enablement

A once-only trial does not authorize leaving actions on. Startup stays
`actions_enabled: false` unless a separate explicit authorization covers
persistent availability and its monitoring. Prerequisites:
- every gesture passed in at least one supervised trial, with no `fail`, and any
  `unknown` explained;
- a demonstrated usable rate of eligible windows;
- the open launch gates closed: offline owner identity, owner-only ACLs,
  forwarding trust, log retention and a restore rehearsal;
- monitoring of dispatch counters, quarantine, admission refusals, observer or
  server tick health, and Bob's task responsiveness, with alert thresholds;
- a decision on whether the observer stays installed (periodic armed sampling)
  or is removed. Without independent observation, persistent gestures remain
  dispatch-only and must be described that way to visitors.

## Superseded conclusions

- [Independent effect observation](investigations/public-actions-2026-10-20-independent-observation.md)
  was a design-only contract. It is now implemented and locally qualified here.
  Its rules still apply, and nothing has been installed on Maia.
- The `PublicProtocolObservations` client diagnostics remain private and
  non-authoritative (`canProveCalm: false`, `effectAcceptance:
  not_established`). They are not the qualified observer.
- In the [launch assessment](public-viewer-launch-readiness.md), "gestures remain
  disabled" still holds. The "Delivery could not be confirmed" wording now
  distinguishes not-sent, sent-but-interrupted and uncertain outcomes.

## Authorization items

Not requested to be run now; each needs an explicit approval naming it:

- **A.** Commit and deploy the bot-runtime candidate to Maia's
  `blockhead.service` (one bot stop/start). Actions stay off.
- **B.** Install observer jar `23ebd516…`, add the `-javaagent` argument to
  `~/mc-server/start.sh`, back up the world, and restart `minecraft-server`
  once.
- **C.** One supervised `--authorized-window` trial of up to 10 minutes after
  A, B and a successful dry run, with each gesture at most once and actions off
  afterward.

Recommended next step needing no new authorization: Stage 0, a longer read-only
eligibility sample. If eligible windows remain absent, there is no reason to
request A–C for gestures.
