# CobbleBob return-home and equipment repair — 2026-11-01

Deployed on Maia; only `blockhead.service` was restarted. Equipment repair was
committed separately as **`acfe74f`**. Final code release:
**`dacae4a0439b0c58bb7ae9ad69282eaebe2f2d62`**, installed 04:53:02 UTC Nov 2.

## Outcome

CobbleBob repeatedly returned home, baked food and restored tools. The old held
bread task completed at **04:20:04 UTC**, clearing its failure loop. The final
snapshot at **2026-11-02T05:03:25.692008+00:00** had **13 bread, 20 health,
17 hunger, a stone pickaxe, stone sword and wooden axe**. He was
working on equipment; the food-maintenance task had completed. One connected
bot and zero automatic service restarts were confirmed.

An uninterrupted **30-minute** observation (04:06:46–04:36:46 UTC) had zero
deaths or new watchdog blocks. A further **15-minute** follow-up across the two
pickup releases also had **0 deaths and 0 new watchdog blocks**. Food peaked at
31 carried; 13 remained in the final snapshot.

## Failure chain and fixes

Server truth initially put him at `(21.5,68,2.5)`, overworld, 43 blocks south
of home `(22,59,-40)`, beside a tall birch-plank obstruction. He had wheat,
seeds and dirt but no edible food or gear. This was open terrain with a foot
route around the wall, rather than the dated sealed-cave scenario.

- Shared movements reject diagonals clipping solid corners; blind walking
  yields after bounded unsuccessful clearing. Safe natural stone remains
  breakable by hand. Failed homing can rebuild nearby supplies, and background
  recovery runs once per failed bread trip. Confirmed home recovery releases
  that route cooldown while preserving unrelated storage backoff.
- Movement waits briefly for airborne log approaches to land. Surface-tree
  selection rejects solid roofs above trunks, avoiding underground wood targets.
- Equipped bots with some food can work without satisfying the optional
  six-bread reserve first. Empty supplies remain urgent.
- Farm baking also searches the home anchor for its table after a distant
  harvest, instead of requiring wood for a duplicate table. This rescued a
  starving bot carrying wheat: it baked food and healed from one to 20 health.
- The initial observation exposed repeated four-second attempts at obstructed
  crop drops. Failed pickup cells now back off five minutes, shared across
  item entities and harvests. Deferred cells are filtered before the target
  cap so fresh drops remain eligible. Five cell/session deferrals were observed
  with no repeated attempt inside five minutes; harvesting still replenished food.

## Checks and warning comparison

Typecheck, normal **`npm test` (1,086 passed, exited normally)**, and diff check
passed. Staging also passed 1,086 tests with `--test-force-exit`; that use is
recorded here. All nine deployed file hashes match committed source.

Disposable vanilla 1.21.4 survival testing on loopback 25599 verified an
empty-inventory return with a nine-block height difference, stone barrier and
birch obstruction, plus punching/collecting logs, placing a table and crafting
a pickaxe. The unsafe-corner regression fails against the original code. Repro:
`BLOCKHEAD_DISPOSABLE_TEST=1 BLOCKHEAD_SMOKE_PORT=25599 node_modules/.bin/tsx scripts/return-home-smoke.ts`
(operator-enabled disposable server only; the test server was stopped).

Counts below are **pre-repair six hours / initial 30 minutes / final 10.4 minutes**:

- No-diggable blind-walk stalls: 111 / 0 / 0.
- Pathfinder resets: 76 / 31 / 2.
- Obstacle clears: 66 / 20 / 1.
- Travel fallbacks: 29 / 5 / 1.
- Task exceptions: 23 / 1 / 1.
- Stuck nudges: 22 / 5 / 1.
- Perch rescues: 17 / 2 / 1.
- Insufficient-wood field crafts: 18 / 0 / 0.
- Watchdog blocks, all actions: 15 / 0 / 0.

The initial 30-minute warning target was **not met** (128 selected warnings/hour),
which prompted the pickup follow-up. The final sample is **40.4/hour** versus
**62.8/hour** before repair. Resets fell from 62/hour in the initial observation
to 11.5/hour in the follow-up. Different-length windows and the short final
sample limit the comparison; this is not a claim that all navigation defects
are solved. The final task exception was an AbortError preemption.

## Deployment and rollback

Repair commits: `acfe74f` (equipment), `a79d85a`, `978ed2d`, `47996fc`,
`1a05092`, `b1a3e3d`, `4983c8c` (home/landing/readiness/baking), `14aac93` and
`dacae4a` (pickup backoff/cap). Every installation had staging checks and a
rollback record. No live console grants, manual world/DB edits, configuration
changes or other service restarts were used.

Maia backup/receipt directory:
`/home/corey/.local/share/blockhead-backups/return-home-20261101/`.
It retains code archives, consistent SQLite backups, checks, observations and
`deployment-manifest.json` with the release and nine SHA256 hashes. Runtime Git
metadata remains the old baseline; the verified overlay manifest is authoritative.

Full rollback: `ssh -F /dev/null corey@maia 'sh /home/corey/.local/share/blockhead-backups/return-home-20261101/rollback.sh'`.
This stops only the bot, restores/verifies the pre-repair code, updates the
marker and starts only the bot. It preserves the current DB/world and retains
the equipment patch already installed before this task. `rollback-drop.sh` in
the same directory undoes only the pickup changes to the preceding food fix.

## Remaining limits

Shield/iron armor are not yet equipped: earlier attempts failed on iron
acquisition, and another attempt is active. Occasional route failures and a
species-specific oak-log prerequisite failure remain. The protection-first
repair preserves those precise blockers and stops further upgrade trips.

Visual stream verification is blocked: no browser is connected, and supplied
video `IIjZYz4Zolk` reports **Private video** to unauthenticated access. Stream
frame/write counters continue increasing; movement and recovery were verified
from server truth, journal and telemetry. No visual video inspection or stream
settings change is claimed.
