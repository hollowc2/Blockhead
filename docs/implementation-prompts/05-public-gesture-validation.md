# Qualify public gestures and prepare a controlled enablement

You are working in Blockhead. Complete the implementation and independent
validation needed to qualify its four existing public gestures: `hello`, `wave`,
`look_left`, and `look_right`. Deliver a tested candidate and a concrete supervised
trial/rollback package. Do not stop at restating the existing safety plan, and do
not enable actions merely because HTTP tests pass.

## Scope and authorization

This prompt authorizes local implementation, isolated fake-bot/server fixtures,
temporary test databases/listeners, bounded tests and preparation of deployment
and trial artifacts. Available authorized read-only observations may establish
the current deployment baseline. It does not itself authorize public enablement,
live gesture invocation, production game commands, a second player/bot,
instrumentation installation/JVM attachment, Minecraft restart, service changes
or network changes. Use explicit authorization already covering a named action;
do not ask for the same approval again. Finish the concrete local candidate and
evidence before asking for any missing live authorization.

Read applicable repository/server instructions, inspect current changes and
preserve unrelated work. The shared `config/minecraft.yaml` is Maia's live
configuration; do not edit its flags during local qualification. Do not start
`src/index.ts`, connect test clients to production Minecraft, expose diagnostic
ports, or change Funnel/Tailscale/firewalls. Keep model answers in their current
approved state; Aegis work is a separate prompt. Run these prompts sequentially
where they touch shared files.

## 1. Reconstruct the evidence and implementation

Read:

- `docs/public-viewer-deployment.md`, its receipt, and
  `docs/public-viewer-launch-readiness.md`.
- `docs/public-interactions-plan-2026-10-19.md`; its older flags, model-queue
  assumptions and deployment claims may be superseded by later code/receipts.
- `docs/investigations/public-actions-2026-10-20-independent-observation.md`.
- The related observability-capabilities and enderman-review JSON files in
  `docs/investigations/`, plus later receipts relevant to the current runtime.
- `src/agent/public-actions.ts`, `public-action-admission.ts`,
  `public-action-safety.ts`, `public-protocol-observations.ts`, world-action
  ownership/scheduler/dispatcher code, `src/index.ts`, public HTTP/UI handling
  and all associated tests.

At the October 29 rollout, actions remained disabled and no live gesture had
independent effect acceptance established by that rollout. The existing protocol
observations are private diagnostics, not a qualified independent observer.
`canProveCalm: false`, `outgoingAttackOrUse: not_observed` and
`effectAcceptance: not_established` are deliberate limitations, not successful
acceptance signals. Recheck current source/runtime/version; do not promote old
diagnostic counts into new guarantees.

Identify the actual Minecraft implementation/version/protocol, service and save
layout before designing instrumentation. Previously this was Minecraft 1.21.4 on
Maia, user `minecraft-server.service`, with the bot's isolated runtime at
`/home/corey/.local/share/blockhead-runtime`. Verify bindings/owner access using
authorized read-only evidence. Offline player-name trust, owner-only tailnet ACLs
and ingress isolation remain separate launch gates; an allowlist alone cannot
prove offline owner identity. Record any gate that blocks the proposed trial.

## 2. Preserve the narrow capability surface

Keep exactly these effects and no visitor-supplied arguments:

- `hello`: one fixed Minecraft message, `Hello, everyone!`.
- `wave`: one main/right-arm animation, with no attack or item/block use.
- `look_left`: one forced positive 45-degree yaw change, preserving pitch and
  position, using the installed Mineflayer coordinate conventions.
- `look_right`: one forced negative 45-degree yaw change with the same limits.

No arbitrary message, tool, target, task, movement, inventory/container operation,
terrain edit, repeated look loop or delayed orientation restoration is permitted.
Public requests never enter owner-command delivery or the general tool registry.
Keep strict schemas, Origin/Fetch Metadata checks, authentication boundaries,
rate/capacity/cooldown limits, redacted public state and text-only UI rendering.
Lost/ambiguous responses must not be retried automatically.

## 3. Verify admission, priority and actual primitive settlement

Use the same authoritative synchronous admission checks for execution and private
diagnostics. Unknown/missing state refuses admission. Review, test and repair
gaps in the real wiring, not just a helper returning a chosen boolean:

- Same connected READY bot session, completed bootstrap, no death/recovery loop,
  halted scheduler, active/queued/resumable work, goal/build project, pending
  decision/background work, interrupt, conflicting lease owner or lease waiter.
- Grounded, stationary, dry, awake, unmounted, sufficient health/food, no movement
  controls/path/target, combat, digging/building, eating/item use or open container.
- Fresh server observations and local physics observations; local physics alone
  does not establish server liveness. Death/respawn/disconnect invalidates state.
- Reviewed live threat geometry and visibility. Missing blocks/positions or an
  unreviewed hostile refuse admission. Preserve the loaded-enderman refusal for
  **all four actions**. False/missing creepy/stared-at metadata does not prove
  calm or rule out persistent/pending anger. Do not weaken this gate or filter
  entities to manufacture an eligible window.
- Immediate world-action lease acquisition with no public action queue; recheck
  safety/session/epoch after acquisition and before the fixed effect. Concurrent
  visitors cannot both own the action. Owner/survival work retains priority.

Test interrupts from owner commands, damage, hunger, night, threats, task creation
and activation, disabling actions, HTTP disconnect, death/respawn and shutdown.
Cancellation prevents effects that have not started and stale continuations;
it cannot undo a packet already sent. Describe that boundary honestly.

Keep the current one-second execution budget unless a separately justified
change is needed. An unsettled primitive retains ownership; timeout/uncertainty
quarantines further public actions. A race wrapper resolving is not settlement.
Never clear movement controls, stop an owner task or restore an old pose as
public-action cleanup. Make session/quarantine reset semantics explicit and
prove late work cannot affect a replacement session.

## 4. Implement and qualify independent effect observation

The existing design document is a contract, not an implemented observer. Build
the missing observer and correlation/evaluation tooling in an isolated workspace
against the actual supported server/protocol. If the installed server offers no
appropriate safe hook, identify the required version-specific server change,
implement/test it locally where possible, and prepare its exact deployment and
overhead review. Do not silently replace the server, attach to its JVM, install
a plugin or start another player in production.

Use two distinct server-side observation points:

1. Complete decoded inbound packet handling for Bob's connection.
2. Applied game effects/accepted events and relevant broadcasts after handling.

A wrapper around Mineflayer's outbound writes is useful supplementary coverage,
but is not independent server acceptance. Ordinary logs, viewer pixels, HTTP 200,
a resolved `bot.look()` promise, aggregate self-chat totals and pose correction
packets do not substitute for the required effect stream.

Define typed, bounded private records carrying server-run identity, connection/
entity lifecycle, monotonic ticks/sequence, coverage/overflow state and only the
minimum effect data. Start collection before the baseline and correlate a single
once-only HTTP request with a bounded observation interval. Use private request
IDs/timing; do not append identifiers to Minecraft chat or modify the effects.
Define tolerances and correlation rules before seeing trial outcomes.

Acceptance must establish:

- Hello: exactly one fixed chat message accepted as Bob, with independent server
  evidence. A cumulative count cannot identify a particular request.
- Wave: exactly one main-hand swing accepted and its normal tracked-player
  broadcast; zero off-hand swings. Self-animation packets may be omitted by the
  protocol, so zero self echoes is inconclusive.
- Each turn: authoritative before/after pose with the correct signed 45-degree
  yaw change modulo a full turn, unchanged pitch and position, no extra turn.
  Determine quantization tolerance from the installed serializer/sensitivity
  behavior in advance. Exclude correction packets as standalone proof.
- All four: complete packet coverage excludes attack/entity interaction, item
  use, use-on-block and other prohibited mutations. Independently observe actual
  damage/use effects too. Unknown packet types or missing coverage invalidate
  an absence claim.

Use explicit `pass`, `fail`, and `unknown` outcomes. Missing baseline/effect,
duplicate/reordered or dropped records, tick discontinuity, restart/reconnect,
death/respawn, unknown schema, overflow, observer failure or ambiguous overlap
with natural work must never produce a false pass. Do not suppress survival or
owner work to improve correlation; let it preempt and mark the interval unknown.

Bound memory, CPU/tick overhead, capture duration and record retention. Capture
no arbitrary chat, unrelated player history or persistent raw packet dumps. Pose
and lifecycle evidence remains private; public APIs/UI must not expose coordinates,
identity, observer configuration or operator credentials. Collection itself sends
no game commands/packets and causes no world mutation. Teardown removes all hooks.

Qualify the collector/evaluator with controlled missing/duplicate/reordered data,
overflow, lifecycle resets, yaw wrap/quantization, arm selection, prohibited packet
types and owner/survival overlap. Include traces where HTTP succeeds and the
effect is absent: they must remain unconfirmed. Where feasible, run a disposable
server/world with isolated ports and a disposable test bot to validate the real
installed packet/effect path. Keep production saves/configuration out of it and
disable external model/action integrations.

## 5. Validate the full local path and visitor feedback

Exercise the actual public HTTP handler through controller/admission/lease and
fake or disposable server effects. Cover:

- Each allowed effect once, unknown/extra fields refused, malformed/oversized or
  slow bodies bounded, and public requests unable to reach private controls.
- Every blocked/unknown admission gate individually; checks changing between
  initial assessment, lease acquisition and execution; private priority races.
- Busy, concurrent, rate-limited, disabled, stale-session, disconnected, timed-out
  and quarantined work; primitive rejection and late settlement; cleanup after
  repeated sessions. Prove no persisted/queued visitor actions or listener growth.
- Complete independent effect success/failure/unknown cases and forbidden side
  effects, with uncertainty retained even when transport reports success.
- Desktop/mobile/keyboard feedback for idle, busy, unsafe, cooldown, submitting,
  refusal and uncertain delivery. No automatic retries; separate hello cooldown
  remains accurate. Clearly distinguish request dispatch from independently
  confirmed Minecraft effect. Do not label dispatch success as effect verification.

Run focused suites, `npm run typecheck`, `npm test`, `git diff --check`, and the
current dependency audit policy. Include collector/server tests in their actual
build environment. Record revisions, commands, bounded workloads, timings and
limitations. Do not add a new monitoring stack to avoid testing the existing path.

## 6. Deliver a concrete trial and rollback package

Write `docs/public-gesture-enablement.md`, with sanitized evidence under
`docs/investigations/` and any collector/test tooling in suitable source locations.
Preserve earlier receipts and mark superseded conclusions explicitly. Include:

1. Changes, exact source/lock identities, gate matrix, collector capability and
   tested correlation/tolerance rules. Distinguish implementation tests from
   independent server effects and from actual production observations.
2. A decision: qualified for a bounded supervised trial, or still disabled with
   named gaps. Measure whether normal operation provides safe eligible windows;
   if it does not, report that usability constraint. Do not clear tasks, pause
   autonomy, remove mobs or weaken a gate just to force a successful demo.
3. Exact runtime/unit/configuration/instrumentation deltas, hashes, resource
   budget, startup/teardown steps and all affected services. A Minecraft restart
   or observer install, if necessary, is a distinct named authorization item.
   Identify any remaining owner-authentication/network isolation prerequisite.
4. A staged trial: establish observer health and baseline while actions are off;
   require all gates to pass in the same session; enable only for a bounded
   explicitly authorized window; invoke each gesture at most once under normal
   cooldowns; collect independent effects; disable actions afterward. An unknown
   result stops the trial without a retry. An expired/ineligible window ends
   with actions off, not an endless wait or a fabricated pass.
5. Stop conditions for threats, stale telemetry, missing coverage, unexpected
   packets/effects, owner activity, cancellation uncertainty and service errors.
   Define the private authenticated emergency-disable path and ensure an already
   sent effect is recorded as irreversible rather than falsely canceled.
6. Backups before any authorized live changes, including a consistent SQLite
   snapshot and an appropriate current world backup if server changes require
   it. State exact app/observer/config rollback commands. Preserve current world
   and database progress; never restore older saves to undo a feature deployment.
7. Criteria for any later persistent enablement. A once-only trial is not
   authorization to leave actions on. Keep startup defaults off unless separate
   explicit authorization covers persistent availability and its monitoring.

Finish with links to the implemented candidate and evidence. If live work needs
authorization, request only the exact prepared actions not already authorized.
Until a qualified, authorized trial establishes effects, say gestures remain
disabled and acceptance unverified; local HTTP success is not a launch approval.
