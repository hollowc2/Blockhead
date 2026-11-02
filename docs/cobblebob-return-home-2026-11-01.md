# CobbleBob return-home and equipment repair — 2026-11-01

Deployed to Maia's isolated runtime; only `blockhead.service` was restarted.
Equipment changes were committed separately as `acfe74f`. Final code release:
`4983c8cc81da477c6d7008ae78e488ceaa93bd5b` (2026-11-02 04:05:53 UTC).

## Outcome and root causes

The server initially placed him at `(21.5,68,2.5)` in the overworld, 43 blocks
south of home `(22,59,-40)`, beside a tall birch-plank obstruction. Inventory:
31 wheat, 142 seeds, seven dirt and two slime balls; no edible food or gear.
This was open terrain, not a sealed cave. A foot route existed around the wall.

- The upstream planner admitted a diagonal clipping the solid wall corner.
  Shared movements now require cardinal steps around solid corners. Blind
  walking yields after bounded unsuccessful clearing instead of hammering a
  protected structure; it retains safe natural-terrain digging by hand.
- Failed homing now triggers bounded nearby wood/tool recovery, once per
  failed bread trip. A confirmed return releases its bread *route* cooldown;
  unrelated storage failures retain their backoff. Carried food permits an
  equipped bot to work without treating the six-bread reserve as mandatory.
- Log approaches could settle while airborne and then fail the digging stance
  check. Movement waits briefly for landing, and surface-tree selection rejects
  trunks beneath a solid terrain/structure roof rather than entering deep caves.
- After a distant harvest, the farm searched only near the bot for a crafting
  table and tried to replace it without wood. It now also searches the home
  anchor and walks back to the existing station before baking.

First successful return: 02:49:05 UTC, `(23.52,58,-38.5)`. Subsequent observation
found additional starvation cycles, which led to the landing, readiness and
station fixes above. Following the final fix, he baked his wheat, recovered
from one health to 20, restocked tools, and completed the old held bread task
at **04:20:04 UTC**, carrying seven bread with no active watchdog blocks.
Both stone-tool restocking and the protection-first equipment task ran live.

Final uninterrupted observation: **2026-11-02T04:06:46.009796+00:00 through 2026-11-02T04:36:46.569890+00:00** (30.0 minutes). 0 deaths and 0 new bread watchdog blocks. Final health/hunger: 20/17; 11 bread, stone pickaxe, stone sword and wooden axe carried. One connected bot session and zero automatic service restarts were confirmed. Work continued around the home farms.

## Validation and warnings

Disposable vanilla 1.21.4 survival server, loopback 25599: empty-inventory
return over a nine-block height difference, stone barrier and birch obstruction;
field recovery punched/collected logs, placed a table and made a pickaxe. The
unsafe-corner regression fails against the original movement code. Repro:
`BLOCKHEAD_DISPOSABLE_TEST=1 BLOCKHEAD_SMOKE_PORT=25599
node_modules/.bin/tsx scripts/return-home-smoke.ts` (operator-enabled disposable
server only). The disposable server was stopped after testing.

`npm run typecheck`, normal `npm test` (**1,085 passed**, exited normally), and
`git diff --check` passed. Staging also passed 1,085 tests using
`tsx --test --test-force-exit src/**/*.test.ts`; force-exit use is recorded here.
Nine deployed file hashes match committed source.

Pre-repair six-hour capture versus the final 30.0-minute observation (counts; hourly rates in parentheses):

- No-diggable blind-walk stalls: 111 → 0 (18.5/h → 0.0/h).
- Pathfinder resets: 76 → 31 (12.7/h → 62.0/h).
- Obstacle clears: 66 → 20 (11.0/h → 40.0/h).
- Travel fallbacks: 29 → 5 (4.8/h → 10.0/h).
- Task exceptions: 23 → 1 (3.8/h → 2.0/h).
- Stuck nudges: 22 → 5 (3.7/h → 10.0/h).
- Perch rescues: 17 → 2 (2.8/h → 4.0/h).
- Insufficient-wood field crafts: 18 → 0 (3.0/h → 0.0/h).
- Watchdog blocks, all actions: 15 → 0 (2.5/h → 0.0/h).

These are different-length windows, so raw counts alone are not improvement evidence. Blind-walk stalls, insufficient-wood field-craft warnings and new bread watchdog blocks were zero in this window. The remaining task exception was an AbortError preemption. **The overall warning-reduction target was not met:** the selected warnings totalled 64 in 30 minutes (128/h), versus 477 in six hours (79.5/h). Route reset, obstacle-clearing and fallback rates increased during active work, despite successful food/tool recovery. These remain follow-up movement work.

## Deployment, rollback and remaining limits

Source repair commits: `acfe74f` (equipment), `a79d85a` (movement/recovery),
`978ed2d` and `47996fc` (recovery choice/cooldown), `1a05092` (landing/trees),
`b1a3e3d` (readiness), `4983c8c` (home table). All staged releases had backups
and passing checks before installation. No live console grants, world edits,
DB edits, configuration changes, or other service restarts were used.

Backup and receipt directory on Maia:
`/home/corey/.local/share/blockhead-backups/return-home-20261101/`.
`deployment-manifest.json` pins the release and SHA256 of all nine installed
files; it is also in the runtime. Runtime Git metadata remains the old baseline
because deployment used a verified file overlay. The manifest is authoritative.
Baseline code archives, consistent pre-deployment SQLite backup, test logs and
observation evidence are retained in the backup directory.

Rollback: `ssh -F /dev/null corey@maia 'sh /home/corey/.local/share/blockhead-backups/return-home-20261101/rollback.sh'`.
It stops only the bot, restores and verifies the nine pre-repair runtime files,
updates the deployment marker and starts only the bot. It preserves the current
DB and world, and retains the equipment repair already installed before this task.

Shield and iron armor are **not yet equipped**: acquisition still fails to find iron. The protection-first task now reports that precise prerequisite failure and stops further upgrade trips. Occasional route timeouts and a species-specific oak-log prerequisite failure remain. The completed repair should not be read as a claim that all gathering/navigation defects are solved.

Visual stream verification is blocked: no browser is connected in this session,
and supplied video `IIjZYz4Zolk` reports **Private video** to unauthenticated
access. Stream journal frame/write counters keep increasing. Movement, food and
tool recovery were verified from server truth, journal and telemetry; a visual
inspection of the private video is not claimed. Stream settings were unchanged.

## Follow-up: repeated drop-pickup routes

The high reset count above was traced to repeated four-second pickup attempts
at the same obstructed crop-drop area (20:27–20:29 PST), including different
item entities in the same pile. Pickup routing now remembers a failed block
cell for five minutes, matching the ordinary lifetime of dropped items. This
backoff is shared across harvests, bounded in memory and scoped to the bot
session. Drops in a different cell get a fresh attempt; passive pickup remains
possible. A regression checks repeated harvests and multiple entities in the
same failed cell, plus a moved drop that should be tried again.
