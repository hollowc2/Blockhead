# CobbleBob combat/retreat repair — October 15, 2026

## Findings

Live checks on Maia at approximately 20:02–20:08 PDT found the bot connected at 20/20 health and hunger, at `(52.5, 98, 40.41)`. `blockhead.service` was active with zero automatic restarts. A nearby skeleton repeatedly triggered defense; combat timed out after 60 seconds, retreat failed with `PathStopped` almost immediately, and passive defense retried after 30 seconds. Field development remained paused. The existing owner room remains blocked by its birch log.

Evidence and the three original runtime hashes are in [the captured live inspection](investigations/cobblebob-defense-2026-10-15.json). Those runtime files match source baseline `24202c2`.

The installed `mineflayer-pvp` implementation clears its target before waiting up to five seconds for `path_stop`. A second `stop()` then returns immediately. Blockhead's timeout helper only waits two seconds for cleanup, so the catch/finally cleanup calls can return while pathfinder's deferred stop remains set. The next retreat goal consumes that stop and fails. A regression test using the installed PVP class reproduces this failure before the repair and passes afterward.

A separate reachability gap lets fights against nearby targets run for the full minute: the existing early timeout only applies when the target stays more than six blocks away. The live evidence establishes an unproductive close fight; it does not establish why the original skeleton stopped taking damage. Live observation after deployment must confirm that the new early exit and retreat restore movement.

## Plan and implementation

1. **Finish combat cleanup before handing over movement.** `pvpStop` uses the plugin's synchronous `forceStop`, then requests a pathfinder stop and clears the goal to drain its deferred stop flag. Cleanup remains inside the scheduler's action lease, including cancellation cleanup.
2. **Bound close fights without progress.** The defense watcher breaks off after eight seconds without an observed target `entityHurt` event or at least half a block of improved approach distance. Actual hits extend that budget; the existing total fight budget remains. Checkpoints are also polled during fights. The watcher and damage listener are removed when the fight settles.
3. **Avoid repeating an unchanged failure at full frequency.** Passive retries against the same threat from the same position back off from 30 seconds through one, two, four, and five minutes. Movement over three blocks, a different nearest threat, and actual incoming damage bypass that hold. Dead and invalid entities cannot trigger passive defense.
4. **Validate before rollout.** Exercise the installed combat plugin's stop behavior, stalled close combat, observed-hit progress, repeated passive failures, movement, new attackers, and damage overrides; then run type checking and the full suite.
5. **Roll out only after explicit live-service approval.** Back up the three original runtime files, install only the three changed implementation files, restart `blockhead.service`, and observe recovery. Do not apply the old full-checkout deployment script to this uncommitted repair.

## Validation

- `npm run typecheck`: passed.
- `npm test`: **739 passed; zero failures**, approximately 35 seconds.
- The stop-handoff regression was first run against the old implementation and failed because the new retreat goal was cancelled; it passes with the repair.
- Corey subsequently approved live rollout; installation and observation results are recorded below.

## Prepared deployment and rollback

Target: Maia, user `corey`, `blockhead.service`.
Runtime: `/home/corey/.local/share/blockhead-runtime`.
Source: `/mnt/Repos/Games/Blockhead`.

Only these implementation files need installing:

- `src/minecraft/primitives.ts`
- `src/skills/defense.ts`
- `src/agent/self-defense.ts`

Before installation, compare the runtime SHA-256 values with the captured inspection and compare source values with the companion [repair manifest](investigations/cobblebob-defense-repair-manifest-2026-10-15.json). Abort if either changed. Create a new backup directory `/home/corey/.local/share/blockhead-backups/defense-handoff-20261015`; refuse to reuse an existing directory. Archive the three runtime files as `runtime-files.tar.gz` with relative `src/...` paths and retain the manifest, current service status, and pre-rollout telemetry there. Stop the service normally, copy the three verified source files to their corresponding runtime paths, and start the service. Verify the installed hashes against the manifest.

Observe at least five minutes, covering several former 90-second failure cycles. Require connection recovery, preserved health/food, movement away from the old stall, and meaningful resumed work or a clearly identified environmental blocker. Check that retreats no longer immediately fail with `PathStopped`, and that any stationary fight ends with the new progress diagnostic. Record positions, health/hunger, current tasks, task outcomes, and automatic restart count. A successful restart alone is insufficient evidence of recovery.

If the rollout fails, stop the bot and restore the backed-up files on Maia:

```bash
systemctl --user stop blockhead.service
tar -xzf /home/corey/.local/share/blockhead-backups/defense-handoff-20261015/runtime-files.tar.gz -C /home/corey/.local/share/blockhead-runtime
systemctl --user start blockhead.service
```

The rollback restores code; SQLite task state and Minecraft world progress remain persistent. Deployment and post-deployment observation completed following Corey’s explicit approval.


## Approved rollout and live result

Corey approved the deployment in this conversation. At **21:01 PDT**, the three runtime hashes were checked against the original manifest, the previous code was archived, the service was stopped normally, and only the three tested implementation files were installed. All installed SHA-256 hashes matched the repair manifest. The new service invocation remained active with **zero automatic restarts**.

The bot reconnected at full health and settled the persisted defense task. It left the original `(52.5, 98, 40.41)` position, attempted the home route, and continued through a separate navigation failure rather than repeating the old skeleton defense loop. The first land-development task failed its home approach after recovery placement refusals. A subsequent equipment task completed; telemetry confirmed **one carried stone sword**. Bob returned to home at approximately `(66.5, 102, 50.5)`, and subsequent development passes ran. Those passes skipped inaccessible tree trunks with zero cleared logs; their completed status is not evidence of productive construction or farming.

The observation captured **21 samples over more than five minutes**, ending around **21:06 PDT**. Health and hunger ended at **20/20**. No new defense failures or `PathStopped` events appeared after startup. The new eight-second stalled-fight branch was covered by regression tests but was not exercised by a new live combat encounter during this window. The observation demonstrates recovery after the restart with the repair installed; it does not isolate how much recovery came from clearing the old client state versus the code changes.

Remaining limitations are the separate home/terrain navigation problems, inaccessible trunks, and the previously parked room's birch-log obstruction. The combat repair stays installed, with the rollback archive retained.

Evidence: [deployment record](investigations/cobblebob-defense-deployment-2026-10-15.json), [observation samples](investigations/cobblebob-defense-observation-2026-10-15.jsonl), and [validation summary](investigations/cobblebob-defense-validation-2026-10-15.json).
