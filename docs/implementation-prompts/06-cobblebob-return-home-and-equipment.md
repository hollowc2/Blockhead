# Get CobbleBob home again and finish the equipment repair

CobbleBob is now on a 24/7 YouTube stream (`tools/stream/`). Since at least
2026-10-31 he has been stuck: he can't get home, so he can't restock food or
gear, and most of what viewers see is "Resting". Find the root cause, fix it in
the shared movement/homing primitives, finish the in-progress equipment repair,
and deploy both. Watch him recover live. Don't stop at a diagnosis.

## Authorization

Covered: local edits and tests, the local repro server (see project memory), and
reading Maia's journal, server console, `logs/` and `data/blockhead.db`
(read-only). Also covered: committing, deploying the bot with the staged
backup/receipt process, and restarting **only** `blockhead.service`. Forcing day
or freezing the daylight cycle while testing is allowed.

Not covered (ask first): `/give` or creative workarounds, world edits beyond
small test volumes on the repro server, Minecraft/llama/Aegis/stream service
changes, firewall/Tailscale changes, and anything destructive to the world or DB.

## What is known (2026-11-01, treat as dated)

- Journal: `ensure_item failed` with `PATH_UNREACHABLE` / `could not return
  home: failed` for bread. The anti-loop watchdog blocks `ensure_item:bread:6`
  after 7 failures (10 min cooldown). The background `rearm:bread` restore
  stands by for 30 min.
- Most frequent warnings over 6 h: `walkToward stalled, no diggable blocks
  found in adjacency` (111), `pathfinder forcefully reset after stall/timeout`
  (92), `walkToward clearing obstacle` (66), `travel route leg failed;
  attempting walkToward fallback` (31), `task execution threw` (25),
  `pathfinder stuck in place` (23), `stranded on a perch` (17),
  `field craft: not enough wood for a pickaxe` (18).
- He carries no food, tools or armor. Without a pickaxe, "no diggable blocks"
  may simply mean he can't dig stone, so a route that needs digging is
  impossible for him.
- The equipment repair in `docs/cobblebob-equipment-repair-2026-10-31.md` is
  **installed on Maia but uncommitted**: `src/skills/ensure-item.ts` and its test
  are modified in the NFS checkout. `scripts/deploy-maia` refuses to run with
  uncommitted tracked changes. The receipt says cave access, the return route
  and shelter placement remain unresolved.

## Work

1. **Establish the live position.** Where he is relative to home (coordinates,
   dimension, Y level, enclosed or open), what is between him and home, and what
   he holds. Use the server's truth (`data get entity CobbleBob`) as well as the
   bot's own view, and server `logs/latest.log` for recent deaths. Decide whether
   home is reachable on foot with his current inventory.
2. **Reproduce** the failing return on the local repro server with a similar
   shape (same Y difference, cave/stone barrier, empty inventory). Get a failing
   test where possible.
3. **Fix the root cause** in the shared primitives: homing/travel, the
   `walkToward` fallback and its pickaxe-less digging, and how a failed homing
   feeds back into goal choice. A bot that can't get home should do something
   productive and visible: punch wood → craft tools → dig out, or re-establish a
   reachable home if the old one is truly cut off. Avoid tight retry loops that
   the watchdog has to break up. Don't add a one-off coordinate hack.
4. **Finish the equipment repair.** Review the uncommitted `ensure-item` diff
   against its receipt, make sure its tests pass with the homing fix, and commit
   it separately from the homing fix with a clear message.
5. **Verify and deploy.** Run `npm run typecheck`, `npm test` (use
   `--test-force-exit` if open handles keep it alive, and record that) and
   `git diff --check`. Commit, deploy with a backup and receipt, restart only
   `blockhead.service`, and confirm one bot session.
6. **Watch him recover** for at least 30 minutes, through the journal and the
   stream (`journalctl --user -u cobblebob-stream`; the stream itself should
   show movement). Success means: he reaches home or a deliberate new base, gets
   food, the watchdog stops firing for bread, and the warning counts above drop
   clearly. If he gets stuck in a new way, keep iterating.

## Deliverable

A short receipt in `docs/` with the root cause, the fix, before/after warning
counts, the deploy hashes, rollback steps and what remains. Update the equipment
receipt to say it's committed. Report outcomes, not plans.
