# CobbleBob revised deployment — installed

The first approved rollout removed two logs, then failed task-identity/fallback
acceptance and was rolled back at 12:39:55 PDT. Original runtime hashes were
verified and Bob returned at 20/20 health/hunger. This revised eight-file
candidate includes the dispatcher correction. Corey subsequently instructed
`continue`; it was installed at 14:47:49 PDT. All eight runtime hashes match.
Do not rerun installation: this document retains the approved procedure and
rollback commands. No host setting or manual world repair was applied.

[Observed rollout results and limitations](investigations/cobblebob-deployment-2026-10-18-v2.json).

[First rollout evidence](investigations/cobblebob-deployment-2026-10-18.json).

## Exact candidate

Install only these eight files, retaining their relative paths:

- `src/index.ts` — observed chest supplies for relevant prerequisite changes.
- `src/agent/background.ts` — retain durable history and skip watchdog-held work.
- `src/agent/task-dispatcher.ts` — preserve planned identity and cancel stale plans without watchdog charges.
- `src/minecraft/movement.ts` — checked action arrival contract.
- `src/minecraft/world.ts` — supported partial-height digging poses.
- `src/skills/base.ts` — precise obstruction and resumed-world reconciliation.
- `src/skills/develop-land.ts` — persistent backoff, retry budget, verified progress.
- `src/skills/farm.ts` — preserve paths during selected-plot farming.

[Manifest](investigations/cobblebob-repair-manifest-2026-10-18-v2.json) records
every original runtime and candidate SHA256. Companion
[baseline](investigations/cobblebob-baseline-2026-10-18-v2.sha256) and
[candidate](investigations/cobblebob-candidate-2026-10-18-v2.sha256) check files
use relative paths. Combat repair files are deliberately untouched. No package
or schema migration is needed. Do not run the old whole-checkout rsync/git-pull
deployment against this dirty checkout.

## Preflight on Maia (read-only)

Connect as `corey@maia`. During this session an SSH configuration ownership
error required `ssh -F /dev/null -o BatchMode=yes corey@maia.local`; this reaches
the same configured host. No SSH configuration was edited.

Run in **bash**, stop on any failure:

```bash
set -euo pipefail
source_root=/mnt/Repos/Games/Blockhead
runtime_root=/home/corey/.local/share/blockhead-runtime
evidence="$source_root/docs/investigations"
test "$(hostname)" = maia
systemctl --user show blockhead.service -p ActiveState -p NRestarts -p MainPID -p ExecMainStartTimestamp
systemctl --user cat blockhead.service
systemctl show cvtrack.service -p ActiveState -p UnitFileState
cd "$source_root"
sha256sum --check "$evidence/cobblebob-candidate-2026-10-18-v2.sha256"
cd "$runtime_root"
sha256sum --check "$evidence/cobblebob-baseline-2026-10-18-v2.sha256"
sha256sum package.json package-lock.json
sha256sum "$source_root/config/minecraft.yaml"
curl --silent --show-error --max-time 8 http://127.0.0.1:8155/status
```

Expected package.json SHA256:
`ff94efc57780443262ecca9d99b48bbd3a0a600bcf534a3c4d0f4102333523db`.
Expected package-lock.json:
`c821a25f2dfea1bfb42b182e96b35cf19d7c82e647becf928fd05f94a59856b9`.
Expected config:
`4b0e9b79b739a12190c6f9c41b72ca68e7e1aca02727bf3f521d7a325abd0f19`.
Stop and review any mismatch; do not update the baseline to bypass it. Verify
the effective working directory and ExecStart still match the documented
source/local-runtime layout. Capture health/hunger, position, room state,
task errors, deferred rows and service restart counters before approval.

## Approved installation and backup procedure

Only after approval, continue the same bash shell. The unique backup directory
must not already exist; `mkdir` intentionally refuses reuse. These commands
stop/start only `blockhead.service` and copy the reviewed eight files.

```bash
backup_root=/home/corey/.local/share/blockhead-backups/repair-20261018-v2
mkdir "$backup_root"
cp "$evidence/cobblebob-repair-manifest-2026-10-18-v2.json" "$backup_root/manifest.json"
cp "$evidence/cobblebob-baseline-2026-10-18-v2.sha256" "$backup_root/baseline.sha256"
cp "$evidence/cobblebob-candidate-2026-10-18-v2.sha256" "$backup_root/candidate.sha256"
systemctl --user show blockhead.service -p ActiveState -p NRestarts -p MainPID -p ExecMainStartTimestamp > "$backup_root/service-before.txt"
curl --silent --show-error --max-time 8 http://127.0.0.1:8155/status > "$backup_root/status-before.json"
cd "$runtime_root"
sha256sum --check "$backup_root/baseline.sha256"
tar -czf "$backup_root/runtime-files.tar.gz" src/index.ts src/agent/background.ts src/agent/task-dispatcher.ts src/minecraft/movement.ts src/minecraft/world.ts src/skills/base.ts src/skills/develop-land.ts src/skills/farm.ts
systemctl --user stop blockhead.service
test "$(systemctl --user is-active blockhead.service)" = inactive
sha256sum --check "$backup_root/baseline.sha256"
# Read-only SQLite connection makes a consistent backup, not a raw WAL copy.
node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database("/mnt/Repos/Games/Blockhead/data/blockhead.db", {readonly:true}); await db.backup(process.argv[1]); db.close();' "$backup_root/blockhead.db"
cd "$source_root"
sha256sum --check "$backup_root/candidate.sha256"
for file in src/index.ts src/agent/background.ts src/agent/task-dispatcher.ts src/minecraft/movement.ts src/minecraft/world.ts src/skills/base.ts src/skills/develop-land.ts src/skills/farm.ts; do
  install -m 0644 "$source_root/$file" "$runtime_root/$file"
done
cd "$runtime_root"
sha256sum --check "$backup_root/candidate.sha256"
systemctl --user start blockhead.service
systemctl --user show blockhead.service -p ActiveState -p NRestarts -p MainPID -p ExecMainStartTimestamp
```

If any step after stopping fails, leave the bot stopped while restoring the
archive below. No second bot may be started. Backing up SQLite does not grant
permission to restore/delete project state or to restore Minecraft regions.
These code changes do not require manual database or world edits.

## Rollback on Maia

Use only the archive made by the approved installation. Roll back code without
reverting SQLite or world progress:

```bash
set -euo pipefail
systemctl --user stop blockhead.service
tar -xzf /home/corey/.local/share/blockhead-backups/repair-20261018-v2/runtime-files.tar.gz -C /home/corey/.local/share/blockhead-runtime
cd /home/corey/.local/share/blockhead-runtime
sha256sum --check /home/corey/.local/share/blockhead-backups/repair-20261018-v2/baseline.sha256
systemctl --user start blockhead.service
systemctl --user show blockhead.service -p ActiveState -p NRestarts
```

New versioned backoff records use the existing reason text field. The previous
code treats that content as opaque text; no schema reversal is required.
If rollback itself fails, report it and leave the bot stopped.

## Live acceptance — procedure and remaining limits

Observe at least **15 minutes**, spanning the ten-minute maintenance budget;
check the longer per-plot deadline separately (initial twenty minutes, then
exponential, capped at 24 hours; protected blockers start at six hours).
Record sampled status and relevant log lines with timestamps.

- Health/hunger start and end near the baseline 20/20; investigate any health
  loss or falling. Confirm one bot and `NRestarts=0`; distinguish the approved
  service invocation from automatic restarts. Minecraft/llama invocations must
  remain unchanged. cvtrack must remain inactive/disabled.
- At a supported reachable fractional pose, require an **observed log removal**
  and fresh target block verification, with no repeated empty-path/no-progress
  route. Infeasible logs must report support/reach/access blockers and defer.
  Reconnection or task completion alone is insufficient.
- Task identity must match the actual executed plot/kind after returning home.
  An obsolete plan must cancel without any plot mutations or watchdog success/
  failure charge. A watchdog-held head plot must allow another eligible useful
  candidate, or waiting if none exists; a held home route must not generate
  repeated blocked survey tasks. Verify actual task parameters, workKey,
  executed plot, watchdog key and observed block changes together.
- Count zero-change maintenance runs: no fourth unchanged tidy/level attempt
  within its ten-minute shared hold. Persisted attempt count/deadline must grow
  on unchanged retries and survive a later separately approved restart. Useful
  unrelated work should proceed; if none exists, waiting is correct. Owner
  requests and urgent survival tasks must still preempt/respond.
- Fields without dirt must emit `missing fill material` with the cell and no
  claimed fill. After separately approved supply/restocking, require actual
  dirt placement(s), matching cut/filled telemetry, and surveyed level ground.
  Verify path/torch/building/tree-farm fixtures and neighboring plots remain
  intact. Supply must be observed in inventory/chest data before early retry;
  an unobserved chest change may wait until normal refresh or backoff expiry.
- Owner room must stay parked until loaded blocks and the fifteen drifted
  prefix cells are inspected. If continued after explicit site decisions,
  require precise `PROJECT_WORLD_CHANGED`/fixture refusal where appropriate;
  no automatic table/log removal, cursor reset or falsely completed operation.
  Only an approved reconciled site may resume, with fresh verified progress
  beyond the existing cursor and no duplicate/damaged completed construction.
- Combat/home behavior: observe safe supported home return and normal task
  handoff if an encounter occurs. Regression tests cover combat cleanup; a
  quiet acceptance window cannot claim new combat validation.

None of these pending checks authorizes manual world changes or a test restart.
If a checkpoint cannot be exercised safely in normal play, record it as pending
rather than claiming the test suite proves live success.
