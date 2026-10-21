# House extension candidate — awaiting live installation approval

At 19:51–19:53 Maia local time, the live service was connected, idle, with
health 19 and hunger 16. Project 9f6d45af-3ae6-4cf1-8316-6d040b2b1993
was blocked on its first operation at 67,100,51. No operations were verified.
The original room is not an upstairs extension and must not be resumed.

A read-only viewer Socket.IO survey (no extra Minecraft client) captured the
loaded house at x57..74, y94..112, z43..61. The two-storey main house has a
7x7 top roof at x62..68, y105, z48..54. Survey is retained in this session at
/tmp/cobble-house-grid.json. Both attempted owner-channel coaching commands
failed without creating a project: the model refused supported cuboids, then
returned malformed/truncated JSON for an explicit single-step design.

Candidate adds an owner-only `build plan <name>` route. Local JSON plans must
validate through the existing design schema/compiler, match the surveyed home,
and pass loaded-world preconditions. They use the registered build_design tool
and ordinary resumable project runner, material acquisition and placement
verification. Missing or changed supports refuse execution. Model code, raw
world edits and demolition are not used.

Plans:

- `house-roof-access`: 15 oak planks in five supported columns at x67,
  z59..55, from y101 to y101..105. Existing y100 platform supports every column.
- `house-upstairs`: 7x7 room at x62..68, y106..108, z48..54, roof y109;
  door at 67,106,54 meets the top step. 117 oak planks and two logical door
  operations; two surveyed cobblestone cells are retained as masonry.

All new operation cells were checked against the captured world: no
obstructions. Neither plan removes existing blocks. New route is after the
configured-owner check; invalid file names cannot traverse the plan directory.
The plan directory resolves relative to the installed module, since the live
service's working directory is the shared checkout while its source is isolated.

Validation: 865 tests passed, typecheck passed, diff check passed. After the
module-relative directory adjustment, the two plan tests and typecheck passed
again. Existing unrelated storage changes in the checkout are excluded.

## Install only after approval

Host Maia, user corey, service blockhead.service. Isolated runtime:
/home/corey/.local/share/blockhead-runtime. ExecStart uses that runtime's
node_modules/.bin/tsx and src/index.ts; WorkingDirectory is
/mnt/Repos/Games/Blockhead. Baseline automatic restarts: 0.

Before touching the service, verify runtime src/minecraft/events.ts SHA256:
8749d4c56384a5de31eaf9639432bc1a2a32701fd5cb659f70df3c7645289b93
and that src/building/saved-plan.ts and config/build-plans do not exist.
Create a unique backup under ~/.local/share/blockhead-backups/house-20261020*;
record service status and copy original events.ts. Stop only blockhead.service,
back up /mnt/Repos/Games/Blockhead/data/blockhead.db with SQLite's backup API,
then install these four files, preserving relative paths:

- src/minecraft/events.ts
- src/building/saved-plan.ts
- config/build-plans/house-roof-access.json
- config/build-plans/house-upstairs.json

Verify installed SHA256 against candidates before starting blockhead.service.
Do not copy the entire checkout or restart Minecraft/model services.

Check one connected bot, service restarts and health. Send `build plan
house-roof-access` through private /api/command. Observe actual verified
completion; resurvey the steps. Only then send `build plan house-upstairs`.
Observe acquisition, phase progress and final verification, and check actual
roof/door/step cells. An accepted HTTP response is not build completion.
The obsolete blocked room must not be resumed; preserve its history.

Rollback: stop blockhead.service; restore the saved original events.ts to
/home/corey/.local/share/blockhead-runtime/src/minecraft/events.ts; verify its
baseline hash above; start blockhead.service. Added plan/module files can stay
unused. Do not restore the database/world or undo verified building progress
as part of a source rollback.

## Approved live receipt

Corey approved installation. The four-file candidate was installed on Maia
at 20:08:48 local time. Baseline and installed hashes matched. Backup and
consistent SQLite copy:
`/home/corey/.local/share/blockhead-backups/house-20261020-200847`.
Only blockhead.service was restarted; connected health/hunger were 19/16,
with zero automatic restarts.

Roof-access project `66c76fab-6f4b-4e5e-9408-0d48755150f7` completed final
verification at 03:09:44 UTC, 15/15 operations. A fresh viewer survey confirmed
all five supported columns and unchanged roof supports.

The upstairs build fetched 49 planks but initially failed to approach its first
operation from ground level. Native travel through the new stairs succeeded,
reaching 67.46,106,55.5. Investigation found each design slice approached its
original anchor Y=100 despite the first operation being Y=106. The runner now
uses the pending operation's absolute elevation (or relative elevation plus
origin), including resumed slices. Blueprint geometry/hashes are unchanged.
41 focused tests and typecheck passed, including an upper-storey/resume
regression. The previous full suite passed all 865 tests.

The single additional source file `src/skills/base.ts` was installed after
baseline hash verification at 20:16:29 local time. Its baseline SHA256 was
7351bbc2204fcf963b4cfe0ae1786f942c270089c765176bf730ca88d80e9a00.
Backup and SQLite copy:
`/home/corey/.local/share/blockhead-backups/house-elevation-20261020-201629`.
Rollback this follow-up by stopping only blockhead.service, copying
`base-before.ts` from that backup to the isolated runtime's
`src/skills/base.ts`, verifying the baseline hash, and starting the bot.
No SQLite/world restore.

Upstairs project `955979d7-481f-44b2-8985-a8614a066e59` completed 121/121
operations with final verification at 03:18:32 UTC. A later repeat of the saved
plan reverified the same geometry as project
`83e8668d-344f-41a6-8c4a-62fbe041b323`, completing at 03:26:19 UTC; it did not
add another storey. The final read-only viewer survey independently confirmed
15/15 staircase blocks, 49/49 new roof cells at Y109, both south-facing oak-door
halves at 67,106..107,54, and clear entry headroom at 67,106..107,55.
Final bot health/hunger were 20/20, connected and idle. The original zero-progress
failed room is retained as a blocked historical project and was never resumed;
status widgets choosing unfinished projects may still display that old entry.
No unrelated checkout changes, Minecraft service, or model service were deployed.
Final survey: `/tmp/cobble-house-grid-final.json` in the working session.
