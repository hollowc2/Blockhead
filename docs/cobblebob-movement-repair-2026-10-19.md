# CobbleBob doorway movement repair, October 19

The live bot repeatedly failed home returns at the lower home doorway, around
(65.5, 100, 55.5). Health and hunger were 20/20; the service and model were
available. The world survey showed two home levels with open birch doors at
y100 and y103, rather than a single inaccessible upper home.

The movement configuration already allowed walking through open wooden doors,
but mineflayer-pathfinder's subsequent `postProcessPath` treated the open panel
as a standing platform. The observed waypoint was (65.703125, 101, 54.5), one
block above the doorway floor. Physics could not execute that jump beneath the
ceiling. Retries and watchdog cooldowns then stopped development.

`src/minecraft/movement.ts` now corrects server-observed open-door waypoints on
`path_update`, before path execution. Both halves must be open and a solid floor
must exist. Paths involving placement or digging are preserved. The correction
keeps real door collision shapes, and installs one handler per bot across
movement resets. A regression test covers the observed waypoint, closed doors,
collision preservation and repeated configuration.

The user authorized getting the live bot moving and productive. Before changes,
Maia backup `/home/corey/.local/share/blockhead-backups/moving-20261019` captured
runtime source, SQLite, config, service/status, a flushed Minecraft world archive,
and the loaded home grid. Only the movement source file was installed into the
runtime, with before/after SHA256 verification. No manual world repair,
teleport, cooldown reset, model restart or Minecraft server restart was used.
Survey and movement clients used Bob's identity only while his autonomous service
was stopped. Native pathfinding did place some normal scaffolding during the
initial reproduction; the successful controlled round trip disabled scaffolding.

Validation: typecheck, `git diff --check`, 45 movement tests and the full 808-test
suite passed. The previously failing doorway traversal succeeded immediately;
a native exit and return also succeeded. Autonomous service resumed at
10:08:36 PDT, with zero automatic restarts. Two autonomous returns from outer
plots then completed. Unreachable canopy cleanup was deferred normally.
At 10:10:27 PDT Bob verified two dirt placements and completed levelling plot
(-40,0) at y92, preserving its protected cobblestone. Subsequent farming yielded
22 carried wheat, and he began his normal return home at health/hunger 20/20.
Final task acceptance is appended after observation.

Rollback: stop only `blockhead.service`, copy `movement-before.ts` from the
backup directory to `/home/corey/.local/share/blockhead-runtime/src/minecraft/movement.ts`,
verify `baseline.sha256` from the runtime directory, then start the service.
Do not restore SQLite or the world as part of a code rollback.

Final acceptance: at 10:11:47 PDT plot (-40,0) completed normally with **24
cells tilled and planted**, in addition to its two verified dirt placements.
Bob crafted seven bread from the harvested wheat (carried bread rose from 143
to 150). At 10:12:00 PDT his next autonomous home return completed. He then
selected the next development task, with zero consecutive task failures.
The unreachable canopy plots remain deferred; this repair does not claim those
logs became reachable. Final status and selected logs are retained beside the
backup as `status-after.json` and `journal-after.jsonl`.
