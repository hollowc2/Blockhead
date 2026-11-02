# Return-home repair — 2026-11-01

Equipment repair committed separately as `acfe74f`.

## Evidence and implementation

Server `data get entity CobbleBob` and the existing viewer's read-only chunk
stream showed `(21.5,68,2.5)`, overworld, south of a tall birch-plank column,
43 horizontal blocks from home `(22,59,-40)`. Inventory: 31 wheat, 142 seeds,
7 dirt and 2 slime balls; no tools, armor or edible food. Last logged death:
2026-11-01 13:54:21 PST, fell from a high place. This was open terrain beside
a protected structure, not a sealed stone cave. A route around the structure
and down to home is possible; repeated direct walking into it cannot work.

The upstream diagonal planner accepts a diagonal when either cardinal side
is clear, but steering directly to the diagonal centre clips the other solid
corner. The live repeated first target was `(20,68,1)`. Shared movements now
require both sides clear, taking a cardinal step around walls first. A
regression fails against the original code (one unsafe neighbor instead of
zero) and passes with the repair. Natural stone can already be broken by hand;
this repair preserves that escape option rather than requiring harvest drops.

Blind walking now uses immediate facing and yields after 12 unsuccessful
clearance attempts instead of continuing for 241 ticks against protected
walls. Failed homing calls a throttled local survival recovery: approach a
supported visible trunk nearby, punch up to three logs, craft a field pickaxe,
and bake carried wheat at a reachable table. It never calls ensure-item or
homing recursively, and preserves the original return failure. Carried food
then lets the existing readiness gate select missing tools rather than bread.
No home coordinate replacement or live world console workaround is used.

Disposable server: loopback 25599, vanilla 1.21.4, survival, empty inventory,
9-block height difference, birch obstruction and stone plateau. Shared homing
reached `(22.31,59,-37.42)` by walking and hand-digging, without grants. Repro:
`BLOCKHEAD_DISPOSABLE_TEST=1 BLOCKHEAD_SMOKE_PORT=25599
node_modules/.bin/tsx scripts/return-home-smoke.ts` (operator-enabled disposable
server only). Local initial setup runs lacking operator access were invalid
and excluded; the script now asserts its initial position and empty inventory.

## Before and after

Pre-repair six-hour journal captured in `/tmp/cobblebob-before-journal.jsonl`:
111 no-diggable stalls, 76 pathfinder resets, 66 obstacle clears, 29 travel
fallbacks, 23 task exceptions, 22 nudges, 17 perch rescues, 18 insufficient-wood
field crafts and 15 watchdog blocks. This differs from the prompt's older
window. Counts must be compared by elapsed time, alongside actual recovery.

Deployment and observation results are appended below after verification.

First installation: `a79d85a660b0668a9bc6c1aefbb752672bbb726e`,
2026-11-02 02:44:36 UTC; staged 1,078 tests passed with `--test-force-exit`.
Normal local `npm test` also exited successfully with 1,078 passing tests.
Single CobbleBob disconnect/rejoin and zero automatic restarts confirmed.

Live observation exposed a separate decision deadlock: the durable bread
cooldown survived deployment, so even a repaired route would not be tried for
11 minutes. The follow-up selects a distinct `go_home` recovery with local
supply rebuilding once per failed bread trip, retaining bread's cooldown and
paused equipment checkpoints. A regression verifies it is not re-enqueued on
every idle tick; ordinary storage failures keep their existing behavior.

Follow-up `978ed2d283805b7fb3d7b2bdb9176971eb7d4071` installed at
02:48:20 UTC (1,079 staged tests passed). Recovery started at 02:48:52 and
completed at 02:49:05 at `(23.52,58,-38.5)` beside the home anchor. It got
around the obstruction without any manual world change. The local scan found
no qualifying nearby trunk, so its one insufficient-wood warning is expected.
The bread timer still held after arrival. A second decision follow-up releases
only that homing failure after a confirmed recovery return; unrelated storage
failures retain their cooldown (separate positive and negative regressions).

The disposable survival test also verified actual field recovery: punching and
collecting three logs, placing a table and crafting a wooden pickaxe.
