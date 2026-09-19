# Task: fix the torches stockpile restore (coal pathfinding timeout)

## Context

CobbleBob (Blockhead) runs on Maia. The source checkout at
`/mnt/Repos/Games/Blockhead` is NFS-shared and is also the service working
directory. The bot is supervised by the per-user `systemd` unit
`blockhead.service`; use the commands in [`docs/deployment-maia.md`](docs/deployment-maia.md)
to inspect or restart it. Do not use `nohup` or start a second copy.
State persists to `data/blockhead.db` (SQLite, migrations in src/memory/migrations.ts).

Baseline commit: `4b5c808`. Do not rebase or rewrite history.

## Problem

Torch stockpile is 0/64 (floor 8), fuel is 0 (coal/charcoal), so torch
restore preempts at MAINTENANCE priority every check. Every restore fails
in the fuel stage with a mineflayer-pathfinder planning timeout:

```
09:17:41 INFO  task activated taskId=58e110f8-... type=stockpile_maintenance
09:17:59 INFO  ensure_torches status message=Stuck: could not collect coal: Error: Timeout: Took to long to decide path to goal!.
09:17:59 WARN  task failed ... lastError=could not collect coal: Error: Timeout: Took to long to decide path to goal!
09:18:00 WARN  background restore standing by kind=torches block=restore failed (could not collect coal: ...)
```

The restore path is `ensure_torches` (src/skills/ensure-torches.ts)
`mineCoalOre`: find exposed coal (`findBlocksNear` + `hasAirNeighbor`,
src/minecraft/world.ts) within the expanding radius sequence
(skill-library `SEARCH_RADIUS_SEQUENCE`), then collect the blocks with
mineflayer-collectblock. The pathfinder ("Took to long to decide path")
is configured in the mineflayer-pathfinder setup — see
src/minecraft/movement.ts (`getMovements`) and its pathfinder
`AsyncPathfinder` timeout settings.

Investigate, then fix:

1. **Root cause.** Two candidate failures, determine which actually fires:
   (a) coal blocks *are found* but unreachable per the pathfinder (cliff /
   cave / underwater / holes in candidate scan), or (b) *no coal is found at
   all* (render-distance limit: `findBlocksNear` only sees loaded chunks —
   the same reason `gather_food` patrols ring edges). Add targeted logging
   (candidates found, block positions + distance, collected count, the
   pathfinder error) or reproduce by watching the bot, and pick the fix that
   matches the evidence.
2. **Fix the search OR the collection** so the restore either completes or
   fails cleanly:
   - If coal exists but is unreachable: fix candidate selection / pathing
     (respect exposed faces the bot can stand at; skip unreachable sites
     instead of dying on one).
   - If no coal is in range: mirror `gather_food`'s outward patrol (walk to
     the ring edge on a rotating heading and re-scan) so the search sees
     beyond render distance, OR fall back to charcoal (craft from logs +
     fuel) — `maintenance.ts` already counts `coal | charcoal` as fuel, so
     a charcoal path slots straight in. Pick the option the evidence
     supports; prefer the smaller, correct change.
3. Make the failure surfaced correctly: a clean `RESOURCE_NOT_FOUND`
   ("no coal reachable ...") instead of a pathfinder timeout, and the
   background standing-by/cooldown (src/agent/background.ts,
   `restore_cooldown_seconds: 60`) should keep the retry loop quiet until
   the state can actually change.

## Constraints

- No linters/formatting passes; no new project-wide test runs. The built-in
  suite (`npm test`, tsx --test) must stay green; run `npx tsc --noEmit` and
  only the tests for files you touch.
- Follow existing repo conventions (SkillResult statuses, pino logging,
  chat announce patterns, candidate-count caps). No second convention.
- This is a live bot: verify in-game behavior against logs
  (`logs/blockhead.log`), not just types.

## Acceptance (all must hold; paste evidence)

- `npx tsc --noEmit` clean; touched tests pass.
- Torch restore either completes (torches stockpile rises; craft works —
  sticks + coal = 4 torches) or fails with a clean, specific error.
- No `Took to long to decide path` timeout spam for 10+ minutes of runtime;
  standing-by stays quiet unless the world state truly blocks the restore.
- Fuel stockpile reflected in `stockpile check` levels (fuel > 0 once coal
  or charcoal is collected).
- Report: root cause (with the evidence that decided it), the change, the
  restart, and the relevant log lines.
