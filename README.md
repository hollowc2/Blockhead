<p align="center">
  <img src="logo.jpg" alt="Blockhead" width="720">
</p>

# Blockhead — CobbleBob, an autonomous Minecraft companion

Blockhead is an experimental TypeScript/Mineflayer agent that joins a private
Minecraft Java server as CobbleBob. A local llama.cpp model interprets owner
chat and chooses from registered high-level tools; deterministic skills and
Mineflayer code perform the actual work.

The project is currently a working end-to-end prototype, not a production
Minecraft bot. The autonomous loop, persistent tasks and goals, bootstrap and
stockpile maintenance, safety policy, memory, dashboard, and live world viewer
are implemented and under active development.

## Architecture

The execution boundary is deliberately narrow:

```text
owner chat / background director
            ↓
LLM decision → validated high-level tool → scheduler/task lease
                                              ↓
                                    deterministic skill
                                              ↓
                               Mineflayer world primitives
```

- `src/llm/` talks to the local llama.cpp HTTP server and validates decisions.
- `src/tools/` registers the only high-level actions the model may select.
- `src/agent/` owns scheduling, task dispatch, persistent goals, bootstrap,
  background maintenance, connection recovery, and watchdogs.
- `src/skills/` implements deterministic multi-step work such as resource
  collection, food gathering, storage, base building, combat/defense, torch
  production, delivery, and death recovery.
- `src/policy/` applies hard safety rules before dangerous actions.
- `src/memory/` persists tasks, goals, locations, storage, deaths, actions, and
  skill history in SQLite.
- `src/dashboard/` exposes read-only telemetry and a session-scoped Minecraft
  viewer. The browser cannot control the bot.

Safety/self-maintenance has priority over owner work, which has priority over
background work. Background maintenance keeps wood, food, fuel, and torches at
configured targets; an LLM director chooses optional idle work when survival
floors are healthy, with deterministic fallback behavior when the model is
unavailable.

## Current capabilities

- Persistent scheduler with queued, active, paused, blocked, completed, failed,
  and cancelled tasks.
- Resumable bootstrap from home through tools, food, bed, storage, furnace,
  fuel, torches, and opportunistic iron.
- Resource gathering, hunting/food collection, crafting and smelting, storage
  organization, delivery, navigation, defense, death recovery, and bounded
  base construction.
- Protected-home, health, lava, dimension, PvP, inventory, path, and timeout
  safeguards.
- Persistent autonomous goals and an anti-loop watchdog for repeatedly failing
  actions.
- Four bounded terrain project tools: `clear_area`, `flatten_area`,
  `excavate_volume`, and `dig_mineshaft`. Each freezes exact world geometry,
  resumes through the scheduler, and verifies the observed Minecraft result.
- Structured logs, terminal dashboard, local SQLite state, and reconnect-safe
  operation.

Terrain operations are intentionally conservative. Requests are limited to
small rectangular regions and an excavation volume of at most 8,192 blocks.
Unknown cells, water, lava, falling blocks, unbreakable blocks, protected
fixtures, unsafe access geometry, and lost return routes block the project
instead of being guessed through. Mineshafts are descending stair corridors,
not vertical shafts, and completion requires a verified route in both
directions. Inventory pressure, tool replacement, survival interrupts,
disconnects, death, and owner cancellation checkpoint the project; cancellation
revokes its bounded destructive authorization and does not automatically restart
it.

## Run locally

Requirements: Node.js 20+, a reachable Minecraft Java server, and a local
llama.cpp server.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start llama.cpp, or use another compatible OpenAI-style local endpoint:

   ```bash
   npm run llm
   ```

3. Edit [`config/minecraft.yaml`](config/minecraft.yaml). At minimum, set the
   Minecraft server, username, owner, home coordinates, and `llm.base_url`.

4. Start CobbleBob:

   ```bash
   npm start
   ```

On first connection, the bot resumes or runs its persisted bootstrap. State is
stored in `data/blockhead.db`; application logs are written under `logs/`.

## Dashboard and viewer

The read-only dashboard is enabled by default and listens on `0.0.0.0:3000`:

- `http://<host>:3000/` — live dashboard
- `http://<host>:3000/api/state` — JSON snapshot
- `ws://<host>:3000/ws` — snapshot stream
- `http://<host>:3000/health` — health check

When a Minecraft session is connected, the viewer is available on port 3001
using the dashboard as its WebSocket proxy. Configure both services under the
`dashboard` section. Disable the dashboard with `dashboard.enabled: false`.

The older local status endpoint defaults to `127.0.0.1:8155`; it provides a
small machine-readable process/task health snapshot.

## Tests and type checking

```bash
npm test
npm run typecheck
```

## Deployment

For the actual Maia layout, update procedure, and service commands, see
[`docs/deployment-maia.md`](docs/deployment-maia.md).

Additional design notes and call graphs are in [`docs/`](docs/).

## Configuration and prompts

The single configuration file is [`config/minecraft.yaml`](config/minecraft.yaml)
and is validated with Zod at startup. Prompt assets live in [`prompts/`](prompts/)
and have built-in fallbacks, so local model behavior can be tuned without
changing the TypeScript decision pipeline.
