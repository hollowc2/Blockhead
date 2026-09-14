<p align="center">
  <img src="logo.jpg" alt="Blockhead" width="720">
</p>

# Blockhead — CobbleBob, an autonomous Minecraft companion

A TypeScript/Mineflayer bot whose decisions come from a local LLM (llama.cpp).
Three strict layers:

1. **LLM tool layer** — the model only picks registered high-level tools
   (`src/tools/`). It never controls movement, pathfinding, inventory slots,
   or combat directly.
2. **Skill layer** — deterministic multi-step runners (`src/skills/`: collect,
   hunt, ensure_item, craft/smelt, defense, storage, death recovery) that
   handle the mechanics and record SkillSuccess entries in SQLite.
3. **Primitive layer** — mineflayer plugins + thin wrappers (`src/minecraft/`).

The scheduler (`src/agent/scheduler.ts`) owns priority, pause/resume, and
preemption; the policy layer (`src/policy/`) hard-vetoes unsafe proposals
(protected regions, health retreats, straight-down digs, lava entry, player
attacks, unauthorized dimensions) with structured error codes.

## Run

### 1. Start the local model (llama.cpp server)

```bash
npm run llm            # or any llama.cpp server on http://127.0.0.1:8080
```

The default model is a small GGUF (e.g. Qwen3 8B, 4-bit). Point
`llm.base_url` in `config/minecraft.yaml` at your server.

### 2. Configure the world

Edit `config/minecraft.yaml`: server host/port, the `home` coordinate, and
`agent.owner`. All keys are Zod-validated against `src/config/schema.ts` at
startup; sections are documented in the file (agent/behavior, minecraft,
policy, bootstrap/background, items).

### 3. Run the bot

```bash
npm install
npm start
```

CobbleBob connects (retrying with backoff), runs bootstrap on first spawn
(home → wood → tools → food → bed → storage → furnace → fuel → torches →
iron), then maintains stockpiles in the background and answers the owner's
chat instructions through the LLM.

## Tests

```bash
npm test               # unit tests (node:test)
npm run typecheck      # strict TypeScript
```

## Prompts

`prompts/system.md`, `prompts/decision.md`, and `prompts/idle-proposal.md`
are loaded at startup (with built-in fallbacks) — keep them short and strict
for local models.