# CobbleBob follow-up repairs, October 18

Corey authorized necessary bot and Minecraft server changes to resolve the
reported blockers and keep CobbleBob working. Work is limited to this bot,
its Minecraft world, and its runtime; host policy/network settings are unchanged.

## Recovery record

On Maia, `/home/corey/.local/share/blockhead-backups/help-20261018` contains:

- `runtime-src.tar.gz`: runtime source before this follow-up.
- `blockhead.db`: SQLite backup taken after stopping the autonomous bot.
- `world.tar.gz`: world saved using `save-all flush`, with automatic saves
  disabled only for the archive operation and re-enabled in `finally`.
- `minecraft.yaml`, `service-before.txt`, `status-before.json`.
- `site-before.json`, `site-repairs.json`, `site-followup.json`: loaded block
  inspection and exact console repair records.
- `help-baseline.sha256`, `help-candidate.sha256`, `primitives-before.ts`.
- `observation.jsonl`: bounded post-installation status samples.

The survey/repair clients used CobbleBob's identity only while its autonomous
service was stopped. No whitelist entry was added, and no second autonomous
bot was launched. The Java server and model server were not restarted.

## World repair

Loaded blocks confirmed the previously recorded fifteen prefix mismatches.
Restored twelve missing plank cells and recovered three crafting tables from
wall cells. Cleared only surveyed obstructions on remaining blueprint cells;
a fourth crafting table and the old overlapping doorway were recovered as
items. The frozen blueprint, cursor and historical counters were preserved.
The bot re-verifies the prefix before resuming its normal project slices.

Moved CobbleBob from the pocket below the elevated home floor to clear floor
at `(66.5,103,51.5)`, and filled observed air holes in the interior floor at
y102. Added a white bed at `(64,103,52)` and `(64,103,53)`. Deposited surplus
bread into existing home storage where possible. Supplied 128 dirt, 128 oak
planks, an iron hoe, and an iron shovel; verified carried supplies. Cleared
the current storm once, preserving the existing frozen-noon daylight rule.

## Runtime corrections

- Development selection skips cleanup when none of its logs have a supported
  digging approach, preserving eligible field/building work.
- Automatic home return/sleep handles daytime thunderstorms. The shelter
  watcher yields to an available home bed during both storms and nights.
- Equipment refreshes stale inventory-slot references before equipping and
  refuses an observed held-material mismatch. Live construction had placed a
  crafting table at the next plank cell; this cell was cleared and its item
  recovered before restarting the corrected bot.
- Blueprint slices disable automatic pathfinder scaffolding so navigation
  cannot refill cleared roof targets with dirt between clearance and placement.
  The builder retains its explicit, verified support operations.

## Validation and observation

Typecheck passed. Full tests after the inventory correction: 776 passed,
zero failed. A later full run covers the construction scaffolding correction.
The fixed bot independently advanced the owner room from 85 to 103 verified
operations before the scaffolding conflict was isolated.

Further live acceptance results are recorded below when observed.

## Rollback procedure

Stop only `blockhead.service`, restore `runtime-src.tar.gz` into
`/home/corey/.local/share/blockhead-runtime`, verify the recorded original
hashes, and start that one service. Do not restore SQLite/world archives as
part of a code rollback: that would discard subsequent progress. Those
archives are recovery evidence for a separately assessed site restoration.

### Confirmed construction result

At 17:48:15 PDT, `build_project_verify` completed successfully and the bot
announced “The simple room is finished and checked.” All 145 operations were
completed through the normal persisted project workflow. The bot placed the
remaining wall/roof/door operations; no cursor or completion flag was edited.

### Follow-up home and inventory corrections

Normal development then revealed that generic junk cleanup discarded carried
dirt. Development now protects dirt and cobblestone as work supplies. Added a
home supply chest at `(67,103,51)` with nine dirt stacks, confirmed by server
acknowledgements. Added supported exterior access steps/ramp using air-only
fills; the completed room and its doorway were preserved.

Roofed-home arrival previously accepted a position three blocks below the
interior floor. Navigation now chooses supported interior arrival cells and
uses a tighter vertical tolerance for roofed homes. Tests include a home
cellar that must not count as arrival. The final six-file runtime manifest is
`final-candidate.sha256` in the backup directory. Installation checked all six
hashes. Full tests: 776 passed, zero failed; typecheck and `git diff --check`
passed. No source changes outside the reviewed files were installed.

### Live limits and environment adjustment

The bounded daytime-storm test did **not** pass: automatic `sleep` was
scheduled correctly from y103, but Mineflayer reported `bot is not sleeping`.
No successful bed use is claimed. The test restored clear weather. The
existing fixed-noon development world now also has `doWeatherCycle=false`
(previously true, queried before changing it), preventing recurring storm
stalls. Restoring random weather is `gamerule doWeatherCycle true` through
the existing console; the original daylight setting remains unchanged.

A supported internal ladder was added at `(64,100..102,51)` against a support
column at x63. Autonomous recovery from the lower room still failed in the
observed check; Bob was explicitly moved onto the storage floor for the next
acceptance checks. Do not describe that relocation as a successful native
home return. The final no-progress branch was corrected to refuse false
arrival; all 40 movement tests passed afterward, including the cellar case.

At 18:01:53 PDT the normal owner/LLM `retrieve_items` workflow successfully
withdrew 64 dirt into Bob's inventory from home storage. Once those corrected
prerequisites were observed, three development watchdog cooldowns and one
background restore cooldown caused by home/material failures were expired
for a fresh attempt. Failure histories were preserved. A consistent pre-edit
SQLite backup and the exact affected rows are retained in
`before-prerequisite-recheck.db` and `prerequisite-cooldowns-before.json`.

### Sustained productive acceptance

After the last prerequisite recheck, Bob independently:

- placed ten dirt blocks across the three previously failing plots;
- completed the two outer fields, tilling and planting 25 and 24 cells;
- removed six leftover logs across those completed fields;
- completed repeated native returns to the elevated home, ending at y103;
- maintained health/hunger 20/20 at the final capture, with an active service,
  zero automatic restarts, and zero consecutive task failures.

The southeast field received four native fill placements, but approach to
`(104,95,76)` timed out. That final gap was repaired once through the console
only after checking it was still air above grass_block. The server confirmed
the resulting dirt block. This manual placement is excluded from the ten
native placements above. Its normal field retry is still awaited.

Some high canopy logs remain inaccessible; bounded cooldowns keep those from
holding useful work indefinitely. The observed productive results and exact
runtime hashes are in
[investigations/cobblebob-help-2026-10-18.json](investigations/cobblebob-help-2026-10-18.json).

The internal ladder did not provide a verified escape route. After successful
exterior home returns were observed, its top opening at `(64,102,51)` was
capped back with oak planks so it cannot become a new fall trap. The lower
ladder/support blocks are not relied on for navigation.

### Final southeast field acceptance

At 18:14:40 PDT the normal retry of field `(40,24)` completed successfully:
23 cells tilled and planted, with both cobblestone fixture columns preserved.
All three previously failing fields have now completed. Total observed native
work since 18:02:43: **72 cells tilled/planted, 11 dirt placements, and six
leftover logs removed**, plus two clearable blocks in the final field. The
single direct console dirt placement remains separately accounted for.
Bob returned toward home under his own navigation at health/hunger 20/20.
The source and live runtime retain matching six-file hashes.
