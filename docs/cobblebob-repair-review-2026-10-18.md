# CobbleBob repair review — October 18, 2026

The initial local fixes and read-only Maia investigation were followed by an
approved rollout at **12:33:36 PDT**. Live acceptance exposed a task-identity
and fallback defect; the seven original runtime files were restored at
**12:39:55 PDT**, with baseline hashes verified. Bob reconnected at 20/20
health/hunger. Minecraft and llama were not restarted, cvtrack remains
inactive/disabled, and no manual world or database repair was performed.
The two autonomous log removals were preserved. The corrected eight-file revision
was approved by the subsequent `continue` instruction and installed at
**14:47:49 PDT**. Its runtime hashes still match, with zero automatic restarts.

[Rollout and rollback evidence](investigations/cobblebob-deployment-2026-10-18.json).
Existing uncommitted October 15 repairs were preserved. Three agents owned
movement, development, and building respectively; the coordinator checked
integration, Maia evidence and validation.

## Findings and fixes

1. **False precise arrival:** installed pathfinder `GoalNear` floors goal
   coordinates. Its successful empty path does not imply exact fractional
   Euclidean arrival. The observed `(112.5,96.9375,69.5483)` farmland pose
   reproduces that mismatch with range zero. Movement now accepts a scoped
   action-precondition callback, checked before routing and across every
   successful transport exit. Log collection validates actual support/body
   collision, hazards and eye reach, then digs without routing if feasible.
   Supported approach heights use collision geometry; actions requiring
   visibility can require clear access. Dimension is checked independently.
   Infeasible arrival returns its reason rather than repeating empty paths.
   Collection also refreshes target identity after equipment awaits, refusing
   changed/unloaded blocks so a newly placed fixture cannot inherit stale
   natural-terrain clearance.
   Ordinary navigation radii were not widened. Tests retain home-arrival and
   combat handoff coverage and exercise unsafe, occluded, out-of-reach,
   wrong-dimension, creative and long-route exits. Live digging remains pending.

2. **Unproductive plot cycles:** fixed twenty-minute plot cooldowns discarded
   history at expiry; the independent ten-minute per-action watchdog could
   only hold individual plots. Many different failures therefore rotated
   ahead of useful work. Status after reboot showed 23 consecutive failures,
   including field failure counts 105/106/108. Development now persists retry
   history and condition fingerprints in the existing background-failures
   store, with capped exponential backoff. A shared maintenance budget pauses
   repeated zero-change maintenance after three attempts in ten minutes,
   permits other eligible useful work, and waits when none exists. Relevant
   terrain/material changes can release a plot; restart/expiry alone does not
   erase history. Background-manager cleanup now respects development record ownership.
   Foliage/crop lifecycle changes do not reset an unrelated log blocker. No permanent global failure block or scheduler framework was
   added. Urgent/owner task priority remains with the existing scheduler.

3. **Owner room:** historical error was an ambiguous birch log at `(68,99,53)`;
   owner rooms deliberately do not authorize tree clearance. The frozen
   blueprint hash is intact. A fresh saved-region read now shows **air** there,
   and only **70/85** previously completed cells match: twelve missing wall
   cells and three crafting tables. Independent bit decoding and ten chest/
   furnace block-entity cross-checks support this reading. Saved disk blocks
   may lag loaded server chunks. The runner now reconciles the completed
   prefix before new construction, returning `PROJECT_WORLD_CHANGED` on drift
   without rewriting progress. Obstructions identify the operation, dimension,
   expected material and required owner action. Own-build replacement requires
   an earlier operation at that exact cell. Fixture/home protections remain.
   No log removal is currently justified; loaded-block inspection and owner
   decisions on changed walls/fixtures must precede any approved continuation.
   [Room evidence and pending actions](investigations/cobblebob-room-review-2026-10-18.md).

4. **Zero-progress levelling:** fresh samples show real one-block grass-height
   differences, rather than a farmland fractional-height error. Plot `40,24`
   has eighteen grass columns at y95, five at y94 and two preserved cobblestone
   columns; `-40,-48` has twenty-one at y93/four at y92; `-48,-48` has twenty-three
   at y94/two at y93. Modal plans are fill-only, so zero cuts are correct.
   Current inventory and five recent home-chest snapshots contain no dirt or
   cobblestone; the fill hook only withdraws existing dirt. The old runner
   silently stopped without material, then verified an unchanged uneven field.
   It now reports the exact material/cell blocker, verifies actual cut/fill
   mutations, defers unchanged work, and stops an incomplete levelling pass
   before farming. Planner/survey additionally agree that paths are protected,
   farmland uses its block plane and fixture columns retain their supports.
   These are safety fixes, not evidence that paths caused the sampled failures.
   Farming remains limited to the selected plot. Live material supply and
   successful fill remain pending; no new quarrying or whole-village pass was added.
   [Field snapshot](investigations/cobblebob-fields-2026-10-18.json) and
   [durable/chest evidence](investigations/cobblebob-development-state-2026-10-18.json).

5. **Maia outage:** cause remains unknown. Suspend was already disabled.
   Retained evidence has no recorded fault explaining the outage; it cannot
   rule out an abrupt hardware/kernel failure. cvtrack's 61,528 restarts are
   resource-waste evidence, not causal proof; it remains inactive and disabled.
   Existing GPU metrics/exporter are running, but journals are capped at 50 MB
   and watchdog/crash capture are limited. A read-only bounded capture script
   was locally prepared and smoke-tested over SSH. A separate proposed
   journald drop-in increases retention and sync frequency; it is not installed.
   [Host investigation, exact proposal and capture plan](maia-outage-investigation-2026-10-18.md).

## Runtime baseline and validation

All seven October 15 implementation files matched their pre-task source bytes
and deployed hashes. This was verified using the captured initial patch,
HEAD and fresh runtime SHA256 values, rather than comparing against source
after edits. [Initial comparison](investigations/cobblebob-initial-runtime-comparison-2026-10-18.json).
Package manifests/lockfiles also match; no dependency update is required.

Final `npm run typecheck` passed. Final `npm test`: **769 passed, zero failed,
zero skipped/cancelled**, 35,854.581531 ms. `git diff --check` and capture-script
syntax/smoke checks passed. Focused runs: movement/world 54, building/project
55, development/farming/background 96 passing tests (these overlap the full
suite). [Exact validation record](investigations/cobblebob-validation-2026-10-18.json).

All seven tested candidate hashes and final live baseline checks are in the
[repair manifest](investigations/cobblebob-repair-manifest-2026-10-18.json);
[deployment plan](cobblebob-deployment-plan-2026-10-18.md) contains the precise
file list, preflight, backup, rollback and live acceptance commands. Tests exercise mocked world mutations
and the installed pathfinder semantics; they do not prove live construction,
combat behavior or host stability. Required live acceptance is deliberately
pending approval, including genuine block changes and reduced retry frequency.

## Approved rollout and failed scheduling acceptance

The candidate ran from 12:33:36–12:39:55 PDT. Twelve candidate observation
samples retained full health/hunger and zero automatic restarts. Two cleanup
passes verified one log removal each; saved block `(114,101,71)` is now air.
The next task carried identity `tidy:48,32` but ran plot `32,48` after returning
home. Its zero-progress result therefore charged the wrong watchdog key.
Background selection then reused the held head candidate instead of selecting
an alternative. One blocked task was deduplicated, so repeated digging did
not occur, but this fails the intended identity/fallback contract. The
15-minute acceptance window was stopped early and code rolled back, preserving
SQLite/world progress. This is a concrete integration gap beyond the original
769-test candidate, not successful completion of all live acceptance checks.

## Revised candidate after live finding

Development now carries the queued kind/plot through the dispatcher and
selects only that identity after returning home. An obsolete or unidentified
background plan cancels before plot mutations, without recording watchdog
success/failure; the next pass creates fresh work. Candidate selection skips
restore-cooling and generic-watchdog-held work inside the existing survey
lists, selecting another eligible candidate or waiting. Distant surveys use
a separate go_home identity, which also respects its watchdog block.

The revision adds `src/agent/task-dispatcher.ts` to the original seven files.
Regression tests reproduce changed eligibility after home travel, verify no
unplanned plot mutation, preserve watchdog history on cancellation, exercise
blocked-head alternatives/waiting, and prevent blocked home-survey enqueueing.
Final revised validation: **774 passed, zero failed/skipped/cancelled**,
34,210.51811 ms; `npm run typecheck` and `git diff --check` passed. The focused
development/dispatcher/background run passed 103 tests. All eight candidate
hashes and all eight original live baseline hashes were verified.

[Revised validation](investigations/cobblebob-validation-2026-10-18-v2.json),
[revised manifest](investigations/cobblebob-repair-manifest-2026-10-18-v2.json),
and [revised deployment/rollback/acceptance plan](cobblebob-deployment-plan-2026-10-18-v2.md).
The revised candidate was subsequently approved via `continue` and deployed.
Host settings and manual room/world reconciliation remain separate.

## Revised rollout result

The eight-file revision is installed, with rollback code and a consistent
SQLite backup at `/home/corey/.local/share/blockhead-backups/repair-20261018-v2`.
All eight installed hashes match. Minecraft/llama retained their original
invocations; cvtrack remains inactive/disabled. No host settings or manual
world/database repairs were applied.

The initial 31-sample observation spans 917.203 seconds at 20/20 health and
18/20 hunger; retained cooldowns meant no new tasks ran in that window. Later
retrospective journal/database evidence through 17:16 PDT records **36 cleanup
executions with matching queued/executed plot identities**, no watchdog-held
task loop, at most **three cleanup attempts per rolling ten minutes**, and
**20/40/80-minute** backoff across unchanged retries. These are zero-change
failures/deferments, not productive completions. One separate home-survey
return completed. No further log removal or live field fill was observed in
the revision window. The two earlier verified log removals remain preserved.

Current sampled health/hunger: **20/16**. The configured auto-eat threshold
triggers strictly below 16, so 16 by itself is not evidence of a stuck eater.
The owner room remains blocked at **85/145**. All eight sampled saved cells
(including three crafting tables, two cobblestone fixtures, farmland, and
the removed-log location) match the before snapshot. Saved data can lag loaded
chunks. Four separate night-shelter attempts reported no safe ground; no new
cause or regression attribution was established.

The revised rollout verifies identity and bounded backoff; it does **not**
prove successful field filling, owner-room resumption, fresh combat, or
resolution of the Maia freeze. Those branches remain explicitly pending or
test-only as described above.

[Revised deployment evidence](investigations/cobblebob-deployment-2026-10-18-v2.json)
and [execution identity checks](investigations/cobblebob-execution-identity-2026-10-18-v2.json).
