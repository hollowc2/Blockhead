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

The task-dispatcher path owns these calls through its outer lease. The
Mineflayer calls themselves are concentrated in the adapter modules listed
below; callers do not invoke them directly:

```text
bot.pathfinder.goto / setGoal / stop (movement.ts; dynamic setGoal is sync)
bot.collectBlock.collect / cancelTask (primitives.ts)
bot.dig
bot.placeBlock
bot.equip
bot.craft
bot.openFurnace; Furnace.putFuel / putInput / takeOutput / close (primitives.ts)
bot.openContainer / chest deposit/withdraw and window click/close (primitives.ts)
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

## Signal and settlement contract

Every leased mutation adapter validates the active lease even when a caller supplies an
explicit signal, checks that signal before the Mineflayer call, invokes the
lease's session policy hook at the last safe point, and checks the signal again
after its promise settles. If a caller omits a signal, the adapter derives the
active lease signal, so bootstrap and older maintenance call sites cannot
escape cancellation. Container and furnace close are cleanup adapters: they
intentionally do not reject merely because the lease signal is aborted, and
are awaited while the lease remains owned. Mineflayer's container/furnace
methods have no native AbortSignal parameter, so a genuinely hung plugin call
cannot be forcibly interrupted; the executor retains ownership until that
promise settles and the replacement cannot overlap it.

## Current hardening coverage

The current boundary coverage is:

- one-shot movement, collection, placement, crafting, smelting, digging,
  equipment, tossing, PvP, sleep, eating, and armor mutations have explicit
  lease-bound adapters, policy hooks, and signal checks;
- timeout cancellation hooks are awaitable, and the shared timeout helper
  observes plugin settlement before returning; dispatcher cancellation,
  replacement, timeout, and disconnect cleanup await the lease acknowledgement;
- container/window entry points require the AsyncLocalStorage lease context and
  signal-aware paths re-check cancellation around transfers and close windows;
  storage paths also re-check `useContainers` immediately before opening and
  immediately before each deposit/withdraw, and credit only observed deltas;
- crafting, smelting, placement, and recovery production chains pass their
  task signal explicitly at the call sites; adapters still reject missing or
  already-aborted signals when called by compatibility/maintenance code;
  the dispatcher supplies the session policy hook, which rejects a mutation
  before the Mineflayer call;
- teardown is a named, per-bot serialized adapter. It is the only unleased
  Mineflayer mutation boundary and runs dynamic-goal invalidation, pathfinder
  stop/goal clear, collectblock cancellation, PvP stop, and current-window
  close in order, awaiting every asynchronous cleanup before a second teardown
  or replacement can proceed. Process signals await dispatcher idle and this
  same teardown before quitting.

Known limitations:

- dynamic `setGoal` follow/stop helpers remain synchronous because Mineflayer
  exposes no settlement promise for those calls. Follow installs a lease-signal
  stop hook, and executor cleanup clears the goal and stops the pathfinder
  before ownership is released. The unavoidable limitation is that a server
  tick can race the synchronous call; there is no Mineflayer acknowledgement
  to await for that single call.
- `bot.chat` in event/skill announcement paths is a protocol side effect, not a
  world mutation, but it has no scheduler lease;
- protocol chat announcements are intentionally outside the world-action
  lease; they are rate-limited side effects, not world mutations;
- the adapter layer is uniformly signal-aware, but Mineflayer's individual
  container/furnace methods do not accept AbortSignal and can only be awaited,
  not forcibly interrupted;
- Mineflayer has no acknowledgement promise for synchronous dynamic
  `setGoal`/`stop` calls. A server tick can race the call; generation and lease
  ownership guards prevent stale callbacks from affecting a replacement, but
  no synchronous settlement can be awaited from Mineflayer.

## Direct dangerous-call inventory

The following direct calls remain, with their reason:

- `src/agent/world-actions.ts`: pathfinder `stop`/`setGoal(null)`,
  collectblock `cancelTask`, PvP `stop`, and current-window `close` — the
  named serialized teardown adapter required for disconnect, cancellation,
  replacement, timeout, and process teardown when no lease context exists.
- `src/minecraft/primitives.ts`: all equipment, digging, tossing, PvP,
  collection, container, furnace, sleep, eating, armor, and window calls —
  the explicit lease-bound adapter implementation; each performs signal and
  lease checks at its boundary.
- `src/minecraft/movement.ts`: pathfinder `goto`, dynamic `setGoal`, and
  `stop` — the explicit movement adapter; dynamic calls are synchronous in
  the Mineflayer API and have the settlement limitation above.
- `src/minecraft/world.ts`: no direct dangerous Mineflayer mutation remains;
  placement delegates to the adapters in `src/minecraft/primitives.ts`.
- `src/minecraft/crafting.ts`: recipe discovery and inventory reads are
  observations; recipe mutation delegates to `craftRecipe` in
  `src/minecraft/primitives.ts`.
- `src/minecraft/smelting.ts`: furnace mutation delegates to the furnace
  adapters in `src/minecraft/primitives.ts`; furnace close is awaited cleanup.
- `src/minecraft/events.ts` and skill announcement methods: `bot.chat` —
  protocol announcements intentionally outside the world-action lease and
  governed by chat throttles where skill-generated.
- `src/index.ts`: `bot.quit()` — protocol/session teardown after dispatcher
  idle and world cleanup; it cannot be lease-bound because it ends the lease's
  transport and is not a world mutation.
- database/status `.close()` calls — local resource shutdown, not Mineflayer
  world mutation.
