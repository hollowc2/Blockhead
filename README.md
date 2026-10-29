<p align="center">
  <img src="logo.jpg" alt="Blockhead" width="720">
</p>

# Blockhead — CobbleBob, an autonomous Minecraft companion

A TypeScript/Mineflayer agent that joins a Minecraft Java server as CobbleBob.
A local llama.cpp model reads owner chat and picks from a fixed set of
high-level tools; deterministic skills and Mineflayer code do the actual work.
It is a working end-to-end prototype under active development.

## How it works

```text
owner chat / background director
            ↓
LLM decision → validated tool → scheduler / task lease
                                      ↓
                              deterministic skill
                                      ↓
                          Mineflayer world primitives
```

The model never emits code, commands, or block coordinates — only a validated
tool call. Priority is safety/self-maintenance > owner work > background work.
Background maintenance keeps wood, food, fuel, and torches at target levels; an
LLM director proposes idle work, with deterministic fallbacks if the model is
down.

| Path | Role |
| --- | --- |
| `src/llm/` | llama.cpp client, prompt/context building, decision validation |
| `src/tools/` | Registry of actions the model may select |
| `src/agent/` | Scheduler, task dispatch, goals, bootstrap, maintenance, survival interrupts, watchdog, reconnects |
| `src/skills/` | Multi-step work: gathering, food, crafting/smelting, storage, building, combat, delivery, death recovery |
| `src/building/` | Declarative `BuildingDesign` schema, validation, templates, compiler |
| `src/terrain/` | Terrain geometry, classification, verified block mutation |
| `src/minecraft/` | Mineflayer wrappers: movement, inventory, containers, world, creative mode |
| `src/policy/` | Hard safety rules checked before dangerous actions |
| `src/memory/` | SQLite persistence: tasks, goals, projects, locations, storage, deaths, skills |
| `src/dashboard/`, `src/tui/`, `src/status/` | Private dashboard/owner shell, redacted public viewer, terminal UI, status/operator endpoint |

## Capabilities

- Persistent, resumable tasks and goals (queued → active/paused/blocked → done/failed/cancelled).
- Resumable bootstrap: tools, food, bed, storage, furnace, fuel, torches, opportunistic iron.
- Gathering, hunting, crafting, smelting, storage organization, delivery,
  following, navigation, defense, and death-item recovery.
- Building: `build_structure` for simple rooms/walls/towers, `build_design` for
  compiled, resumable architectural designs (see [docs/building-architecture.md](docs/building-architecture.md)).
- Terrain projects: `clear_area`, `flatten_area`, `excavate_volume` (≤ 8,192
  blocks), and `dig_mineshaft` (stair corridor). Geometry is frozen up front,
  progress checkpoints through interrupts, and results are verified in-world.
  Water, lava, falling/unbreakable blocks, protected fixtures, or unsafe access
  block the project rather than being guessed through.
- Safeguards for the protected home, health, lava, dimensions, PvP, inventory,
  pathing, and timeouts, plus an anti-loop watchdog for repeated failures.

## Run locally

Requirements: Node.js 20.3+ (AbortSignal.any support), a Minecraft Java server, and a llama.cpp (or other
OpenAI-compatible) endpoint.

```bash
npm install
```

```bash
npm run llm
```

Edit [`config/minecraft.yaml`](config/minecraft.yaml) — at minimum the server,
username, owner, home coordinates, and `llm.base_url` — then:

```bash
npm start
```

State lives in `data/blockhead.db`, logs in `logs/`. Config is validated with
Zod at startup; prompts in [`prompts/`](prompts/) can be tuned without code
changes (built-in fallbacks exist).

## Dashboard, viewer, and TUI

Configured under `dashboard`. The private shell supports owner commands, jobs, maps
and build previews and must be restricted to trusted owners. The public viewer
projects redacted state and world geometry. Optional Q&A has no tools; optional
gestures use deterministic safety gates and remain disabled unless explicitly
configured. Browser interfaces are not all read-only.

| Service | Default | Notes |
| --- | --- | --- |
| Dashboard | `127.0.0.1:3000` | `/`, `/api/state`, `/ws`, `/health` |
| World viewer | `127.0.0.1:3001` | Live prismarine-viewer while connected |
| Public viewer | `:3003`, off | Redacted, loopback-only, for Tailscale Funnel (`dashboard.public_viewer`) |
| Status endpoint | `127.0.0.1:8155` | Private process/task health; authenticated operator CLI |

A terminal dashboard runs when stdout is a TTY (`tui.enabled`).

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

`npm run creative:smoke` is an optional live check against a disposable
creative server (see [docs/creative-provisioning.md](docs/creative-provisioning.md)).

## Docs

- [docs/deployment-maia.md](docs/deployment-maia.md) — deployment and service commands
- [docs/building-architecture.md](docs/building-architecture.md) — declarative building pipeline
- [docs/world-action-call-graph.md](docs/world-action-call-graph.md) — world action call graph
- [docs/creative-provisioning.md](docs/creative-provisioning.md) — creative material provisioning

## Public boundary and operator access

The raw renderer binds to loopback (`viewer_port + 1`), the public shell to
loopback (`public_viewer.port`), and only the redacted public shell may be
published through Funnel. Private dashboard/shell/status, Minecraft, model,
and firewall administration listeners must remain isolated. Tailnet membership
alone does not establish owner authority. The public shell trusts only the
last forwarding address appended by the loopback proxy; confirm the real
proxy overwrites/appends this field before launch. Direct public access to the
raw viewer would bypass this trust boundary.

Local `/command` and `/public-interactions` require a bearer secret of at least
32 characters in `BLOCKHEAD_OPERATOR_TOKEN` and refuse browser Origin/Fetch
Metadata headers. Missing secrets fail closed; `/health` and `/status` remain
read-only private endpoints. Use a protected systemd EnvironmentFile and
`scripts/operator-request.py`; never place a secret in URLs, assets, config
committed to Git, or logs. This candidate requires an intentional operator
credential/tooling migration before deployment.

Public questions see only allowlisted facts and go through the configured
model firewall. Moderation and model prose are not deterministic guarantees;
model errors never trigger a direct-backend retry. Cancellation aborts queued
work and active HTTP transports, but backend compute cancellation still needs
external verification. Offline Minecraft authentication trusts player names:
network isolation is required to prevent owner impersonation.

See [public security evidence and migration](docs/public-viewer-security.md).
`npm run test:public` runs public boundary regressions; `npm run check` runs
local checks; `npm run audit:production` rejects new advisories and documents
one reviewed upstream UUID exception rather than silently ignoring it.

Public visitors can choose **3D** or **Lightweight**. Lightweight loads status,
vitals, story and Q&A without a renderer seat. Pause releases 3D immediately;
a hidden tab releases it after 60 seconds and fetches fresh state on return.
Visible watchers keep their seat without clicking. Full viewers retain status
and get three bounded retries plus a manual retry. The API/bot connection pill
and actual 3D connection state are separate. The public status shell remains
available before the first Minecraft connection and between bot reconnects. Q&A history is bounded to eight
turns in the current tab, rendered as text and cleared on reload; only the
viewing/help preference is stored. See [viewer behavior and local checks](docs/public-viewer-experience.md).

[Launch assessment and deployment/rollback plan](docs/public-viewer-launch-readiness.md)
records the local evidence and outstanding deployment gates. No live rollout is
approved by the local checks alone.
