# Cobblebob investigation and repair plan — October 11, 2026

Cobblebob is connected, healthy, and adequately supplied, but several persistent failures consume his free time and expose him to avoidable danger. Fix survival and the home entrance first, then make development recover from missing prerequisites without repeating unchanged work.

This investigation used read-only checks on Maia: dashboard telemetry, the Blockhead systemd journal, Minecraft's server log, SQLite opened with `mode=ro`, LLM debug records, and source/runtime comparisons. No live service, configuration, world blocks, or saved state was changed. This document is a proposed implementation plan, not a deployment record.

## Evidence and scope

- Initial live snapshot: October 11, 19:16 PDT. Journal/database evidence captured at 19:18 PDT, covering the current session beginning around 15:33 PDT. UTC records cross into October 12.
- Bot, Minecraft, and llama.cpp services were active. Blockhead reported zero automatic restarts in this service invocation.
- Health and hunger were both 20/20. Stockpiles were wood 65/64, food 110/64, fuel 64/64, and torches 66/64. These are aggregate stockpile levels, not counts of usable equipment or proof that every chest is reachable.
- Journal: 69 task completions, 35 failures, 104 path trips ending without arrival, and 74 director decision failures. These are event counts within the capture window, not rates or unique-root-cause counts.
- Tasks created during this session: all 11 `build_base` tasks failed; development had 40 completed, 17 failed, and 3 cancelled tasks; all 3 death-recovery tasks failed; equipment recovery had 5 completions and 4 failures. Some journal events refer to resumed tasks created before this session.
- Minecraft confirms deaths at 16:36:43 and 16:51:33, both shot by skeletons, and 16:59:30, slain by a zombie. Two recovery attempts explicitly logged skeletons within 5 and 1 blocks of the death site.
- Development is still productive in places: recorded fields were tilled and planted, food was harvested and baked, and supplies were replenished. A completed development task can also be a tidy pass; 40 completions do not mean 40 completed fields or buildings.
- The inspected files in the local runtime copy match the checkout by SHA-256, including base building, development, background scheduling, LLM decisions, movement, watchdog, scheduler, and smelting. Existing uncommitted changes must be preserved. Matching disk files are not a comprehensive proof of every module loaded by the process.
- Captured supporting output: [investigation evidence](investigations/cobblebob-2026-10-11-evidence.txt).

## Findings

### 1. Home repair repeats a door placement the server refuses

**Observed:** House repair reports zero missing wall and roof blocks, but a missing door. The recent target is `(65,100,54)`; the bot carries three oak doors. Refusals occur both from a nearby position at roughly `(65.6,100,56.5)` and from a much lower, distant position. Material shortage alone does not explain this.

**Confirmed code weakness:** In `src/skills/base.ts`, the starter-base door branch awaits `travelAndWait` but ignores its result before calling `placeAtCell`. The placement helper's explicit reach gate applies only in creative mode. The survival door branch also lacks the detailed logging context available to other building placements.

**Open cause:** The close-range refusal is not yet explained. Need the actual support face, upper and lower doorway cells, obstructing blocks/entities, line of sight, and server interaction outcome. Do not assume more retries or longer polling will solve it.

**Related geometry:** Configured home is `(65,97,51)`; SQLite's named home is `(65,100,51)`. The starter-base layout uses the active home's Y directly as its floor. Logs show home routes targeting Y=103 from that saved home. This discrepancy is confirmed; whether it is an intentional relocation or a bad surface/roof anchor remains unverified. An older owner room near the same entrance also warrants an overlap check.

### 2. Sapling acquisition fails, then blocks development as a whole

**Observed:** Tree farms are saved at offsets `(-8,-40)` and `(-8,40)`. Recent replanting attempts begin with zero saplings. At 19:15, he found only one candidate leaf block, timed out trying to reach it, planted zero trees, and triggered a ten-minute `develop_land` watchdog block.

**Confirmed code weaknesses:** `gatherSaplings` selects leaves by distance and height relative to the bot, without the ground-access filtering already used for some trunk cleanup. `plantTrees` returns only a planted count, so zero placements are reported as “no saplings” even if travel, ground suitability, or placement caused the failure. A hunt cooldown exists, but it is only an instance timestamp. Development is one broad action; one plot's repeated failure can cool down all development.

**Implication:** Missing saplings are a prerequisite to resolve or defer. A single leaf is also a probabilistic source; breaking it would not guarantee a drop.

### 3. The director repeatedly selects house repair and trips its repetition brake

**Observed:** Successful model-result records repeatedly contain `{"task":"build_base"}`. Requests continue describing a missing door during the house-repair cooldown. Repetition failures continue approximately every decision interval.

**Confirmed code weakness:** `src/llm/decider.ts` counts equality of complete decision JSON across calls, shared across decision contexts. It throws after repeated identical non-wait decisions before `logResult`, losing the rejected response from normal result logs. `PAUSED` is assigned, but the background loop keeps calling the decider. Repetition is not tied to actual execution failure or changes in world state.

**Limit:** Exact raw responses for the rejected calls are absent. The earlier successful `build_base` decisions strongly suggest continued fixation, but do not prove every later rejected response was that task.

### 4. Combat and incomplete rearming turn setbacks into item loss

**Observed:** Three combat deaths near home, zero successful item recovery, and rearming failures due to inaccessible crafting tables and insufficient cobblestone. Current gear includes a stone sword, stone axe, and wooden pickaxe; the initial snapshot does not expose armor slots. Torches in stock do not prove the work area is lit.

**Confirmed behavior:** The self-defense reflex reacts to nearby hostiles and identified hostile damage. Death recovery intentionally refuses guarded sites. Existing tests cover these guards. The dangerous-site rejection should remain intact.

**Open cause:** Determine why defense passes around the deaths reported zero cleared hostiles, whether projectile damage is consistently attributed to a shooter, and whether he stayed on risky work when he should have retreated. The server log establishes the killers; it does not establish a single combat implementation bug.

### 5. The blocked room is an owner-project safeguard, not a resource shortage

**Observed:** Room project `f3adef30-a71a-40cb-96fc-71dec89484f4` is user-sourced, originated at `(63,96,53)`, and has been blocked since October 3 local time by a birch log at `(68,99,53)`. Telemetry shows 85 of 145 operations verified. Its saved blueprint includes more than just structural-shell progress.

**Confirmed behavior:** Building code intentionally clears some obstructions for autonomous development builds while leaving owner builds blocked. A passing test explicitly verifies that distinction.

**Implication:** Do not automatically delete the tree or silently replace the frozen owner blueprint. Expose the precise obstruction and resolve it through the existing owner-directed workflow. Inspect overlap with the starter base before resuming it.

## Implementation sequence

### Phase 1 — Explain the failures and protect survival

1. Add structured diagnostics to the starter-base door path: travel outcome, bot/eye position, both door cells, support coordinates/face, reach, obstruction/visibility, inventory before/after, and authoritative placement observations. Log model decisions before applying repetition suppression, with the suppression reason and action key.
2. Add a deterministic readiness gate for discretionary development and repair. Check current health, essential reachable tools, food, daylight/shelter, and local threats. Rearm or retreat before resuming work that has just caused a death. Keep urgent food maintenance available.
3. Trace defense attempts surrounding all three deaths. If shooter attribution fails, combine damage evidence with nearby ranged threats; do not infer that every loaded skeleton is attacking. Verify that low-health retreat can preempt development and that a zero-kill defense result does not imply the danger was resolved.
4. Inspect bed access, entrance access, work-area lighting, and nearby drops/caves. Separate loaded hostile counts from reachable or visible threats. Reserve a small accessible emergency supply of food, cobblestone, and essential tools through existing storage mechanisms.

**Acceptance:** Regression cases cover unidentified projectile damage, failed rearming, unsafe work deferral, and retreat without repeat attack loops. An observed night cycle ends with shelter or sleep and no fresh death from continuing discretionary work. Recovery still refuses guarded drops.

### Phase 2 — Reproduce and repair the home entrance

1. Reconstruct the saved-home, configured-home, starter-base, and owner-room geometry. Determine which elevation is the intended walking floor and which is a roof/arrival anchor. Record the intended anchor before any live state correction.
2. Reproduce survival door placement in a disposable Minecraft 1.21.4 world with the same support, adjacent shell, and elevations. Cover failed approach, occluded support, unsupported door, occupied upper half, and both interior/exterior approaches.
3. Require successful arrival and a verified usable interaction face before placing. Try a bounded alternative approach when the first is occluded; return a precise blocked/path error if neither is valid. Verify both door halves from server updates. Extend common placement checks to survival where appropriate after reproducing the close-range case.
4. Make a repeated unchanged doorway obstruction park that repair until geometry/access changes. A parked house repair must still permit safe unrelated work.

**Acceptance:** The reproduction fails before the fix and succeeds afterward with both halves observed. Failed travel never sends a placement interaction. After an approved live rollout, the actual entrance works and house repair stops producing identical failures.

### Phase 3 — Make tree farming recover from prerequisites

1. Return typed outcomes from sapling gathering and planting: unavailable stock, unreachable leaves/drops, unsuitable ground, refused placement, interrupted, and verified planted count.
2. Select accessible leaf/drop candidates; bound attempts per candidate and avoid repeatedly navigating to the same unreachable target. Refresh inventories after collection. Retain appropriate saplings for the chosen tree species and avoid destructive work inside reserved projects.
3. Persist sapling prerequisite backoff and per-plot blockers. Skip a blocked farm plot while other safe work exists; do not erase anti-loop protection. Use a work key that represents the actual plot/prerequisite rather than treating every development step as interchangeable.
4. Use available natural-tree harvesting and decay drops as sources when safe. If no viable sapling source exists, report the missing prerequisite once and wait for new evidence. Do not declare tree-farm success for zero verified planting.
5. Make levelling/planting errors identify the failed cell and prerequisite. Preserve partial progress and verify a building pad before starting its build. Persist plot deferrals rather than retrying failed terrain from scratch after every restart.

**Acceptance:** Tests exercise zero drops from reachable leaves, unreachable leaves, stocked but unreachable chest, carried saplings with failed travel, and restart during backoff. One blocked tree farm does not prevent a different feasible plot from progressing. Live observation verifies saplings planted and later harvested/replanted, rather than just task completion labels.

### Phase 4 — Tie planning retries to execution outcomes

1. Include explicit house-repair cooldown and prerequisite blockers in director context. Validate proposals against those blockers before enqueueing, even when the model ignores them.
2. Scope repetition tracking to decision kind and semantic action parameters. Count repeated failed work in unchanged circumstances, not identical wording alone. Reset appropriately after verified progress or a changed prerequisite.
3. Define `PAUSED` operationally: bounded backoff, continued deterministic safe work, and a clear condition for retrying. Avoid both permanent suppression and continual paid model calls that cannot produce runnable work.
4. Preserve diagnostics for suppressed calls and distinguish model transport/schema errors from valid-but-unrunnable proposals.

**Acceptance:** Tests cover repeated successful maintenance, unchanged failing repair, changed inventory/access, alternating decision contexts, cooldown expiry, and wait decisions. Director calls remain paced while safe work progresses; no recurring repetition error appears solely because the house is still incomplete.

### Phase 5 — Resolve the owner room and verify sustained operation

1. Inspect project ownership and footprint overlap. Present the exact tree obstruction and supported choices: clear only the authorized obstruction and resume the saved blueprint, or revise/cancel through the project workflow. Do not auto-clear it merely because it blocks village growth.
2. Verify project selection and dashboard labels so the old blocked owner room cannot be mistaken for the currently attempted starter-base repair. Keep its material and obstruction state visible.
3. After the changes pass tests, prepare a reviewable rollout with the exact patch, runtime backup, consistent SQLite backup, target services, and rollback commands. Request deployment approval then; the server-management skill requires explicit approval for live service restarts/deployment. The present investigation authorizes neither.
4. Observe at least 60 minutes spanning daylight and night, then check a longer session. Track deaths, verified block/crop/sapling changes, repeated failures by work key, path failures by destination, prerequisite recovery, and idle reasons. Compare like task types rather than treating all completions as equivalent.

**Acceptance:** No deaths during the initial observation; the entrance stays usable; safe development advances or reports a specific unavailable prerequisite; no unchanged repair repeatedly runs; restart preserves cooldowns and project progress; owner fixtures remain intact. A short successful observation is evidence to continue monitoring, not proof of unattended reliability.

## Verification already completed

- `npm run typecheck`: passed on the current checkout.
- Focused tests for base building, land development, LLM decisions, self-defense, death recovery, watchdog and persistence, movement, station reach, and smelting: **117 passed, 0 failed**.
- These tests establish a clean baseline for the inspected components. They do not reproduce the real server's close-range door refusal or prove correct behavior under live projectile combat.
- The test runner initially hit a sandbox IPC restriction; the approved rerun completed successfully. No fixes were applied and no bot or server was restarted.

## Implementation update — October 11, 19:51 PDT

The reliability changes are implemented. Doorway measurement now includes a missing floor, survival placement requires a reachable support, and the builder installs the floor before verifying both door halves. The disposable 1.21.4 survival-server test reproduced the original side-wall refusal and confirmed the floor repair; it also exposed separate lower/upper block updates, which are now awaited together.

Background work now gates on health, visible threats, and essential carried tools, with cooldown-paced rearming and food retrieval when healing cannot regenerate. Ranged threats and unattributed damage trigger defense, while solid cover filters passive detection. Failed retreat is reported as a failure. Terminal goal cancellation still runs during rearming. Urgent food maintenance remains available.

Tree-farm results distinguish missing saplings, path failure, unsuitable ground, refused placement, and interruption. Accessible leaf/drop selection is bounded; sapling and plot deferrals survive restart, and new carried saplings release a missing-material deferral. Development tasks carry plot-specific parameters/work keys, so failures do not all share one watchdog identity. Building pads are rechecked before a village project is started.

The LLM no longer treats identical valid wording as an execution failure: the scheduler's outcome watchdog remains authoritative. Model failures publish a bounded retry time, blocked proposals fall back to other work, and director context exposes restore cooldowns. Owner-project identity, description, and origin are included in dashboard telemetry.

The saved home elevation and frozen owner room remain intact. The upper starter shed already exists; moving its anchor automatically would create a second repair footprint. The birch-log obstruction is still an explicit owner-project decision, not automatically removed by development code.

Validation: current type check passed; the final full suite passed **704 tests with zero failures**; the survival-door smoke passed on an isolated loopback port. Existing uncommitted movement, watchdog, scheduler, and smelting changes were preserved and were included in test coverage. They were already present in the inspected live runtime and will remain unchanged by this deployment.

### Live validation follow-up

The first rollout made a stone pickaxe, then exposed an additional failure: a paused equipment-upgrade trip resumed after failed defense while health was about 6/20. The previous runtime was restored and the bot paused during correction. Idle-loop readiness alone did not cover scheduler resume paths.

A session activation guard now covers both direct activation and queue arbitration. Unsafe autonomous work remains queued/paused with its checkpoint intact; damage also interrupts a running autonomous task. Food, retreat, defense, shelter, and recovery remain runnable. Hurt, exposed bots can use the existing shelter skill in daylight and stay sealed until health recovers. The guard is installed before the dispatcher, survives task rehydration through session wiring, and is detached on disconnect/shutdown.

Validation after correction: **708 tests passed, zero failed**, and type checking passed. The new tests reproduce failed-defense settlement, preserved checkpoints, direct-activation refusal, restart safety, urgent food availability, and daytime shelter healing. The owner explicitly chose to keep the older room parked.

Crash recovery can also restore an `ACTIVE` row before ordinary queue arbitration. Binding the session guard now parks an unsafe restored active checkpoint before the dispatcher is attached; an additional regression covers that startup path. The full suite after this completion passed **709 tests**.

The real doorway approach subsequently failed because the chosen destination had no standing floor. Doorway approach selection now surveys supported feet/head cells and rejects occluded placement rays. A temporary, health-bounded descent allowance permits the small roof-to-entrance drop and restores the normal limit after the attempt. The expanded disposable survival test uses real pathfinding from a roof and verifies the floor plus both door halves; it passed. The final suite passed **711 tests**, and type checking passed.
