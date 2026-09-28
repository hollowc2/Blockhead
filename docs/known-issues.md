# Known issues and investigation notes

Dated notes from debugging CobbleBob on the live server. Newest first. Each
entry says what was seen, what caused it, and whether it is fixed.

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

### Open: stone tools planned from cobbled deepslate at the surface

Seen: `ensure_item plan item=stone_axe ... steps=[{"kind":"gather","item":"cobbled_deepslate",...`
for stone_axe/pickaxe/sword at home (y≈85). Each search runs out to 256 blocks,
finds nothing, and fails, until the anti-loop watchdog blocks the action for
10 minutes.

Likely cause: the stone-tool recipes accept any `stone_tool_materials`
(cobblestone, blackstone, cobbled deepslate), and ensure_item's recipe ranking
picks deepslate when none are carried. It should prefer cobblestone, or the
material most likely near the bot's Y. Not yet fixed.

### Open: server "Timed out" disconnects during long block searches

Seen: eros `CobbleBob lost connection: Timed out`, and on the bot
`write EPIPE` then `disconnected reason=socketClosed` (18:05:44, 19:16:08). The
bot reconnects about 1 s later.

Cause: the deepslate searches above run `findBlocks` out to 256 blocks
synchronously. Two back-to-back searches took about 31 s with long stretches
on the event loop, so keep-alive replies went out late and the server dropped
the bot. A disconnect also aborts whatever the bot was doing. Fixing the
planner removes the trigger. The search itself should also yield to the event
loop between radii and chunk columns, or cap its synchronous work.

### Open: losing fights to zombies

Seen: `Defended. 0 hostiles cleared.`, `CobbleBob was slain by Zombie`, with
the reflex re-triggering every ~60 s at night. Probably the missing stone
sword (blocked by the deepslate issue) plus the reflex's engagement rules;
not investigated.

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
