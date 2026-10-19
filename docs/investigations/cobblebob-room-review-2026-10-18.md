# Owner room review — 2026-10-18

Read-only investigation; no Minecraft connection, console command, bot launch,
world mutation, database mutation, or service restart was performed.

Project `f3adef30-a71a-40cb-96fc-71dec89484f4` remains blocked in SQLite,
last updated 2026-10-04T03:18:10.729Z, with cursor85/145, last verified
operation `op-00084`, and last error `birch_log` at `(68,99,53)`.
Frozen blueprint hash:
`b8a86828ac58864c29f0b2980bcd6cba1e309e554c26406466b78d2faad83380`.
Operation85 requires `oak_planks` there; the blueprint does not authorize a
log replacement at this coordinate. Tree clearance is explicitly enabled
only for autonomous village buildings, not owner rooms. Logs are excluded
from the general natural-terrain clearance predicate because players build
with them. The historical block's provenance cannot safely be inferred from
its material alone.

The local and Maia runtime `src/skills/base.ts` matched before these edits:
SHA256 `a8c7ff511defa5da7b3be2b341ec910162a70b96854192ca93f91177f6a52331`.

A fresh read of saved region
`/home/corey/mc-server/cobblebob-forest-20261003/region/r.0.0.mca`
(mtime 2026-10-18 12:18:09 PDT) retrieved chunks `(3,3)` and `(4,3)`;
both had DataVersion4189 and LastUpdate18961051. The saved block at
`(68,99,53)` is now **air**, not a log. No log occurred in the inspected
neighborhood x66..70, z51..55, y96..106. Of the first85 operations,70 still
match with the existing plank-species substitution rule. Fifteen differ:

- Air at `(63,96,59)`, `(64,96,59)`, `(65,96,59)`, `(63,97,59)`,
  `(64,97,59)`, `(69,97,57)`, `(63,98,58)`, `(63,98,59)`, `(64,98,59)`,
  `(69,98,57)`, `(63,99,58)`, `(63,99,59)`.
- Crafting tables at `(64,99,53)`, `(65,99,53)`, `(66,99,53)`.

All fifteen expected plank wall cells. This is saved disk state, not a
transactional snapshot of the server's currently loaded chunks. Confirm it
against loaded blocks before an approved live continuation; historical
85/145 counters do not prove that85 cells remain intact today.

## Local fix and safety boundaries

`BaseBuilderRunner.runDesignSlice` now reconciles the completed prefix
against observed world blocks before new mutations. Drift returns
`PROJECT_WORLD_CHANGED`, preserves the existing cursor and counters, and
identifies mismatching operations. It does not silently rewrite project
state, remove fixtures, or assume unfinished operations completed.

An obstruction reports coordinate, dimension, operation, expected material,
and an actionable reason: ambiguous log ownership and missing clearance,
protected fixture, or failed/unverified clearance. Existing owner-tree
refusal remains intact. Own-build door replacement now requires a matching
prior blueprint operation at the exact coordinate, rather than any
same-material block anywhere in the blueprint.

Targeted validation: `npx tsx --test src/skills/base.test.ts
src/agent/build-projects.test.ts`:55 passed,0 failed. Tests cover owner log
refusal, protected fixtures, changed persisted prefix, foreign same-material
block refusal, and the existing budgeted resumption without duplicate work.
These are local tests, not evidence of successful live construction.

## Exact pending live action

No live log removal is justified by the current saved-world evidence.
After separately approving installation/restart, inspect the loaded block at
`(68,99,53)` and reconcile all fifteen changed prefix cells. If crafting
tables remain, the owner must choose preservation/redesign or explicitly
approve moving/removing those fixtures; current code deliberately refuses
this demolition. Only after reconciling the site should the existing owner
project be explicitly resumed. Preserve its frozen blueprint and historical
progress. If a log exists in loaded state, inspect its provenance and obtain
specific removal authorization before any live removal. Do not merely retry
the historical error or count a reconnect/zero-change task as acceptance.
