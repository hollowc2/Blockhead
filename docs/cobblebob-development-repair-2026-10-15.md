# CobbleBob navigation and development repair — October 15, 2026

The combat repair remains installed. Subsequent observation showed development doing little useful work despite healthy vitals. This follow-up addresses the remaining navigation and cleanup failures within Corey's request to identify and address them.

## Evidence and causes

- At 21:23 PDT, the bot remained connected with 20/20 health and hunger. Logs showed repeated home approach stalls beside a wooden wall, blind recovery digging, and rejected pillar placements. A read-only inspection of the saved Minecraft region confirmed stacked rooms: a lower oak doorway at `(65,100,54)`, an upper birch doorway at `(65,103,54)`, and a supported standing cell at `(66,102,50)` where the bot had previously arrived successfully. The nominal centre is not the only valid arrival pose.
- Home navigation tried opening doors only after `NoPath`, although observed failures included planning timeouts and repeated stalls. It then fell back to blind digging near the structure.
- Floating-log eligibility checked at most three blocks below a log, excluding logs four blocks above a supported stance even when their eye-to-target distance was within the existing 4.3-block digging reach. Collection could also request a path to the elevated log even when it was already within eye reach.
- Cleanup returned success after clearing zero logs and remembered inaccessible plots only in process memory. Restarting repeated those failed passes.
- A development run selected one field, then `tendFarm` collected all established fields as well. One recorded sowing pass considered **1,732 cells** and travelled across the entire developed area rather than finishing its selected plot. Normal food-maintenance runs still need the wider farm scope.

## Changes

1. On a failed home approach, try opening a reachable door for every failure type. Near home, route to any verified supported standing cell within the established home arrival radius, with digging and scaffolding disabled. If none can be reached, report an entrance blocker rather than blindly tunnelling below the house.
2. Compute actual supported digging stances within the existing eye-reach limit. Approach a standing pose for floating logs, and dig directly when already in reach.
3. Verify log removal from fresh block observations. Unloaded cells are not counted as cleared. Defer blocked plots through the existing persistent cooldown store, and fail a zero-progress cleanup instead of reporting successful clearing.
4. Restrict development harvesting/sowing to the selected 5x5 plot. Ordinary farm maintenance retains its wider scope.

## Validation and rollout

The targeted regression run passed 62 tests before the final additional direct-reach and blocked-home checks. Type checking passed. Final full suite: **745 passed, zero failures**. Type checking passed after the final changes.

Only four implementation files are installed: `movement.ts`, `world.ts`, `develop-land.ts`, and `farm.ts`. The companion manifest records exact before/after hashes. Maia's existing runtime files must match their baseline hashes; unrelated combat changes remain installed. Archive the previous four files at `/home/corey/.local/share/blockhead-backups/development-navigation-20261015/runtime-files.tar.gz`, preserve service status and pre-rollout telemetry, stop normally, install the verified files, and start the same user service.

Rollback on Maia:

```bash
systemctl --user stop blockhead.service
tar -xzf /home/corey/.local/share/blockhead-backups/development-navigation-20261015/runtime-files.tar.gz -C /home/corey/.local/share/blockhead-runtime
systemctl --user start blockhead.service
```

Observe actual positions, health/food, log removal, per-plot farming counts, task outcomes, and automatic restarts. A zero-change completed task is insufficient evidence of useful work. Preserve any remaining environmental blockers explicitly.


## Live rollout result

At **21:30 PDT**, the prior runtime files matched their recorded baseline hashes. The four-file repair was installed with a rollback archive, and `blockhead.service` restarted normally. Verification confirms that all **seven** implementation files across the combat and development repairs match their manifests. The service is active with **zero automatic restarts**.

The live observation captured 21 samples over **307 seconds**. Bob used the new supported-arrival search after stalling outside home and subsequently completed cleanup work. Fresh block observations verified **12 logs removed**, including previously skipped plots. **8 blocked-plot cooldowns** are stored in SQLite; zero-progress cleanup tasks now report failure and defer the plot instead of reporting successful clearing. The bot also completed a zombie defense pass and resumed ordinary work. Final sampled health and hunger were **20/20**.

No farm sowing pass occurred within this cleanup-dominated observation window; limiting development to its selected 25 cells is verified by regression tests. Logs beyond safe supported reach remain deferred, so this does not claim every floating trunk was removed. No new blind digging fallback near home was required. The previously parked owner room remains outside this repair.

Evidence: [deployment](investigations/cobblebob-development-deployment-2026-10-15.json), [samples](investigations/cobblebob-development-observation-2026-10-15.jsonl), [selected live events](investigations/cobblebob-development-events-2026-10-15.json), [runtime hashes and durable cooldowns](investigations/cobblebob-development-verification-2026-10-15.json), and [validation summary](investigations/cobblebob-development-validation-2026-10-15.json).
