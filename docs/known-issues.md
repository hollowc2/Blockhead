# Known issues and investigation notes

Dated notes from debugging CobbleBob on the live server. Newest first. Each
entry says what was seen, what caused it, and whether it is fixed.

## 2026-10-05/06 — overnight monitoring of land development (maia)

The bot now develops the land in its free time: it clears and plants 8-block
plots in rings round home, two outer fields per building, and builds village
buildings (cottage, storage shed, windmill, barn, watchtower) on levelled
7x7 sites. It also takes down the half-cut trunks left over its fields.
Fixes from monitoring it overnight, each with a regression test:

### Fixed: LLM director decisions all failed validation (22:16-22:56)

Qwen3.5-9B answered `{"task": "...", "parameters": {...}}`. `normalizeDecision`
now lifts `parameters`/`params`/`args`/`arguments` into the action
(`src/llm/decider.ts`).

### Fixed: development stalls

- A field with no hoe and no wood carried tilled nothing. Development now
  fetches a spare hoe or logs from the chest first, enough for a new table
  too. The farm tops up one plank species before crafting a table or hoe:
  3 oak + 3 birch planks match no per-species recipe.
- A wood shortage on its restore cooldown kept development off, and the bot
  stood idle in daylight. Shortages that are cooling down no longer count.
- A build slice the scheduler blocked ("no progress after 4 attempts") left
  its project `active`, so the blocked-project retry never saw it. Such
  projects are retried too, and a development build still blocked after 6
  retries is given up instead of holding the one-building slot.
- Finished buildings now reserve their whole 7x7 site
  (`BuildProjectManager.siteCells`). A slim watchtower's site read as open
  ground, so a second watchtower was started on top of the first.
- A base repair placed a wall cell from the roof, 7 blocks away. Shell cells
  are now walked into reach first.

### Fixed: stranded on its own scaffold pillar (00:31-01:09)

The pathfinder measures a drop from the feet to the floor block, and refused
three blocks of air under a pillar. The perch rescue counted the air gap,
judged the drop safe for the pathfinder and did nothing. Both now measure the
same way (`stepOffPerch`, `src/minecraft/movement.ts`).

### Fixed: creepers

Backing away was the only answer to a creeper. One beside a field was evaded
66 times in 15 minutes. After three evasions of the same creeper, the bot
fights it hit-and-back: one hit, step out of fuse range, repeat.

### Fixed: deaths on long trips through water (02:50, 02:54, 08:58, 09:06, 09:21)

- An active goal now waits an hour after a death. The 1-hour pause only
  stopped a *new* goal, so the respawned bot was sent straight back.
- Resource trips skip known sites and search hits within 24 blocks of a death
  in the last day (`nearRecentDeath`). Iron under a lake at 64,60,125 killed
  the bot three times.
- The wood species pick (`dominantNearbyLog`) counts only standing trunks
  with leaves, outside buildings. It used to count the village's oak frames
  and the floating halves of trees cut over the fields, then crossed the lake
  for oak it could not find nearby. With no log in view (just after a login)
  the restore now retries instead of defaulting to oak. Every wood restore
  logs its census as `wood restore: trees around`.
- Swimming costs 20 per block (`SWIM_COST`, was 4), so lakes are walked
  round. Drowned with tridents caused the last two deaths.

### Open

- **Development deforests home** (addressed 10:23 by the tree farm below).

### Added: tree farm (2026-10-06 10:23)

When fewer than 12 standing trees are left within 64 blocks of home, development
sets aside up to two outer plots for trees. They are saved as named locations
`tree_farm_1`/`tree_farm_2` and planted with 5 saplings each (corners and
centre). The wood restore fells them like any tree, and empty spots are
replanted. Saplings come from the chest, from drops, or from broken leaves;
16 of each kind are kept instead of shed. Verified live: the first plot (-8,-40)
was fully planted by 10:28, the second (-8,40) was started next. Watch that
the wood restore starts cutting there once the saplings grow.
- **"Kicked for floating too long"** (00:14, 03:43): mid-air with a steady
  fall velocity during wood trips. The bot reconnects within a second. Our
  code never toggles physics, so the cause is not understood.
- **Watch after the swim-cost change** for path planning timeouts on long
  detours round water.
- **"auto-eat wedged; resetting"** shows up a few times an hour. It
  recovers on its own.

## 2026-09-27 — fresh world `cobblebob-fresh-20260927` (server 1.21.4)

### Fixed: bootstrap CRAFTING failed 3x on a fresh world (TERMINAL_BLOCK)

Seen: `not enough logs to craft 12 planks (8 held)`, then
`craft completed without an output delta` twice; impossible plank counts
(11, then 27 from about 6 logs); no `craft run failed` warnings.

Cause: mineflayer's inventory is a local prediction. A 1.21.4 server answers
`_syncWindow` (a click with `stateId: -1`) with a full-state `window_items`
and often a second one that arrives later but still shows the state from
before the next click. The old code resynced right before every recipe run,
so that stale snapshot landed after the craft's first clicks. It rolled back
the model's cursor and grid, and mineflayer's click sequence carried on from
that wrong state. The log stack was left on the server cursor, one log stayed
in the 2x2 grid, and the result was never picked up. `settledCount` then
timed out after 2 s and marked the run done anyway. Reproduced exactly against
a local vanilla 1.21.4 server with a packet trace.

Fix (`src/minecraft/crafting.ts`): `syncInventory` resyncs, waits until the
inventory packet stream has been quiet for 250 ms, puts cursor and grid
leftovers back, and settles again. Every craft count is read after that, and
each recipe run is checked against settled counts, with retries.
`craftMorePlanks` / `craftMoreSticks` replace `craftPlanks(bot, countPlanks(bot) + N)`,
whose `countPlanks(bot)` read an unsettled model. Regression tests are in
`src/minecraft/crafting.test.ts`.

Related: mineflayer 4.39 ignores 1.21.2+'s `set_cursor_item` packet, so the
server's cursor corrections are dropped. A full resync (`window_items`
carries the cursor) is the only way the cursor model gets corrected.

### Fixed: "could not reach the crafting table" every ~60 s

Seen: 256 occurrences, each right after `self-defense reflex triggered reason=zombie within 6 blocks`.

Cause: the reflex pauses the active task, and the pathfinder ends the trip
with `GoalChanged` or `aborted` before the trip's next `shouldAbort` poll. So
`collect_resource`'s wooden-tool craft saw a plain failure instead of an
interruption, and logged a `TOOL_REQUIRED` failure for a preemption.

Fix (`src/minecraft/movement.ts`): `travelAndWait` / `travelHomeAndWait` poll
`shouldAbort` and the signal once more when a trip ends short, and then report
`aborted`. This covers every skill that passes a travel abort probe.

### Fixed: stone tools planned from cobbled deepslate at the surface

Seen: `ensure_item plan item=stone_axe ... steps=[{"kind":"gather","item":"cobbled_deepslate",...},{"kind":"gather","item":"pale_oak_log",...}]`
for stone_axe/pickaxe/sword at home (y≈85). Each search runs out to 256 blocks,
finds nothing, and fails, until the anti-loop watchdog blocks the action for
10 minutes.

Cause: `rankRecipes` orders recipe variants by stocked inputs. With nothing
stocked, cobblestone, blackstone and cobbled deepslate (and every log species
for the handle) all scored 0, and the registry's order decided: deepslate and
pale oak.

Fix (`src/skills/ensure-item.ts`): the live catalog's `preferred()`
tie-break picks the stone found where the bot is (cobblestone, below y=0
cobbled deepslate, in the Nether blackstone) and the dominant nearby log
species. Stock still wins over the tie-break.

### Open: server "Timed out" disconnects during long block searches

Seen: eros `CobbleBob lost connection: Timed out`, and on the bot
`write EPIPE` then `disconnected reason=socketClosed` (18:05:44, 19:16:08). The
bot reconnects about 1 s later.

Cause: the deepslate searches above run `findBlocks` out to 256 blocks
synchronously. Two back-to-back searches took about 31 s with long stretches
on the event loop, so keep-alive replies went out late and the server dropped
the bot. A disconnect also aborts whatever the bot was doing. The planner fix
above removes this trigger. Still open: any long search can do the same, so
the search should yield to the event loop between radii and chunk columns, or
cap its synchronous work.

### Open: losing fights to zombies

Seen: `Defended. 0 hostiles cleared.`, `CobbleBob was slain by Zombie`, with
the reflex re-triggering every ~60 s at night. Probably the missing stone
sword (it was blocked by the deepslate issue, now fixed) plus the reflex's
engagement rules. Not investigated; re-check once the bot has a sword.

### npm audit: 12 moderate, no action

All 12 findings are one advisory, GHSA-w5hq-g745-h8pq: `uuid` < 11.1.1 lacks a
buffer bounds check in `v3`/`v5`/`v6` when a caller passes `buf`. The
vulnerable copies come from `mineflayer → minecraft-protocol → yggdrasil`
(uuid 10) and `→ prismarine-auth → @azure/msal-node` (uuid 8). Both only call
`uuid.v4()` with no buffer, and both are Mojang/Microsoft auth paths the bot
never runs: `src/minecraft/bot.ts` connects with `auth: "offline"`. There is
no upstream fix. Don't run `npm audit fix --force`: it "fixes" this by
downgrading mineflayer to a years-old major. Re-check when minecraft-protocol
updates its auth dependencies.

### Deploy note: mineflayer is stock again

Until this deploy, `node_modules/mineflayer/lib/plugins/inventory.js` on zeus
and in maia's runtime carried unrecorded hand edits (the waits in
`waitForWindowUpdate` and `putAway`). `scripts/deploy-maia` runs `npm ci` both
in the shared checkout and in the runtime, which put both back to the
registry's 4.39.0. The crafting fix was verified on stock mineflayer. Any
dependency patch that must survive a deploy has to live in the repo, like
`scripts/patch-prismarine-viewer.mjs`.

### 2026-10-06: level fields and floating trunks between plots

Fields now use the modal ground height (lower on ties), cutting natural
ground and farmland and filling crop-covered dips before tilling. Developed
fields with a 1–3 block spread are repaired one at a time before expansion.
Steeper plots remain available for building sites. Fill dirt comes from cuts,
inventory, then the home chest; cobblestone may support a field below its
surface, but the surface needs dirt so it can be tilled. Incomplete levelling
is skipped for the session and returns a retryable failure.

Tidy surveys reach four blocks from field centres, covering the gaps. Only
trunks with air or leaves below them qualify; standing trees, logs touching
crafted blocks, reserved build cells, village sites and tree-farm plots plus
a margin are excluded. Unreachable logs remain skipped, with cleared and
unreachable counts logged. Pathfinder scaffolding is frozen for development, preventing leftover
pillars and refill of newly cut cells. The existing collector notes two fall
deaths from towering to see logs.

Regression tests cover crop heights, cut/fill plans, slope limits, repair
priority and skips, reserved cells, tree farms, gap trunks and building frames.

Live verification also found that most inner fields have one torch column.
Repair accepts those surveyed footprints, preserving the fixture and levelling
the natural ground columns rather than requiring 25 unobstructed columns.

Tidy also checks `isReachableFromGround` before collecting: high logs without
a real-ground work pose are counted as unreachable immediately. Freezing
scaffolding alone still let the pathfinder climb into leaves and fail its
return home during live verification. This avoids canopy approaches and
spending the collection timeout on clearly unreachable high logs.

The home destruction policy also needs to classify farmland as terrain (as
it does dirt and crops). Otherwise levelling silently skips every farmland
cut. A policy regression verifies farmland is allowed while paths, cobble,
planks, chests and torches remain protected. Pathfinder natural-block
classification is unchanged. Levelling now logs individual skipped cuts
and the resulting ground count and height range.
