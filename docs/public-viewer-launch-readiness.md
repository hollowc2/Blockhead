# Public viewer launch readiness — 2026-10-29

**Model Q&A follow-up:** the firewall-enforcement, retention and cancellation
gates for model answers are addressed (locally and on an isolated stack, not
live) in [public-model-answer-enablement.md](public-model-answer-enablement.md).

**Deployment update:** the user subsequently authorized commit, push and deploy.
Maia now runs `87ec52c` with the security repairs, viewer improvements and a
populated-world startup correction. Public Q&A is rules-based; model answers
and gestures are disabled. See the [deployment receipt](public-viewer-deployment.md)
for current live evidence and rollback instructions. The assessment below records
the earlier local validation; its statements about unobserved deployment state
are superseded by that receipt. The remaining launch gates still apply.

**Recommendation: not ready for a new public launch until the deployment checks
below are evidenced.** The local candidate implements the verified security
repairs and viewer improvements and passes isolated validation. This is not a
claim that the deployed service is patched. Edge routing/address trust,
owner-only private access, offline Minecraft impersonation protection, actual
model-firewall identity, secure operator-secret migration, log retention and
backup restoration remain unverified. Gestures must remain disabled.

Once those gates pass, start with observation only, then basic status Q&A.
Model-backed Q&A requires its additional firewall/cancellation checks; gestures
require a separately authorized, independently verified safety trial.

## Scope, identity and evidence

Work followed prompts 01 → 02 → 03 in order. Only local source, isolated fake
bots, mock inference, temporary listeners and a fresh headless Firefox profile
were used. No `src/index.ts`, live Minecraft connection, remote service change,
Funnel/firewall change, secret installation or live gesture invocation occurred.
The checked-in interaction flags were not changed.

Source base: `a4b1b054ebcda279b8b29721e1b6d4cadb6a5586` plus this working-tree
candidate. The base revision is known source history, **not verified live runtime
identity**. Dependency lock SHA-256:
`45dfeaa92099ad161bf4677bed453c4957b1b9b82858c1e3a8aa39ebeafe5db9`. The exact lock identity and per-file before/candidate hashes are in
[candidate manifest](investigations/public-viewer-local/candidate.json). Checks
used Node v26.11.1. The application now declares Node >=20.3 for AbortSignal.any;
verify the actual target Node/native dependency support before installation.

Supporting evidence:

- [Security implementation, dependency analysis and operator migration](public-viewer-security.md).
- [Viewer behavior, tests, browser checks and limitations](public-viewer-experience.md).
- [Measured bounded workload](investigations/public-viewer-local/load.json), reproduced with
  `npm run validate:public -- /tmp/blockhead-load.json`.
- [Browser assertions](investigations/public-viewer-local/browser.json) and
  [current production dependency findings](investigations/public-viewer-local/dependencies.json).

## Threat model and boundaries

```text
Untrusted browser
  → Tailscale Funnel / trusted loopback proxy (deployment identity unverified)
  → public shell, loopback :3003
      → allowlisted static renderer + Engine.IO → loopback raw viewer :3002
          → projected geometry/events from the fake/real bot world
      → cached allowlisted public state
      → optional public question → bounded priority queue → configured firewall
                                                    → shared inference backend
      → optional gesture → deterministic admission + world-action ownership

Trusted owner devices → private shell :3001 (commands, jobs, previews, map)
                      → private dashboard :3000 (snapshots and diagnostics)
Local CLI + bearer → loopback status :8155 (/command, /public-interactions)

Bot → Minecraft server (offline authentication / configured owner player name)
Bot → SQLite state + application logs; Minecraft → persistent world files
```

Only the redacted shell may be public. Raw viewer, private owner shell/dashboard,
status/operator, inference and firewall administration interfaces must remain
inaccessible to public browsers. A tailnet device is not automatically an owner.
Private browser owner controls still rely on the private listener/network access
policy; the new CLI bearer is not private-browser authentication. An arbitrary
loopback process has more authority than a public browser: it can reach private
services and may access the bot's files. Do not run untrusted code under that
service identity.

Model answers have no tools and receive only `publicFacts()`, not owner chat,
tasks, coordinates, inventory NBT or model decision context. Model moderation
and prompting cannot guarantee harmless prose. A distinct base-URL string
prevents one simple misconfiguration; it does not prove a firewall exists or
that aliases cannot bypass it. HTTP abort is not proof of backend GPU cancellation.

## Findings by severity

### High — deployment trust boundaries remain unverified (launch gates)

There is no current remote observation in this assessment. Source fixes are
locally proven; these are deployment uncertainties, not confirmed live exploits:

- **Edge and identity:** `http-guard.ts` trusts only the rightmost forwarding
  address from the loopback peer. `viewer-shell.ts` strips caller identity and
  owner headers and authors an internal viewer address. `prismarine-adapter.ts`
  binds public/raw listeners to loopback. Obtain current Funnel serve config,
  listener bindings and proxy header behavior; verify that malformed paths and
  upgrades remain rejected at the edge without trusting supplied headers.
  A proxy that forwards an attacker-controlled last X-Forwarded-For would
  invalidate per-address controls, although global/public caps still apply.
- **Private owner access:** confirm device/user ACLs for ports 3000/3001 and all
  other owner interfaces. Public routes deny commands, maps, jobs, previews,
  private snapshots and diagnostics even when given credentials/forwarded
  headers. This does not establish owner-only tailnet access in deployment.
- **Minecraft owner impersonation:** source uses offline authentication and a
  configured owner name. Obtain actual `server.properties`, bind/firewall/
  ingress and authentication/allowlist evidence. A player-name allowlist alone
  cannot stop offline owner-name impersonation. Isolate ingress or provide
  authenticated identity before treating owner chat as a secure boundary.
- **Model firewall:** prove the configured public endpoint and aliases reach
  the firewall, not the direct backend. Only then authorize a benign model Q&A
  observation and a cancellation trace. Firewall failure must remain refusal/
  basic status fallback with no direct-model retry. Until then keep model Q&A
  disabled in the staged configuration.

### High — original local defects repaired in the candidate

These are reproduced local failures from the implementation prompts, now
covered by regression evidence, not observations of the current deployment:

- Malformed upgrade/HTTP targets: strict origin-form parsing and local promise
  boundaries in shell/raw/dashboard; isolated child-process tests send invalid
  URL forms, retain process health and show no upstream requests afterward.
- Pending polling bypass/private-seat exhaustion: reservations span Engine.IO
  handshake through session close, namespace attachment rechecks ownership,
  upgrades count once, pending joins expire, and address/global/public caps
  apply across transports. Global saturation uses distinct simulated addresses.
- Unauthenticated operator mutation/browser-origin requests: `status/server.ts`
  requires loopback binding plus a bearer secret, rejects Origin/Fetch Metadata,
  authenticates before reading and bounds body/time. Missing secrets fail closed.
  Private diagnostics require authentication too; health/status remain read-only.
- Public chunk block-entity metadata: real installed serializer reconstruction
  drops NBT and unknown fields, fails closed on unsupported shapes and preserves
  geometry/lights/biomes. Public events are allowlisted. Synthetic sign/custom
  field/coordinate canaries are absent on public wire and retained privately.
- Abandoned model work: signals/deadlines reach queue/discovery/retries/fetch.
  Queued expiry/abort never starts inference; active cancellation aborts transport
  and serialization remains held until settlement. Owner/autonomous work has
  priority, with a public fairness turn after three private jobs. Queue capacity
  and outstanding work stay bounded and visible privately. Firewall routing is
  unchanged. See `client.test.ts`, `request-queue.test.ts`, public-model tests and
  the HTTP-abandonment workload.

### Moderate — upstream UUID advisory remains under explicit handling policy

Audit now reports 12 moderate affected packages, zero high/critical, all inherited
from one UUID advisory. Compatible body-parser/qs patches and a tested Zod 4.6.7
migration removed both original high advisories. The remaining paths are
Minecraft protocol → Microsoft auth/MSAL → uuid 8.3.2 and Yggdrasil → uuid 10.0.0,
plus dependent Mineflayer plugins. The advisory requires v3/v5/v6 calls with
caller-provided output buffers/offsets; public routes provide no such surface,
Yggdrasil uses v4, and the configured offline path does not invoke online auth.
No public reachability was identified. Do not downgrade Mineflayer or force an
untested UUID major override. Upgrade compatible upstream auth dependencies with
auth-flow tests; re-review before launch and by 2026-11-29. The audit script
prints this exact exception and rejects new root advisories or unavailable audits.
Full package paths and advisory links are in the dependency evidence and security
note; an audit exception is not a proof about every possible future call site.

### Moderate — logs and backup/restore evidence incomplete

`src/logger.ts` appends to `logs/blockhead.log`; there is no in-process size
rotation. The checked-in journald retention file is only a proposal, with no
installation evidence. Public interaction records contain fixed outcomes,
generated request IDs and durations, not questions/answers/IPs. Proxy failure
logs now omit query strings. Before launch prove restricted log permissions and
bounded file/journal retention; configure rotation/reopening appropriate to the
append stream and verify it in a maintenance window. Do not install collectors
or restart journald as part of this local task.

No current world backup or SQLite restore was read or exercised here. Prepare
and test an isolated restoration of **both** before launch. A synthetic unit test
or an application rollback archive is not a tested production-data restore.

### Low / validation limitations

The fake world is flat, shared and stationary. Its workload cannot establish
production frame rate, long-run leak slope, real terrain serialization cost,
network throughput or GPU/model capacity. There was no real mobile device,
Safari, touch gesture or screen-reader validation; reduced-motion rules exist
but the browser preference was not emulated. Those remain acceptance follow-ups.

## Local verification results

Security step: 991 tests passed. Viewer step: 997 passed. Final combined suite:
**1004 tests passed, zero failed**. `npm run typecheck`, focused public/model/
transport tests and `git diff --check` pass. `npm audit --omit=dev --json` exits
1 because of the documented remaining advisories; `npm run audit:production`
passes only under its explicit handling policy. The audit was rerun for this
assessment; it is not the dated 15-package baseline.

A clean isolated `npm ci` including native scripts/postinstall passed. Running
the patch twice is idempotent; clean/workspace renderer bundle hashes match.
Firefox Enter-key submission, refusal/busy states, operator disable during a
pending request and API/offline recovery also passed. Firefox rendered actual
sanitized fake-world geometry through the public shell,
with desktop and 390-pixel layouts visually inspected. Lightweight had no frame
session; eight-turn history, clear, inert HTML, keyboard form/focus and draft
retention passed. With storage disabled and WebGL blocked, graphics failed
honestly while status stayed online. The public shell survives offline startup and bot-session replacement.
Capacity/retry, offline/unavailable,
background grace, stale-frame rejection, cooldown and uncertain-delivery behavior
have controllable transport/timer/server tests. No live gesture effect is claimed.

The final bounded shell → raw viewer → fake bot workload took **2.608 seconds**:
12 simultaneous public WebSocket clients admitted six/refused six; four private
clients still connected. Three rounds of six polling/upgrading clients (18
reconnects, no automatic retries) returned seats and move/inventory listener
counts to zero each time. Total admitted: 28. At full capacity each viewer event
had exactly **one upstream bot listener** through the shared subscription hub;
shutdown removed all of them. The initial local load exposed listener warnings;
those were fixed by sharing subscriptions, not increasing capacity/listener limits.

Twenty API reads at roughly 100-ms spacing had maximum **29.02 ms**, p95
**5.54 ms**. Event-loop p99 **17.58 ms**, maximum **22.54 ms**. RSS was
126.14 MiB before, peak sampled 162.85 MiB, 162.85 MiB after (sampling can miss
the final allocation). No leak slope is claimed. Peak observed pending outbound
bytes **25,516**, peak chunk jobs **9** of the 128-job bound, no slow-consumer
disconnects in this fast-client scenario. The separate abandoned-polling test
forces slow-consumer disconnection and verifies cleanup. Largest public chunk
packet was **12,743 bytes**, with 112 observed packets and no metadata canary.

A held fake private inference admitted one queued public question and one queued
owner request (peak queued two/running one). Abandoning the question removed it;
zero abandoned public inference calls started and queue depths returned to zero.
Thresholds were API maximum <1000 ms, event-loop p99 <250 ms and cleanup <1000 ms.
All passed. Raw JSON records the workload and limitations; these are deliberately
small local acceptance bounds, not a production capacity promise.

## Deployment preparation — not executed

Use the current Maia layout from [deployment-maia.md](deployment-maia.md): source
`/mnt/Repos/Games/Blockhead`, runtime
`/home/corey/.local/share/blockhead-runtime`, **user** `blockhead.service` with
`runtime.conf`, and source working directory for config/SQLite/logs. Do not use
obsolete `/srv/blockhead`, a system service or a second process from the checkout.

1. **Before requesting rollout authorization**, capture current read-only service
   unit/drop-ins, runtime/source hashes, Node version, listener/Funnel routes,
   tailnet owner ACLs, Minecraft auth/ingress, firewall identity, feature flags,
   log retention and backup restore receipts. Compare the actual runtime against
   the candidate manifest; resolve drift. Stop here on unknown identity, an
   unsafe owner boundary or missing recovery evidence.
2. Archive the actual runtime code/dependencies, effective user unit/drop-ins and
   protected configuration to a new owner-only release backup directory under
   `/home/corey/.local/share/blockhead-backups/`. Record SHA-256 hashes. This is
   the operational rollback target; do not assume the source base equals it.
   Capture `config/minecraft.yaml` privately, without committing its contents.
3. Prepare a closed initial configuration: `dashboard.public_viewer.enabled:
   false`, interaction questions/actions false and model_questions false. The
   subsequent observation stage enables only public_viewer, retaining its six
   seats and four private reserved seats. **These are proposed target config
   changes; the shared checked-in YAML was not edited by this task.**
4. Generate/install a random operator secret (prefer 32 random bytes encoded as
   hex) in `~/.config/blockhead/operator.env`, owner-only 0600, outside Git and
   rsync. Install [proposed operator drop-in](../deploy/blockhead-operator.conf.proposed)
   as `~/.config/systemd/user/blockhead.service.d/operator.conf`, preserving
   runtime.conf. Never put the secret in command arguments, URLs/assets or logs.
   Migrate CLI callers to `scripts/operator-request.py`; migrate the observability
   preflight to an authenticated private GET. Verify the secret file owner/mode
   without printing its content. No unauthenticated compatibility mode exists.
5. At an approved safe task boundary, stop **only the user bot service**; the
   existing shutdown pauses resumable work. Take a consistent SQLite `.backup`
   using SQLite's online backup API (or a stopped-service copy including WAL
   handling), run `PRAGMA integrity_check` on the backup, and record its digest.
   Existing validated world backups must already satisfy the restore gate. If
   they do not, obtain a separate Minecraft backup/maintenance authorization;
   do not silently restart Minecraft for an application rollout.
6. Sync candidate runtime files and install with the locked `npm ci`/postinstall.
   Runtime deltas are precisely those under `src/`, `scripts/`, package.json and
   package-lock.json in the candidate manifest, including **new** request-queue,
   viewer-session and lifecycle files. Docs/tests may be included in the normal
   full-runtime sync. Exclude `.git`, data, logs and protected secret locations.
   Run typecheck, tests, audit policy and patch checks in the prepared runtime;
   never start a second bot to smoke test it. Existing `scripts/deploy-maia` is a
   convenience updater, **not** this staged rollout: do not invoke it before the
   secret/config/backup/closed-listener steps and approval are complete.
7. Under that same rollout authorization, reload the **user** systemd manager
   and start `blockhead.service` once. Do not restart Minecraft, llama.cpp or
   journald. Check unit identity/hash, normal shutdown/start logs, no restart
   loop, bot connection, owner private views, `/health`, bad/missing bearer
   refusal and a valid bearer **GET** `/public-interactions`. Do not use `/command`
   as a validation probe or enable gestures. Stop on any unexpected effect.

## Rollback and progress preservation

Known source fallback: base revision
`a4b1b054ebcda279b8b29721e1b6d4cadb6a5586`; manifest records its file digests.
The approved deployment must additionally name its **actual** pre-change runtime
archive/config hashes from step 2. Roll back to that captured archive if it
differs; source history alone is insufficient operational rollback identity.

1. If the candidate responds, use the authenticated loopback interaction control
   to set both booleans false (JSON on stdin to the operator CLI). Disable the
   public listener in the private configuration and stop the user bot service
   at a safe boundary; urgent unintended world actions justify an immediate stop.
2. Restore only application runtime/dependencies and the matching captured unit/
   configuration, keeping public_viewer/questions/actions/model questions off.
   Older code reintroduces the repaired gaps: **do not republish it**. Preserve
   loopback/network isolation and the protected secret even if older code ignores
   it. Any emergency Funnel change requires the separately approved network action.
3. Keep current SQLite and Minecraft world progress. Do **not** restore an older
   DB/world merely to revert application code; this candidate adds no DB schema
   migration. If data corruption is separately demonstrated, use its own approved
   recovery procedure and validated paired backups.
4. Reload/start only the user bot service once, verify hashes/task resumption,
   private status and public listener denial. Keep the failed candidate logs/
   fixed-outcome evidence without retaining raw questions unnecessarily.

A full disaster-recovery rehearsal must separately restore a consistent SQLite
backup and world backup into **isolated locations**, check integrity and expected
state, then start only disposable services with ports/network/model/action
access isolated from production. Read the actual Minecraft `level-name` and save
layout at preflight; do not guess a world directory from an old runbook. If a
validated save-freeze/filesystem-snapshot method is unavailable, arrange a
separately authorized stopped-server world backup. Record save/checkpoint method,
backup IDs, digests, restore commands, integrity/state results and restoration
time. No such live-data restore has been performed by this task.

## Stages, monitoring and stop conditions

- **Private candidate validation:** entry requires reviewed candidate, hashes,
  operator migration, closed public configuration and recovery evidence. Exit
  requires one healthy bot, owner-only private access, passing local checks and
  successful authenticated diagnostics/unauthenticated denial.
- **Observation only:** after separate deployment/network approval, expose only
  the redacted shell; Q&A/model/gestures remain off. Keep the public cap at six
  and private reserve four. Observe at least one hour including normal bot
  movement and a small allowed audience; check new/reconnecting/full visitor
  flows, actual API latency, memory/buffers/queues and cleanup. Never claim the
  2.5-second flat-world workload sizes a live world.
- **Basic status Q&A:** enable only rules questions via protected configuration/
  approved private control. Verify origin policy, bounded waits, cooldowns,
  text-only results, no private fields and owner responsiveness. Exit after a
  stable observation window and a reviewed receipt; no automatic promotion.
- **Model Q&A:** requires firewall route/alias identity and cancellation evidence,
  plus an approved benign trial. Verify owner priority, queue depth and failed/
  cancelled classification without recording raw visitor messages. Keep gestures
  off. If backend compute does not stop on HTTP abort, assess the bounded single
  outstanding job against real latency before proceeding.
- **Gestures:** remain disabled. This assessment does not approve a live effect
  trial. Any later trial requires existing deterministic admission, threat,
  freshness, cancellation, quarantine and independent-effect verification rules.

Monitor private fixed counters and model queued/running/public depths, public
admission refusals, pending sessions, chunk jobs/buffers, event-loop/API latency,
RSS trend, bot listener counts, task responsiveness and restart/error logs. Use
existing diagnostics/logs; do not install a collector as part of this approval.
Set target thresholds from real observation; initially stop for sustained API
latency >1 second, owner starvation beyond the active bounded inference, any
cap/reserve violation, unexplained memory/buffer/listener growth, crashes/restart
loops, operator/public boundary failure, private metadata on public wire or any
unconfirmed/unintended physical effect. Privately disable questions/actions first;
stop the bot and close the public listener for an ownership/boundary incident.

## Unresolved live checks and authorization

Current remote observations: **none**. Historical reports in the repository
were read as context and were not promoted to current evidence.

The next useful action is a read-only Maia preflight: effective unit/runtime and
config hashes; listeners/Funnel route/edge semantics; forwarded-address behavior;
owner device ACLs; Minecraft bind/auth/ingress; firewall/admin identity; Node and
native dependency support; secret-file readiness; log retention; and paired
backup/isolated-restore receipts. Read-only observations do not authorize changes
or public attack probes. Follow the server-management skill if doing that later.

Installing the secret/drop-in, editing live YAML, syncing/restarting the bot,
changing Funnel/firewalls, any Minecraft maintenance, restore rehearsal involving
running services, and live Q&A/gesture trials require their corresponding
explicit authorization. This local implementation/validation task is complete;
no deployment or launch approval is inferred.
