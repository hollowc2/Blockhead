# Equipment upgrade repair — deployed 2026-10-31

Corey approved the one-file installation. Installed on Maia at 19:25:55 PDT
(2026-11-01 02:25:55 UTC), restarting only the user `blockhead.service`.
The source checkout and persistent state remain at `/mnt/Repos/Games/Blockhead`;
execution remains in `/home/corey/.local/share/blockhead-runtime`.

`src/skills/ensure-item.ts` now makes/equips missing protection before optional
tool upgrades, equips already-carried armor at entry, and returns immediately
with the original prerequisite failure/interruption and any completed upgrades.
It no longer hides path failures behind a generic affordability error or starts
further upgrade trips after a failed prerequisite.

Validation: 1,076 tests passed using `tsx --test --test-force-exit
src/**/*.test.ts`; typecheck and diff check passed. The normal test run retained
open handles; the explicit force-exit run completed with zero failures.
Runtime baseline SHA256:
`1783a2ec8598270dea43287b60afb6d5f2f6719fce20a7667dde4b7d340a16b2`.
Installed SHA256:
`4f64cd652c0f11b2fceaeda7710b0aa288c2d295325f97ef6e117786891ff69d`.

Backup: `/home/corey/.local/share/blockhead-backups/equipment-20261031-192552`.
Contains original source, consistent SQLite backup, preflight status, receipt,
and exact rollback commands. To roll back: stop only `blockhead.service`,
restore `ensure-item-before.ts` to the runtime's `src/skills/ensure-item.ts`,
verify the baseline hash, and start the service. Preserve the current DB/world.

Post-installation: service active, zero automatic restarts, one bot session
confirmed by server disconnect/rejoin logs, connected with 20 health/20 hunger.
Death recovery was no longer active at installation. Existing paused equipment
and rearm tasks were preserved. Food resupply remains blocked by repeated
`could not return home: failed` errors; he carries no food, tools, or armor.
Consequently the new upgrade ordering has not yet been observed in live work.
The cave access, return route, and shelter placement problems remain unresolved.

The previously uncommitted source and regression tests were reviewed and committed
separately as `fix: prioritize protection and preserve equipment prerequisite failures`.
On 2026-11-01 all 37 ensure-item tests passed again. Live homing recovery is
tracked in `docs/cobblebob-return-home-2026-11-01.md`.

Commit confirmed: `acfe74f`. Integrated and deployed with homing release
`4983c8c`; the combined suite passes 1,085 tests. Live observation verified
that tool restocking resumed and the protection-first task attempted its shield
prerequisite. Shield/armor production remains limited by iron acquisition; the
precise missing-iron failure is preserved rather than replaced by a generic
affordability error. See the return-home receipt for the full observation.
