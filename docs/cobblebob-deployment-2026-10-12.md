# CobbleBob live repairs — October 12, 2026

Runtime code release: `19ad7143c2dec183c5978ee520748d3ba9f50115` on Maia's user `blockhead.service`. Corey authorized committing, pushing, deploying, and continuing to repair problems found during live observation. Work began from `9738005` with Bob at 1/20 health and zero hunger.

## Changes deployed

- `7a26ae9`: food requests withdraw chest stock and verify carried inventory before reporting success. Failed transfers remain failures.
- `e98cc3a`: acquire a carried food reserve, keep empty-handed autonomous checkpoints parked, rescue outbound `NoPath` trips, and suppress duplicate cooldown-held hunger requests.
- `78e44fc`: open visible, reachable wooden doors, verify both halves, and make opened doors traversable in the pathfinder. Retire hunger emergencies after food arrives.
- `808d423`: use horizontal distance to decide when travel should target an underground destination's actual Y coordinate.
- `6699cc2` and `03546b7`: recognize repeated jump oscillation as a stall and release the trip for deterministic escape recovery.
- `1776a3e`: parked owner work no longer falsely labels autonomy as paused.
- `26f3a29`: prefer a verified home floor beneath a low roof, require tools that can harvest the resource, replace inadequate tools, and stock wood for field repairs before mining departures.
- `19ad714`: verify pillar landings before further digging, use supported pillars for enclosed recovery without a pickaxe, and recover missing tools before topping up a nonempty food reserve.

The old owner room remains parked at its birch-log obstruction, as previously directed.

## Live evidence

All times below are PDT on October 12.

- 09:20–09:22: Bob withdrew and ate stored bread, and resumed paused work as health recovered.
- 09:34:44: `opened door for navigation` at `(65,100,54)`; subsequent travel reached the ore region.
- 09:37–09:42: return-path recovery brought Bob back from the cave; he reached full health and stocked carried bread.
- 09:47: the expired watchdog cooldown released the equipment task and a fresh stone pickaxe was crafted.
- 09:53:28: three mined iron were smelted and an iron axe was crafted.
- 10:22:04: recovery produced another stone pickaxe after the old trip exhausted both pickaxes and repair materials.
- 10:26:37: the bread retry withdrew the shortfall and restored six carried bread.
- The next mining run logged `stocked wood for field tool repairs`, and telemetry showed three oak logs carried.
- 10:33:37: `Done. 1 iron pickaxes ready.` The mining-preparation goal subsequently completed.
- 10:37:24: farm work verified 29 wheat harvested, 10 bread baked, and 41 seeds planted. Aggregate food stock rose from 43 to 51 during the maintenance stretch.

Navigation still has retries and occasional trip-budget failures. Gathered iron was retained through a failed chest approach and successfully consumed by the subsequent smelting/crafting steps. Observation continues into maintenance and development.

## Verification

- Type checking passed after each code rollout.
- Full suite with the mining/tool preparation changes: **731 passed, zero failed**.
- Latest focused movement, readiness, and background checks: **63 passed, zero failed**.
- The disposable Minecraft 1.21.4 survival test verified refused unsupported door placement, supported doorway repair, exit through a closed wooden door, return to the interior home floor, and three server-observed pillars climbed without a pickaxe.
- The pillar test exposed a 37.5-second airborne digging penalty; waiting for landing reduced subsequent cells to about 7.5 seconds.
- Final code verification compared **233 source/runtime files** by SHA-256 with zero mismatches. The service was active with zero automatic restarts in its current invocation; telemetry reported 20/20 health and food carried.

## Deployment records and rollback

Each code rollout archived the previous runtime `src` tree beneath:

`/home/corey/.local/share/blockhead-backups/`

The final rollout's directory is `pillar-recovery-20261012`; its `runtime-src.tar.gz` restores code release `26f3a29`. `release-verification.json` records deployed file hashes, service state, telemetry, and the exact code rollback command. Continuing samples are stored at `stall-fallback-20261012/observation.jsonl`.

Code rollback on Maia:

```bash
systemctl --user stop blockhead.service
tar -xzf /home/corey/.local/share/blockhead-backups/pillar-recovery-20261012/runtime-src.tar.gz -C /home/corey/.local/share/blockhead-runtime
systemctl --user start blockhead.service
```

This procedure retains the current SQLite state and world progress. The existing Minecraft and LLM services, network exposure, and world rules were retained throughout the code rollouts.
