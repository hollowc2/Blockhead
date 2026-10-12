# Cobblebob deployment receipt — October 11, 2026

Deployed code: `6fa339d371a85a1b368452db50f8b067c48253fa`, pushed to `origin/main`. Final bot restart: **20:41:17 PDT** on Maia. Only `blockhead.service` was restarted; Minecraft, llama.cpp, and world rules were unchanged.

## Verified outcome

At **20:45:57 PDT**, the live bot completed the starter-base repair and reported “Base structure built: walls, roof, and door at home.” The preceding approach log records the formerly empty doorway floor, a supported arrival at `(65.5,100,53.5)`, and the repair's subsequent successful completion. The helper verifies the floor and both door halves from server-observed blocks.

At **20:49:37 PDT**, Cobblebob was connected with **20/20 health and hunger**, developing the land. Wood, food, fuel, and torches all met their targets. There were **no new deaths since the survival correction at 20:15:33 PDT**, no last LLM failure in telemetry, and no automatic service restart. All installed source-file hashes matched the final deployment manifest.

The owner room `f3adef30-a71a-40cb-96fc-71dec89484f4` remained blocked by its birch log, with 85/145 operations verified. Corey explicitly selected keeping that project parked. Its blueprint and the saved home elevation were preserved.

Evidence: [release verification](investigations/cobblebob-release-2026-10-11.json). Implementation and remaining environmental prerequisites: [repair plan](cobblebob-repair-plan-2026-10-11.md).

## Validation

- Type check passed; full workspace suite: **711 passed, zero failed**.
- Isolated Minecraft 1.21.4 survival smoke reproduced refused side-wall placement and verified actual pathfinding from a roof, supported approach selection, floor repair, both door halves, and restoration of the normal descent limit.
- Regression coverage includes failed approaches, visibility and placement reach, low-health interruption, failed-defense settlement, direct activation, paused and ACTIVE crash checkpoints, food availability, daytime shelter healing, sapling prerequisites, and persistent plot cooldowns.
- Existing uncommitted watchdog, scheduler, movement, and smelting changes were preserved separately from these commits. They were already part of the deployed runtime. The archive and source manifest capture the actual deployment, including that baseline.

## Rollout and rollback

The first rollout (`d7630f4`) exposed unsafe resumption after failed retreat. The original runtime was restored and the bot paused while the scheduler/shelter correction was tested. The second rollout (`ea2e578`) recovered to full health but showed an inaccessible doorway destination; the final deployment includes supported approach selection and the completed startup guard. Commit `9a0a70c` was included in the final code rather than deployed separately.

Backup directory on Maia:

`/home/corey/.local/share/blockhead-backups/reliability-20261012T025145Z`

It contains the original runtime archive, a consistent SQLite backup, the original and installed source hashes, rollout history, and release verification. Code rollback:

```bash
ssh -F /dev/null -o BatchMode=yes corey@maia 'bash /home/corey/.local/share/blockhead-backups/reliability-20261012T025145Z/rollback.sh'
```

Code rollback retains later world/database progress. Restoring the database is a separate recovery decision.

## Continued observation

A read-only 60-minute sampler for the final deployment continues until **21:41 PDT**. Its evidence is written in the backup directory as `observation-20261012T034117Z.jsonl`, followed by `observation-summary-20261012T034117Z.json`. The deployment receipt above covers initial live validation, not a completed hour-long soak.

The world is fixed at noon: `doDaylightCycle=false`, `DayTime=6000`; `randomTickSpeed=30`. A natural night cycle therefore cannot be validated under the current settings. The rules were left intact. Further observation should distinguish verified crop/block/sapling changes from completed administrative or tidy passes, and should not treat unavailable saplings or inaccessible terrain as resolved merely because work is now deferred correctly.
