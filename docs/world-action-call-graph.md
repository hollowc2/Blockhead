# Blockhead world-action call graph

This is the boundary inventory from the hardening pass starting at commit
`74ad66f`. Read-only Mineflayer observations (`blockAt`, `findBlocks`, entity
and inventory reads) are intentionally not mutation boundaries.

## Scheduler boundaries

```text
spawn/retry bootstrap
  -> BootstrapRunner.run
     -> Scheduler.runWorldAction("bootstrap:<worldId>")
        -> bootstrap stages -> movement / collectblock / craft / furnace /
           equip / dig / placement / combat

TaskDispatcher.execute
  -> Scheduler.runWorldAction(task.id, task signal)
     -> runSkill(task)
        -> task-specific runner
           -> movement / collection / digging / placement / storage /
              windows / crafting / smelting / delivery / utility / combat

BackgroundManager.tick
  -> worldProbe(owner = background-probe:<uuid>)
     -> Scheduler.runWorldAction
        -> buildBase.needsAttention (probe)
```

`WorldActionExecutor` serializes these owners, removes cancelled waiters,
propagates lease cancellation, runs recovery before release, and only releases
after the leased callback settles. `TaskDispatcher` waits for the leased run
before settling or replacing a task.

## Direct Mineflayer mutations

The task-dispatcher path owns these calls through its outer lease:

```text
bot.pathfinder.goto / setGoal / stop
bot.collectBlock.collect / cancelTask
bot.dig
bot.placeBlock
bot.equip
bot.craft
bot.openFurnace; Furnace.putFuel / putInput / takeOutput / close
bot.openContainer / chest deposit/withdraw and window click/close
bot.toss
bot.autoEat.eat / cancelEat
bot.sleep / wake
bot.armorManager.equipAll
bot.pvp.attack / stop
```

The implementations are distributed across `src/minecraft/*.ts` and
`src/skills/*.ts`; each task runner receives `TaskSignals` from the dispatcher.
The bootstrap entry point now also has an explicit scheduler lease and cleanup
hooks.

## Background probes and event-driven handlers

`BackgroundManager.worldProbe` leases its build-base probe. Other background
work only enqueues a task; the dispatcher owns the eventual mutation.

Mineflayer event handlers in `src/minecraft/events.ts` update folded state,
record death/respawn facts, and enqueue interrupts/tasks. Chat replies are
direct `bot.chat` calls and are not world-action primitives. The `end` handler
requests task cancellation and stops pathfinder, collectblock, PvP, and open
windows before reconnect teardown.

## Reconnect, disconnect, death, and respawn

```text
bot.end -> scheduler.requestCancel -> stopWorldPrimitives
         -> runSession awaits TaskDispatcher.waitForIdle
         -> background.stop / hostile.detach / dispatcher.dispose
         -> connection state INTERRUPTING -> REINITIALIZING -> DISCONNECTED

bot.death -> bus death -> DeathRecoveryManager pauses ordinary work
bot.respawn -> bus respawn -> emergency recovery task dispatch
bot.spawn -> state refresh -> bootstrap lease + rehydrated task dispatch
```

`ConnectionStateMachine` validates lifecycle transitions and bounds reconnect
backoff. Session listeners and runners are rebuilt per connection attempt.

## Remaining audit items

These are intentionally still open for later focused slices:

- movement primitive convenience APIs now await one-shot `goto` paths and
  retain cancellation listeners until the pathfinder promise settles; dynamic
  `setGoal` follow/stop helpers remain synchronous because Mineflayer exposes
  no settlement promise for those calls;
- `bot.chat` in event/skill announcement paths is a protocol side effect, not a
  world mutation, but it has no scheduler lease;
- several bootstrap stage calls still rely on the lease cleanup callback rather
  than passing the lease signal into every individual craft/smelt helper;
- direct plugin calls in task runners are protected by the dispatcher lease,
  and container/window primitives reject calls outside the AsyncLocalStorage
  lease context; remaining non-container primitive APIs still rely on the
  dispatcher boundary rather than requiring a token in their signatures;
- delta and immediate policy revalidation coverage is not yet uniform across
  every storage/window/equipment/combat mutation.

The next slices should close these items in subsystem order: movement and
primitive adapters, storage/windows, then delta/policy contracts.
