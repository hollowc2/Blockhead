# Task: fix the missing home chest

## Context

CobbleBob (Blockhead) runs on Maia. The source checkout at
`/mnt/Repos/Games/Blockhead` is NFS-shared and is also the service working
directory. The bot is supervised by the per-user `systemd` unit
`blockhead.service`; use the commands in [`docs/deployment-maia.md`](docs/deployment-maia.md)
to inspect or restart it. Do not use `nohup` or start a second copy.
State persists to `data/blockhead.db` (SQLite, migrations in src/memory/migrations.ts).

Baseline commit: `4b5c808`. Do not rebase or rewrite history.

## Problem

The bot has **no home chest registered/placed**, so every stockpile skill
can gather but cannot deposit. Observed live today:

```
09:17:40 WARN  no chest at home to deposit into        (x6, once per food item)
09:17:40 WARN  task failed ... lastError=hunted the food but could not deposit it
09:17:41 INFO  stockpile check levels={"wood":2,"food":43,"fuel":0,"torches":0} ...
```

`food: 43` is *carried only* — the stockpile never sees stored amounts.
The same deposit path (findHomeChest in src/minecraft/containers.ts) is used
by wood / fuel / torch restore and by death-recovery, so wood:2 for days is
the same symptom. `gather_food` already handles this: when the deposit
returns 0 it reports STORAGE_NOT_FOUND (retryable) and the partial haul
stays carried.

Investigate, then fix:

1. **Why no chest.** Read `src/memory/storage.ts` (StorageRepository: how
   chests register, `findHomeChest` lookup) and `src/agent/state.ts`
   (AgentState.home / protectedRegion). Read the bootstrap STORAGE stage in
   `src/skills/bootstrap-survival.ts` (spec 7: HOME -> WOOD -> CRAFTING ->
   STONE_TOOLS -> FOOD -> WOOL -> BED -> STORAGE ...) and how far bootstrap
   got — check persisted stage state in `data/blockhead.db`. Note the
   mismatch: config home is x:0 z:0 y:64 but the bot spawns/beds at
   (-46.5, 84, 0.5). Determine whether the chest placement/registration
   never ran, ran at the wrong coordinates, or the registry lost its rows.
2. **Fix the root cause** (place/register a chest at the real home, or point
   registration at the actual shelter), and make the deposit path robust:
   the failure mode should not be a silent 0-delivery followed by a
   confusing "hunted the food but could not deposit it" retry loop.
3. **Clean up downstream**: delete dead code / stale migration paths the
   fix obsoletes. Keep `deliverCarried*` signatures unless the fix needs
   them. Do NOT special-case input.

## Constraints

- No linters/formatting passes; no new project-wide test runs. The built-in
  suite (`npm test`, tsx --test) must stay green; run `npx tsc --noEmit` and
  only the tests for files you touch.
- Follow existing repo conventions (Zod config schema, SkillResult statuses,
  pino logging, chat announce patterns). No second convention beside the
  existing one.
- This is a live bot: verify in-game behavior against logs
  (`logs/blockhead.log`), not just types.

## Acceptance (all must hold; paste evidence)

- `npx tsc --noEmit` clean; touched tests pass.
- After restart, the bot places/registers a home chest (or finds the real
  one) and `gather_food` deposit logs `delivered > 0`.
- Stockpile checks show stored food growing past carried amounts
  (`levels={"food": >43 ...}`) — stored chest contents are counted.
- No `no chest at home to deposit into` warning for 10+ minutes of runtime.
- Report: root cause, the change, restart, and the relevant log lines.
