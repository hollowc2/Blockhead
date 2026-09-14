# Blockhead

## AI-Powered Minecraft Agent

**Blockhead** is an experimental Minecraft agent that uses a locally hosted LLM as its decision-making system and Mineflayer as its interface to Minecraft.

The initial goal is to create an autonomous Minecraft companion, tentatively named **Cyrus**, that can join a Minecraft Java server as another player, observe its surroundings, receive natural-language instructions, plan tasks, and execute those tasks in-game.

Example:

> "Cyrus, go get me two stacks of oak logs and bring them back."

Rather than having the LLM directly control individual key presses, Blockhead will expose higher-level Minecraft actions to the model. The LLM decides **what to do**, while deterministic code handles **how to do it**.

---

# Hardware Target

Initial LLM host:

- NVIDIA GTX 1070 Ti
- 8 GB VRAM
- Linux
- Local inference only

The project should be designed around relatively small, fast models rather than requiring a large frontier-scale model.

A strong initial candidate is:

- **Qwen3 8B**
- GGUF format
- 4-bit quantization
- Served using `llama.cpp`

The exact model should remain swappable.

---

# Tech Stack

## Minecraft Interface

### Mineflayer

Mineflayer is a Node.js library for creating Minecraft bots.

It provides the bot's "body."

Responsibilities include:

- Connecting to a Minecraft Java server
- Reading player position
- Reading nearby blocks
- Reading nearby entities
- Inventory management
- Movement
- Mining
- Placing blocks
- Crafting
- Combat
- Chat
- Interacting with containers
- Equipping items

Mineflayer itself is not AI.

It provides the APIs that Blockhead's agent can use to interact with Minecraft.

Useful Mineflayer ecosystem packages may include:

- `mineflayer`
- `mineflayer-pathfinder`
- `minecraft-data`

Additional plugins can be introduced as needed.

---

# LLM

## llama.cpp

`llama.cpp` will run the local language model.

Ideally, run the llama.cpp HTTP server so Blockhead does not need to manage inference directly.

Conceptually:

```text
Qwen3 8B
    │
    ▼
llama.cpp
    │
    │ HTTP
    ▼
Blockhead Agent
```

This keeps the model infrastructure independent from the Minecraft implementation.

The model can therefore be replaced later without rewriting the Minecraft code.

---

# Architecture

The basic architecture is:

```text
                     ┌──────────────────────┐
                     │       Minecraft      │
                     │     Java Server      │
                     └──────────┬───────────┘
                                │
                                │ Minecraft Protocol
                                ▼
                     ┌──────────────────────┐
                     │      Mineflayer      │
                     │                      │
                     │   "Cyrus's body"     │
                     └──────────┬───────────┘
                                │
                         observations/actions
                                │
                                ▼
                     ┌──────────────────────┐
                     │   Blockhead Agent    │
                     │                      │
                     │ state / tools / plan │
                     └──────────┬───────────┘
                                │
                                │ HTTP
                                ▼
                     ┌──────────────────────┐
                     │      llama.cpp       │
                     │                      │
                     │      Qwen3 8B        │
                     │   "Cyrus's brain"    │
                     └──────────────────────┘
```

---

# Design Principle

The LLM should **not** control Minecraft one keystroke at a time.

Bad approach:

```text
press W
press W
turn left
press W
jump
look right
```

This would be slow, expensive, unreliable, and extremely sensitive to model latency.

Instead, Blockhead should expose high-level tools.

For example:

```text
follow_player("Corey")

move_to(x, y, z)

find_block("oak_log", radius=64)

collect_block("oak_log", count=32)

craft("crafting_table", count=1)

equip("iron_sword")

attack(entity_id)

return_to_player("Corey")
```

The model decides which tool to call.

Mineflayer performs the actual movement and game interaction.

---

# Intended Agent Loop

The core loop should roughly work like this:

```text
Observe
   ↓
Build compact world state
   ↓
Send state + objective to LLM
   ↓
LLM reasons about next action
   ↓
LLM selects tool
   ↓
Validate tool call
   ↓
Mineflayer executes action
   ↓
Return result
   ↓
Update state
   ↓
Repeat
```

For example:

```text
User:
"Cyrus, get me 32 oak logs."

        ↓

Agent:
Need oak logs.

        ↓

Tool:
find_block("oak_log")

        ↓

Mineflayer:
Oak tree found at X/Y/Z.

        ↓

Tool:
move_to(X, Y, Z)

        ↓

Tool:
collect_block("oak_log", 32)

        ↓

Agent:
Objective complete.

        ↓

Tool:
return_to_player("Corey")
```

---

# Proposed Repository Structure

```text
blockhead/
│
├── README.md
├── package.json
├── .gitignore
├── .env.example
│
├── src/
│   │
│   ├── index.js
│   │
│   ├── minecraft/
│   │   ├── bot.js
│   │   ├── movement.js
│   │   ├── perception.js
│   │   ├── inventory.js
│   │   ├── mining.js
│   │   ├── crafting.js
│   │   └── combat.js
│   │
│   ├── agent/
│   │   ├── agent.js
│   │   ├── prompt.js
│   │   ├── state.js
│   │   ├── planner.js
│   │   └── memory.js
│   │
│   ├── llm/
│   │   └── llamacpp.js
│   │
│   └── tools/
│       ├── registry.js
│       ├── movement.js
│       ├── resources.js
│       ├── inventory.js
│       └── combat.js
│
├── config/
│   ├── agent.json
│   └── minecraft.json
│
├── prompts/
│   ├── system.md
│   └── planning.md
│
├── scripts/
│   ├── start-llm.sh
│   └── start-bot.sh
│
└── tests/
```

This structure can change as the project develops.

Do not over-engineer the first version.

---

# Phase 1 — Connect Cyrus

Goal:

**Get a Mineflayer bot into the Minecraft world.**

Requirements:

1. Create Node.js project.
2. Install Mineflayer.
3. Configure Minecraft server address.
4. Connect bot.
5. Spawn successfully.
6. Print basic world state.
7. Receive/send Minecraft chat messages.

Success condition:

```text
Corey joins server.

Cyrus joins server.

Corey:
"Cyrus?"

Cyrus:
"Yep."
```

No LLM is necessary yet.

---

# Phase 2 — Movement

Add `mineflayer-pathfinder`.

Implement basic deterministic actions:

```text
follow_player()
stop_following()
move_to()
look_at()
come_here()
```

Initial milestone:

> Cyrus can follow the player around without an LLM.

This verifies the Minecraft control layer independently of the AI.

---

# Phase 3 — llama.cpp Connection

Run Qwen locally using the llama.cpp server.

Blockhead sends requests to the local API.

Example:

```text
Minecraft chat
      ↓
Blockhead
      ↓
llama.cpp
      ↓
Qwen
      ↓
response
      ↓
Minecraft chat
```

Initial milestone:

```text
Corey:
"Cyrus, what are you doing?"

Cyrus:
"Following you."
```

---

# Phase 4 — Tool Calling

Introduce structured actions.

Example tool schema concept:

```json
{
  "tool": "follow_player",
  "arguments": {
    "player": "Corey"
  }
}
```

Blockhead validates the action and executes it.

Important rule:

**Never execute arbitrary JavaScript generated by the model.**

The model may only invoke registered tools.

This gives us a controlled boundary between the LLM and the game.

---

# Phase 5 — Perception

Build a compact representation of Cyrus's environment.

Possible state:

```text
Position:
X: 241
Y: 68
Z: -117

Health:
18/20

Hunger:
17/20

Nearby players:
Corey - 11 blocks

Nearby entities:
Zombie - 14 blocks
Cow - 8 blocks

Nearby useful blocks:
Oak Log - 21
Stone - 184
Coal Ore - 4

Inventory:
Oak Log x12
Iron Pickaxe x1
Bread x7
Torch x19
```

Do **not** dump enormous amounts of raw world information into the LLM.

The perception layer should summarize the world into information relevant to decision making.

---

# Phase 6 — Resource Gathering

First major autonomous task:

> "Cyrus, go get wood."

Then:

> "Cyrus, get 32 oak logs."

Then:

> "Cyrus, get two stacks of oak logs and bring them back."

This introduces:

- Resource searching
- Navigation
- Mining
- Inventory tracking
- Task completion detection
- Returning to the player

This should be the first genuinely useful autonomous behavior.

---

# Phase 7 — Planning

Once individual actions work reliably, allow multi-step objectives.

Example:

> "Cyrus, make me an iron pickaxe."

The model might generate:

```text
Need:
3 iron ingots
2 sticks

Check inventory.

If iron missing:
    locate iron
    mine iron
    smelt iron

If sticks missing:
    collect wood
    craft planks
    craft sticks

Locate/use crafting table.

Craft iron pickaxe.

Return to Corey.
```

The LLM handles planning.

Mineflayer handles execution.

---

# Phase 8 — Memory

Eventually Cyrus should remember useful world information.

Examples:

```text
home = X/Y/Z

main_mine = X/Y/Z

nether_portal = X/Y/Z

village = X/Y/Z

storage_room = X/Y/Z
```

Memory should initially be structured rather than trying to rely entirely on LLM context.

Potential storage:

- JSON
- SQLite

SQLite is probably preferable once memory becomes substantial.

---

# Phase 9 — Companion Behavior

Once autonomous tasks work, Cyrus can become more like a persistent companion.

Potential commands:

```text
"Cyrus, follow me."

"Cyrus, wait here."

"Cyrus, go home."

"Cyrus, bring me food."

"Cyrus, grab two stacks of wood."

"Cyrus, help me mine."

"Cyrus, guard the entrance."

"Cyrus, dump everything except tools into the chest."

"Cyrus, where did we leave the boat?"

"Cyrus, find the Nether portal."

"Cyrus, come rescue me."
```

Eventually some behavior could happen without explicit commands.

Example:

```text
Corey health: 4/20
Zombie nearby: 3 blocks
Cyrus has sword

→ defend Corey
```

But autonomous behaviors should come **after** explicit tool-driven commands are reliable.

---

# Safety / Reliability Layer

Because an LLM can make stupid decisions, the Minecraft layer should enforce basic constraints.

Examples:

```text
Do not dig straight down.

Do not walk into lava.

Do not attack the owner.

Do not discard valuable equipment.

Do not destroy designated structures.

Do not consume rare items without permission.

Do not enter the Nether unless permitted.

Do not execute arbitrary generated code.
```

The model proposes actions.

Blockhead decides whether those actions are legal.

---

# Logging

Every agent decision should be logged.

Example:

```text
[14:21:03] USER: get 32 oak logs

[14:21:04] AGENT:
Objective = collect oak_log x32

[14:21:04] TOOL:
find_block(oak_log)

[14:21:05] RESULT:
found oak_log at 238, 71, -102

[14:21:05] TOOL:
move_to(238, 71, -102)

[14:21:19] RESULT:
arrived

[14:21:20] TOOL:
collect_block(oak_log, 32)
```

This will make debugging dramatically easier.

---

# Development Dashboard

A terminal dashboard (Phase 12, spec 33) shows what CobbleBob is doing and
why, without reading raw logs. Enabled by default when stdout is a TTY
(`tui.enabled` in `config/minecraft.yaml`); it owns the terminal, so while it
runs, pino's console echo is silenced and both log files keep recording:

- `logs/blockhead.log` — human-readable lines (`HH:MM:SS LEVEL message`)
- `logs/blockhead-debug.jsonl` — detailed events, including the exact state
  snapshot sent to the LLM for every decision

Panels: STATE (health, hunger, position, dimension, time, danger score),
TASK (active / paused / interrupted), BACKGROUND (stockpiles and activity),
ACTION (current skill), INVENTORY (tools, food, torches, key resources),
LLM (model, endpoint, last-call age, latency, last tool, rationale), and an
EVENT feed (hostiles, task transitions, gathers, expedition, deaths).

Nothing in the dashboard can control the bot: Minecraft chat remains the
command interface. Kill it with Ctrl+C (`SIGINT` restores the terminal).

---

# Initial Model

Start with:

**Qwen3 8B, 4-bit GGUF**

running through:

**llama.cpp**

on:

**GTX 1070 Ti 8 GB**

The model should only be responsible for:

- Understanding instructions
- Selecting goals
- Planning
- Selecting tools
- Responding conversationally

It should **not** perform:

- Pathfinding
- Collision detection
- Individual movement inputs
- Mining timing
- Inventory mechanics
- Minecraft protocol handling

Those belong in deterministic code.

This division is what makes a relatively small local model viable.

---

# First Development Target

Do not start by trying to build a fully autonomous Minecraft AI.

Build this:

```text
Corey:
"Cyrus, follow me."

Cyrus:
"Coming."

[Cyrus walks over and follows Corey.]
```

Then:

```text
Corey:
"Cyrus, stop."

[Cyrus stops.]
```

Then:

```text
Corey:
"Cyrus, come here."

[Cyrus walks to Corey.]
```

Once those three commands are rock solid, connect the LLM.

After that, the first serious autonomous objective should be:

```text
"Cyrus, get me 32 oak logs."
```

If Blockhead can reliably accomplish that from an arbitrary starting position, the core architecture works.

---

# Long-Term Vision

Blockhead should eventually allow a local LLM-controlled player to exist alongside human players as a persistent Minecraft companion.

The model provides reasoning and personality.

Mineflayer provides embodiment.

Minecraft provides the world.

The interesting problem is not:

> "Can an LLM play Minecraft?"

It is:

> **"How little world information and how small a toolset can we give a local model while still allowing it to behave like an intelligent Minecraft companion?"**

That is the experiment.
