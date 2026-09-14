# Blockhead v2 Implementation Specification

## AI-Powered Autonomous Minecraft Companion

**Project name:** Blockhead  
**Initial agent name:** CobbleBob  
**Status:** Implementation specification (integrated updates)  
**Primary game target:** Minecraft Java Edition, private/offline server  
**Primary runtime host:** Maia  
**Minecraft server host:** Eros  
**LLM runtime:** llama.cpp HTTP server  
**Minecraft interface:** Mineflayer  
**Application language:** TypeScript on Node.js  
**Persistence:** SQLite

---

# 1. Purpose

Blockhead is an experimental autonomous Minecraft companion system.

The initial agent, **CobbleBob**, joins a private Minecraft Java server as another player, observes the world, receives natural-language instructions through Minecraft chat, chooses high-level actions, and executes those actions through deterministic Minecraft code.

The core design principle is:

> **The language model decides what CobbleBob should do. Deterministic code decides how Minecraft mechanics are performed.**

The LLM must not control keypresses, pathfinding ticks, mining timing, collision handling, crafting slot placement, or protocol details.

Instead, the model operates through a constrained set of high-level tools such as:

```text
collect_resource("oak_log", 64)
ensure_item("iron_pickaxe", 1)
go_home()
follow_player("Corey")
organize_storage()
hunt("cow", 4)
```

Mineflayer, pathfinding code, inventory logic, crafting logic, and skill-specific deterministic code implement those requests.

The project is intended to answer a practical experimental question:

> **How little world information and how small a high-level toolset can a local LLM use while still behaving like a competent, persistent Minecraft companion?**

---

# 2. Initial Deployment Environment

## 2.1 Minecraft Server

The initial Minecraft environment is a private local Minecraft Java server running on **Eros**.

The first development environment should assume:

- Private server
- Offline/private authentication is acceptable
- No public internet-facing deployment requirement
- CobbleBob joins as a normal Mineflayer-controlled player
- No player-versus-player behavior
- One primary human owner/operator
- Additional human players may exist later, but command permissions can be added after the initial version

## 2.2 Blockhead Host

Blockhead runs on **Maia**.

Initial process layout:

```text
Eros
└── Minecraft Java Server

Maia
├── llama-server
│   └── local GGUF model
└── blockhead
    └── TypeScript / Node.js application
```

The Minecraft server and AI system remain independent.

The Blockhead process connects to:

1. Eros using the Minecraft protocol through Mineflayer.
2. The local llama.cpp HTTP server through an HTTP API.

## 2.3 LLM

The exact model must remain replaceable.

The system should not depend on model-specific features that prevent substitution.

The LLM is responsible for:

- Interpreting natural-language instructions
- Selecting the current goal
- Selecting the next high-level skill/tool
- Resolving ambiguous but low-risk choices
- Choosing among available goals
- Producing short player-facing status messages when appropriate
- Optionally proposing useful background goals when the agent is fully idle

The LLM is not responsible for:

- Pathfinding
- Collision detection
- Direct movement inputs
- Block breaking timing
- Inventory slot mechanics
- Crafting grid manipulation
- Combat timing
- Minecraft protocol details
- Remembering world state solely through conversation context

---

# 3. Personality and Communication Style

CobbleBob is a worker first and a conversational character second.

The default personality should be:

- Minimal
- Task-oriented
- Calm
- Brief
- Non-chatty

Examples:

```text
Corey: CobbleBob, get 64 oak logs.
CobbleBob: Okay.
```

```text
CobbleBob: No oak within 128 blocks. Expanding search.
```

```text
CobbleBob: Pickaxe broke. Replacing it.
```

```text
CobbleBob: Done.
```

CobbleBob should not continuously narrate normal actions.

He should speak when:

- A task is accepted
- A search radius materially expands
- A task cannot currently proceed
- A maintenance problem interrupts a task
- He dies
- Recovery fails
- A task completes
- The user directly asks a question

---

# 4. Core Operating Model

CobbleBob should almost always have useful work available.

Behavior is organized into three priority layers:

```text
1. Safety / self-maintenance
2. Foreground task
3. Background task
```

## 4.1 Safety / Self-Maintenance

Self-maintenance temporarily interrupts other work when required.

Examples:

- Eat when hunger falls below threshold
- Retreat when health becomes unsafe
- Replace broken or nearly broken essential tools
- Acquire food when reserves are low
- Craft torches when reserves are low
- Recover death drops when feasible
- Sleep at night when conditions allow

Most self-maintenance behavior should be deterministic policy rather than LLM improvisation.

## 4.2 Foreground Task

A foreground task is a direct user instruction.

Examples:

```text
Get me 64 oak logs.
Bring me food.
Make an iron pickaxe.
Come here.
Find a village.
```

Foreground tasks normally outrank background work.

## 4.3 Background Task

When no foreground task is active, CobbleBob maintains useful stockpiles and infrastructure.

Initial background stockpile targets:

```text
Wood:           64
Food:           64
Coal/Charcoal:  64
Torches:        64
```

Iron is useful but not mandatory for the initial maintenance target.

When core stockpiles are healthy, CobbleBob may:

- Organize storage
- Upgrade equipment
- Gather opportunistic iron
- Improve basic infrastructure
- Perform safe useful housekeeping work

### 4.3.1 Background Decision Director (LLM)

When the scheduler has no foreground task and no stockpile is below its survival floor, the background director calls the LLM to choose the next background task from the dispatcher-capable vocabulary (`collect_resource`, `stockpile_maintenance`, `organize_storage`, `go_home`, `wait`):

> Choose exactly one task. Survival floors are handled by code, not by you. Address listed shortages before optional work. Food is the top priority shortage; do not blindly repeat a restore that recently failed. When nothing useful remains, choose wait. Return only valid JSON.

The model decides what to do next; deterministic code decides how and vetoes unsafe picks (a directed restore for a kind cooling down after failure, or with no real deficit, is skipped). The call interval is throttled (default 60s) and the model's `wait` is honored for the whole window. When the model is disabled or unreachable, the deterministic shortage-then-storage ladder keeps the bot working. This turns idle time into productive autonomous behavior without free-roaming or unconstrained planning.

---

# 5. Task Scheduler

The scheduler is the central behavior coordinator.

It decides what CobbleBob should currently be doing.

## 5.1 Task States

```ts
export enum TaskStatus {
  QUEUED = "queued",
  ACTIVE = "active",
  PAUSED = "paused",
  BLOCKED = "blocked",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled"
}
```

## 5.2 Task Priorities

```ts
export enum TaskPriority {
  EMERGENCY = 100,
  INTERRUPT = 90,
  MAINTENANCE = 80,
  FOREGROUND = 70,
  BACKGROUND = 40,
  OPTIONAL = 20
}
```

Suggested interpretation:

```text
100 Emergency
    Death recovery, immediate survival

90  Interrupt
    stop, come here, follow, wait

80  Maintenance
    food, health, equipment, torches

70  Foreground
    direct user-requested task

40  Background
    stockpile maintenance

20  Optional
    organization, gear improvement, opportunistic gathering
```

## 5.3 Task Model

```ts
export interface Task {
  id: string;
  type: string;
  priority: TaskPriority;
  source: "user" | "system" | "maintenance" | "background" | "idle_proposal";
  objective: string;
  parameters: Record<string, unknown>;
  status: TaskStatus;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  parentTaskId?: string;
  interruptedTaskId?: string;

  resumeState?: Record<string, unknown>;
  lastError?: string;
}
```

## 5.4 Interruption Behavior

Tasks are normally **paused**, not discarded.

Example:

```text
Background:
Maintain wood stockpile.

User:
"Get 32 iron ore."

Background pauses.
Foreground iron task begins.

Food reserve falls below minimum.
Iron task pauses.
Maintenance task acquires food.

Food restored.
Iron task resumes.

Iron task completes.
Background stockpile task resumes.
```

---

# 6. Immediate Chat Interrupts

Some commands should bypass normal LLM planning when recognized confidently.

Initial immediate commands:

```text
stop
come here
follow me
wait here
go home
help me
```

Two interruption types should exist.

## 6.1 Soft Interrupt

The current task is paused and may resume later.

Examples:

```text
come here
follow me
wait here
```

## 6.2 Hard Interrupt

The current task is cancelled.

Example:

```text
stop what you're doing
cancel that
forget that task
```

The exact natural-language matching can initially be conservative.

If a command cannot be confidently recognized deterministically, it can be passed to the LLM.

---

# 7. Bootstrap Mode

CobbleBob must support starting in a brand-new world with no equipment.

A configured coordinate is provided as the initial home location.

The bootstrap process should be a known state machine rather than an entirely LLM-invented plan.

## 7.1 Bootstrap Goals

```text
1. Reach/configure home coordinate.
2. Gather wood.
3. Craft crafting table.
4. Craft starter wooden tools as needed.
5. Gather stone.
6. Upgrade to stone tools.
7. Hunt food.
8. Find sheep.
9. Acquire wool.
10. Craft a bed.
11. Place bed at home.
12. Craft/place at least one chest.
13. Craft/place furnace.
14. Acquire coal or produce charcoal.
15. Produce torches.
16. Establish minimum stockpile behavior.
17. Opportunistically gather iron.
18. Automatically upgrade tools when iron permits.
19. Transition to normal autonomous operation.
```

## 7.2 Bootstrap State

```ts
export enum BootstrapStage {
  HOME = "home",
  WOOD = "wood",
  CRAFTING = "crafting",
  STONE_TOOLS = "stone_tools",
  FOOD = "food",
  WOOL = "wool",
  BED = "bed",
  STORAGE = "storage",
  FURNACE = "furnace",
  FUEL = "fuel",
  TORCHES = "torches",
  NORMAL_OPERATION = "normal_operation"
}
```

Bootstrap should be resumable after restart.

If CobbleBob later loses all useful equipment, selected portions of bootstrap logic can be reused as a recovery path.

---

# 8. Home and Protected Region

The initial home location is configured manually.

Example:

```yaml
home:
  x: 100
  y: 65
  z: -200
```

## 8.1 Protected Home Zone

Default:

```text
100 × 100 blocks
```

The size must be configurable.

A practical representation is a square centered on the configured home coordinate.

Example:

```yaml
home:
  protected_size_x: 100
  protected_size_z: 100
```

## 8.2 Protection Policy

Inside a protected home region:

Allowed by default:

- Open doors
- Use beds
- Use crafting tables
- Use furnaces
- Open containers
- Store items
- Retrieve items
- Place explicitly permitted infrastructure
- Place new storage when needed

Restricted by default:

- Breaking arbitrary structural blocks
- Destructive mining
- Fire placement
- Lava placement
- Unrequested demolition
- Rebuilding human-created structures

Outside protected regions, CobbleBob may freely:

- Mine
- Dig tunnels
- Create branch mines
- Cut trees
- Hunt
- Bridge gaps
- Place temporary blocks
- Modify natural terrain

Later versions may support commands such as:

```text
CobbleBob, protect this house.
CobbleBob, remember this area as the farm.
CobbleBob, allow mining here.
```

---

# 9. Day/Night Behavior

CobbleBob should automatically sleep when:

- It is night
- A valid bed is known and reachable
- Sleeping is possible
- He is the only player on the server, or server conditions otherwise allow sleeping without disrupting others
- No higher-priority emergency prevents it

If sleep is unavailable or inappropriate, nighttime changes task selection.

## 9.1 Safe Night Work

Examples:

- Crafting
- Smelting
- Storage organization
- Indoor maintenance
- Controlled underground mining
- Equipment preparation

## 9.2 Unsafe Night Work

Examples:

- Long surface expeditions
- Wandering through forests
- Unprotected long-distance resource gathering
- Low-value exploration through hostile terrain

Night should not force total inactivity.

It should influence risk policy.

---

# 10. Self-Maintenance System

Self-maintenance should be configuration-driven.

Example:

```yaml
maintenance:
  health_retreat_below: 8
  hunger_eat_below: 12
  minimum_food_reserve: 8
  minimum_torches_carried: 16
  durability_replace_below_percent: 15
```

The exact values should remain easy to tune.

## 10.1 Required Personal Equipment

Initial desired personal kit:

```text
Weapon
Pickaxe
Axe
Shovel
Food
Torches
Building blocks
```

Later:

```text
Iron armor
Shield
Bucket
Bow
Arrows
```

## 10.2 Automatic Tool Upgrades

CobbleBob should automatically upgrade essential tools when resources permit.

Progression:

```text
wood → stone → iron
```

Iron tools should be preferred once iron availability is sufficient.

Tool upgrades should not require explicit user permission.

## 10.3 Armor

CobbleBob should opportunistically work toward iron armor.

Armor is useful but should not block ordinary stockpile maintenance indefinitely.

---

# 11. Food Acquisition

Initial food acquisition should support hunting.

Examples:

```text
cow
pig
sheep
chicken
```

Hunting serves two purposes:

- Food
- Secondary useful drops such as leather or wool

Later systems may add:

- Crop farming
- Animal breeding
- Automated farm maintenance
- Fishing

These are not required for the first implementation.

---

# 12. Expedition System

Normal work should be geographically local when possible.

Default expedition threshold:

```text
256 blocks from home
```

The threshold must be configurable.

```yaml
navigation:
  expedition_threshold: 256
```

## 12.1 Before Entering Expedition Mode

CobbleBob should verify:

- Home coordinate is known
- Food reserve is sufficient
- Required tools exist
- Tool durability is acceptable
- Inventory has enough free space
- Current health is acceptable
- Return strategy exists

Potential future additions:

- Carry a bed
- Carry spare tools
- Carry extra food
- Carry a boat
- Carry a compass

## 12.2 Search Expansion

Searches should expand automatically rather than fail quickly.

Illustrative progression (skill-configurable):

```text
32
64
128
256
512
1024
...
```

Search radius is skill-dependent.

**Consistency rule:** Every gathering or search skill must use the same expansion contract and produce a short status message on each meaningful expansion.

Example:

```text
No oak within 128 blocks. Expanding search.
```

At 256 blocks from home, the system switches into expedition policy.

The expansion sequence, status message format, and radius limits should be part of the skill contract so behavior remains uniform across `collect_resource`, `hunt`, `search_for`, and similar skills.

---

# 13. Tool Hierarchy

Blockhead should use three conceptual layers.

```text
LLM Tools
   ↓
Skills
   ↓
Mineflayer Primitives
```

## 13.1 LLM Tool Layer

These are the actions the model can request.

Examples:

```text
collect_resource()
ensure_item()
travel_to()
hunt()
organize_storage()
go_home()
```

## 13.2 Skill Layer

Skills implement robust multi-step deterministic behavior.

Example:

```text
collect_resource("oak_log", 64)
```

may internally perform:

```text
check inventory
find known resource site
search nearby terrain
select reachable block
path to block
equip appropriate tool
mine
collect drops
handle obstacles
repeat
return structured result
```

The model does not need to make a new decision between every log block.

## 13.3 Primitive Layer

Mineflayer primitives include:

```text
goto
lookAt
dig
placeBlock
equip
attack
openContainer
closeWindow
craft
sleep
wake
toss
activateItem
```

These primitives should generally not be exposed directly to the LLM.

## 13.4 Recommended Mineflayer Plugins

The following plugins should be adopted early. They significantly reduce the amount of custom skill code required and improve reliability:

- `mineflayer-pathfinder` — mandatory for movement and navigation
- `mineflayer-collectblock` — robust block collection with tool selection and drop pickup
- `mineflayer-tool` — automatic best-tool selection
- `mineflayer-auto-eat` — deterministic hunger handling
- `mineflayer-armor-manager` — automatic armor equipping
- `mineflayer-pvp` — combat primitives for self-defense and hunting

Most high-level skills become thin, reliable wrappers around these plugins rather than re-implementing low-level Minecraft mechanics.

---

# 14. Initial High-Level Tool Set

## 14.1 Navigation

```text
come_to_player(player)
follow_player(player)
stop_following()
wait_here()
go_home()
travel_to(location)
explore(direction?, distance?)
```

## 14.2 Resources

```text
collect_resource(resource, quantity)
hunt(entity_type, quantity)
gather_food(quantity)
search_for(target)
```

## 14.3 Crafting and Acquisition

```text
craft_item(item, quantity)
ensure_item(item, quantity)
smelt_item(item, quantity)
upgrade_equipment()
```

`ensure_item()` is intentionally powerful.

Example:

```text
ensure_item("iron_pickaxe", 1)
```

The skill may discover prerequisites and satisfy them deterministically when possible.

## 14.4 Inventory and Storage

```text
store_items(filter?, location?)
retrieve_items(items, location?)
organize_storage()
create_storage(category?)
give_item(player, item, quantity)
```

## 14.5 World and Memory

```text
remember_location(name)
forget_location(name)
inspect_area()
find_location(name)
register_storage(category, location)
```

## 14.6 Combat

```text
defend_self()
defend_player(player)
hunt_target(entity_type)
```

Player-versus-player combat must remain disabled.

## 14.7 Utility

```text
sleep()
eat()
equip_best()
replace_equipment()
recover_death_items()
```

---

# 15. Natural-Language Command Processing

Initial commands arrive only through Minecraft chat.

The processing pipeline should be:

```text
chat event
↓
verify speaker/permission
↓
check immediate deterministic interrupt
↓
construct compact state
↓
send instruction + relevant context to LLM
↓
validate structured response
↓
create/update task
↓
scheduler activates task
```

The initial system may assume one trusted owner.

Permissions should nevertheless be represented in configuration so multiplayer control can be added later.

---

# 16. LLM Structured Output Contract

The model should return structured output rather than free-form tool instructions.

Recommended response concept:

```json
{
  "message": "Okay.",
  "decision": {
    "type": "tool",
    "tool": "collect_resource",
    "arguments": {
      "resource": "oak_log",
      "quantity": 64
    }
  },
  "rationale": "The user requested 64 oak logs."
}
```

The application must validate all model output.

Recommended validation library:

```text
Zod
```

Invalid tool calls must never execute.

Example TypeScript concept:

```ts
const AgentDecisionSchema = z.object({
  message: z.string().optional(),
  decision: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("tool"),
      tool: z.string(),
      arguments: z.record(z.unknown())
    }),
    z.object({
      type: z.literal("respond"),
      response: z.string()
    })
  ]),
  rationale: z.string().max(500).optional()
});
```

The rationale is a concise explicit explanation, not a requirement to store hidden chain-of-thought.

---

# 17. When the LLM Is Called

The LLM should not run continuously.

It is called when a high-level decision is needed.

Examples:

- New user instruction
- Current skill completes
- Current skill fails
- Current objective becomes impossible
- Significant environmental change alters the plan
- A foreground task finishes
- A blocked task becomes available
- A command is ambiguous
- Multiple useful background choices need prioritization
- Idle with no foreground task (the director picks the next background task)

The LLM should not be called for:

- Every pathfinding step
- Every mined block
- Every inventory update
- Every combat swing
- Every game tick
- Routine hunger eating when policy is obvious
- Simple known interrupts

This is essential for efficient local inference.

---

# 18. Event-Driven Architecture

Mineflayer events feed an internal event bus.

Concept:

```text
Minecraft / Mineflayer
        │
        ▼
     Event Bus
        │
        ├── chat.command
        ├── health.changed
        ├── hunger.low
        ├── damage.received
        ├── hostile.detected
        ├── inventory.changed
        ├── inventory.full
        ├── tool.low_durability
        ├── tool.broken
        ├── task.completed
        ├── task.failed
        ├── death
        ├── respawn
        ├── time.night
        └── time.day
             │
             ▼
       State Manager
             │
             ▼
         Scheduler
             │
        if decision needed
             ▼
            LLM
```

A lightweight typed internal event system is sufficient initially.

---

# 19. Perception and State

The model receives a compact synthesized world state. High-quality, low-token observation compression is critical for local model performance.

The perception layer must answer useful questions rather than dump raw data:

- What dangerous entities are nearby?
- What relevant resources are nearby?
- Is the target player nearby?
- Is the agent carrying enough supplies?
- Is there a known location that satisfies the current task?
- What is the current danger level?
- How full is inventory and are there critical shortages?

## 19.1 Enhanced State Object

Recommended structure (keep total tokens low):

```json
{
  "self": {
    "position": {"x": 241, "y": 68, "z": -117},
    "dimension": "overworld",
    "health": 18,
    "hunger": 17,
    "time": "day",
    "dangerScore": 0.3
  },
  "task": {
    "type": "collect_resource",
    "objective": "Collect 64 oak logs",
    "progress": "41/64",
    "lastError": null
  },
  "inventorySummary": {
    "oak_log": 41,
    "iron_pickaxe": 1,
    "bread": 7,
    "torch": 19,
    "freeSlots": 12,
    "pressure": "low"
  },
  "nearby": {
    "players": [{"name": "Corey", "distance": 11}],
    "hostiles": [{"type": "zombie", "distance": 14}],
    "resources": [{"type": "oak_log", "countApprox": 21, "nearestDistance": 18}]
  },
  "memory": {
    "homeDistance": 93,
    "nearestKnownStorage": "home_main_chest",
    "relevantResourceSites": [
      {"resource": "oak_log", "distance": 74, "confidence": 0.9}
    ]
  },
  "recentEvents": [
    "Tool durability low on iron_pickaxe",
    "Expanded search radius to 128"
  ]
}
```

Key enhancements over a minimal dump:

- Explicit **dangerScore** (derived from hostiles, distance, time of day, health/hunger)
- Inventory **pressure** and free-slot count
- Ranked known resource sites
- Short recent-events ring buffer (last 5–8 significant events)
- Current skill progress + last failure reason placed near the top

Do not send huge raw block scans.

---

# 20. Memory Model

Persistent memory uses SQLite.

Memory is scoped to:

```text
server
world
dimension
```

Coordinates without dimension identity are insufficient.

## 20.1 Memory Categories

Initial persistent memory should include:

```text
worlds
locations
protected_regions
storage_locations
resource_sites
danger_zones
tasks
task_events
death_events
known_players
settings
skill_successes
```

Later:

```text
structures
farms
portals
villages
mines
roads
boats
temporary_caches
```

## 20.2 Skill Library + Retrieval (Voyager-inspired)

When a skill succeeds (especially `collect_resource`, `ensure_item`, `hunt`, bootstrap stages, and similar multi-step skills), store a compact success record:

```ts
interface SkillSuccess {
  id: string;
  skillName: string;
  parameters: Record<string, unknown>;
  startingConditions: {
    biomeOrRegion?: string;
    inventorySummary: Record<string, number>;
    homeDistance: number;
    timeOfDay?: string;
  };
  outcome: {
    durationMs: number;
    interruptions: number;
    finalInventoryDelta: Record<string, number>;
  };
  description: string;          // short natural-language summary of what worked
  createdAt: string;
}
```

At decision time the system retrieves the 2–4 most relevant past successes (by skill name + parameter similarity + starting conditions) and injects them into the LLM context as few-shot examples.

This improves local model reliability without allowing the LLM to generate arbitrary code.

---

# 21. Proposed SQLite Schema

This is a practical starting schema, not a permanent final design.

## 21.1 worlds

```sql
CREATE TABLE worlds (
    id INTEGER PRIMARY KEY,
    server_key TEXT NOT NULL,
    world_key TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(server_key, world_key)
);
```

## 21.2 locations

```sql
CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id)
);
```

## 21.3 protected_regions

```sql
CREATE TABLE protected_regions (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    name TEXT NOT NULL,
    min_x INTEGER NOT NULL,
    max_x INTEGER NOT NULL,
    min_y INTEGER,
    max_y INTEGER,
    min_z INTEGER NOT NULL,
    max_z INTEGER NOT NULL,
    policy_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id)
);
```

## 21.4 storage_locations

```sql
CREATE TABLE storage_locations (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    z INTEGER NOT NULL,
    protected INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    metadata_json TEXT,
    FOREIGN KEY(world_id) REFERENCES worlds(id)
);
```

## 21.5 tasks

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    priority INTEGER NOT NULL,
    source TEXT NOT NULL,
    objective TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    status TEXT NOT NULL,
    resume_state_json TEXT,
    parent_task_id TEXT,
    interrupted_task_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);
```

## 21.6 task_events

```sql
CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

## 21.7 death_events

```sql
CREATE TABLE death_events (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    recovered INTEGER NOT NULL DEFAULT 0,
    recovery_failed_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id)
);
```

## 21.8 resource_sites

```sql
CREATE TABLE resource_sites (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    resource TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    depleted INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    FOREIGN KEY(world_id) REFERENCES worlds(id)
);
```

## 21.9 skill_successes

```sql
CREATE TABLE skill_successes (
    id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    starting_conditions_json TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_skill_successes_name ON skill_successes(skill_name);
```

---

# 22. Storage System

CobbleBob should create and maintain storage at home.

Initial behavior:

```text
if no chest exists:
    acquire wood
    craft chest
    place chest at home
    register chest in database
```

Storage categories may begin simple:

```text
general
food
wood
stone
ores
valuables
equipment
mob_drops
misc
```

The first implementation does not need one chest per category.

A single general chest is sufficient for bootstrap.

As capacity grows, `organize_storage()` can create more storage.

---

# 23. Delivery Behavior

When the user requests gathered resources:

```text
"Get me 32 oak logs."
```

Initial expected behavior:

```text
gather target resources
↓
return home
↓
locate designated delivery/general chest
↓
place requested resources into chest
↓
report completion
↓
resume previous background task
```

If no chest exists:

```text
craft chest
place at home
register chest
deposit items
```

The task should not require the human player to stand nearby waiting for delivery.

---

# 24. Item Value Policy

Item handling should be configuration-driven.

Suggested categories:

```text
critical
valuable
useful
common
expendable
```

## 24.1 Critical / Never Auto-Discard

Suggested initial set:

```text
diamond
diamond equipment
netherite scrap
netherite ingot
netherite equipment
ancient debris
elytra
totem of undying
enchanted golden apple
shulker box
dragon egg
nether star
beacon
heart of the sea
rare enchanted books
named/custom items
important maps
```

## 24.2 Valuable / Preserve

Suggested examples:

```text
emerald
gold ingot
iron ingot
lapis lazuli
redstone
ender pearl
blaze rod
ghast tear
echo shard
nautilus shell
saddle
horse armor
music disc
name tag
smithing template
potion
enchanted equipment
obsidian
```

## 24.3 Useful Bulk

Examples:

```text
coal
charcoal
raw iron
raw copper
raw gold
logs
planks
cobblestone
stone
food
leather
wool
string
bones
gunpowder
arrows
torches
```

## 24.4 Expendable

Examples:

```text
excess dirt
excess gravel
excess netherrack
rotten flesh
excess seeds
common flowers
badly damaged obsolete low-tier tools
```

## 24.5 Configuration Concept

```yaml
items:
  diamond:
    value: critical
    discard: never

  elytra:
    value: critical
    discard: never

  cobblestone:
    value: common
    discard: overflow

  dirt:
    value: expendable
    discard: allowed
```

The code should not hardcode every policy decision.

---

# 25. Combat Policy

Initial combat behavior:

- Self-defense is allowed
- Defending the owner is allowed
- Hunting animals for food is allowed
- Hunting hostile mobs may be added as a task
- Player combat is forbidden

The action validator must reject attacks on human players.

A future configuration option could permit explicit PvP environments, but PvP is out of scope for the initial system.

---

# 26. Death and Recovery

Death is an emergency event.

Workflow:

```text
death detected
↓
record position, dimension, time
↓
respawn
↓
pause ordinary tasks
↓
evaluate recovery feasibility
↓
prepare minimum recovery equipment if needed
↓
return to death location
↓
prioritize valuable equipment/items
↓
recover remaining items
↓
re-equip
↓
resume interrupted task if appropriate
```

If recovery is not feasible:

```text
mark death recovery failed
↓
rebuild essential equipment
↓
return to useful background operation
```

Death recovery should temporarily outrank foreground and background work because dropped items are time-sensitive.

Recovery should still respect basic survival checks.

### 26.1 Value-Aware Recovery Order

Item recovery order is driven by the item-value policy:

1. Critical items first
2. Valuable equipment and items
3. Useful bulk
4. Everything else

Also record *why* recovery failed (timeout, too dangerous, items despawned, path unreachable, etc.) so the LLM and future decisions can learn from the explicit failure reason.

### 26.2 Death-Loop Brake

Repeated deaths at the same site (e.g. respawning into fire/lava or a mob kill zone at spawn) put recovery into a futile loop: every sweep starts with `items_despawned` because the drops are destroyed the moment they fall. After three consecutive same-site deaths inside five minutes, recovery stands down for ten minutes:

- Further deaths at the site are recorded but enqueue no recovery trip.
- Background restores and idle proposals are gated off while the brake holds — wandering hunts feed the loop.
- The loop is surfaced once (log, state feed, TUI, `death.loop_detected`) with the site, the consecutive-death count, and the killer's name when mineflayer saw it (`entityHurt` source within 10s of death — e.g. "zombie" camped on the spawn).
- A death at a different site clears the brake; the brake also expires after ten minutes without a break.

Resolution is a user action (walk CobbleBob elsewhere, relocate the spawn, remove the hazard); the brake only stops the death machine and says so.

---

# 27. Resource Gathering Skill

`collect_resource()` is a central skill.

Example:

```text
collect_resource("oak_log", 64)
```

Suggested internal stages:

```text
1. Determine quantity already carried.
2. Determine remaining target.
3. Check known resource sites.
4. Search current radius.
5. Select reachable candidate.
6. Ensure required equipment.
7. Travel to candidate.
8. Gather resource.
9. Recalculate progress.
10. Handle full inventory.
11. Handle equipment failure.
12. Handle danger.
13. Continue until target met.
14. Return structured result.
15. On success, record a SkillSuccess entry for the library.
```

The skill itself should not require LLM calls after every block.

The LLM is invoked when:

- The skill succeeds
- The skill fails
- The skill enters an unexpected condition it cannot resolve deterministically
- A higher-priority event interrupts it

Search expansion and status messages must follow the consistent contract defined in Section 12.2.

---

# 28. Mining Behavior

Outside protected regions, CobbleBob may create his own mines.

Allowed:

- Stairways
- Branch mines
- Tunnels
- Temporary shafts
- Safe bridges
- Torch placement

Forbidden safety patterns:

- Blindly digging straight down
- Walking into known lava
- Continuing with dangerously low food
- Continuing with no viable tool
- Ignoring an emergency retreat condition

Mining style should be deterministic where practical.

The LLM should select mining intent, not individual block geometry.

---

# 29. Stockpile Maintenance

Background stockpile management is the default idle loop.

Targets:

```yaml
stockpiles:
  wood: 64
  food: 64
  fuel: 64
  torches: 64
```

`fuel` may be satisfied by:

```text
coal
charcoal
```

The stock manager should periodically calculate deficits.

Example:

```text
Wood:     64 / 64
Food:     21 / 64
Fuel:     80 / 64
Torches:  11 / 64
```

Priority should generally go to the most operationally important shortage.

A simple initial weighting:

```text
1. Food
2. Torches
3. Wood
4. Fuel
```

However, the system may account for dependencies.

Example:

```text
Low torches + no fuel
→ replenish fuel first
→ craft torches
```

When stockpiles are healthy and no higher-priority work exists, the background director (Section 4.3.1) chooses the next task.

---

# 30. Configuration

Suggested configuration layout:

```text
config/
├── agent.yaml
├── minecraft.yaml
├── maintenance.yaml
├── stockpiles.yaml
├── item-policy.yaml
└── logging.yaml
```

## 30.1 agent.yaml

```yaml
agent:
  name: CobbleBob
  owner: Corey

llm:
  base_url: http://127.0.0.1:8080
  timeout_ms: 30000
  max_retries: 2

behavior:
  concise_chat: true
  auto_sleep: true
  auto_upgrade_tools: true
  allow_pvp: false
  llm_decisions: true
  llm_decision_interval_seconds: 60
```

## 30.2 minecraft.yaml

```yaml
server:
  host: eros
  port: 25565
  username: CobbleBob

home:
  dimension: overworld
  x: 0
  y: 64
  z: 0
  protected_size_x: 100
  protected_size_z: 100

navigation:
  expedition_threshold: 256
```

The exact home coordinates are set when the new world is created.

---

# 31. Proposed Repository Structure

```text
blockhead/
│
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
│
├── src/
│   ├── index.ts
│   │
│   ├── minecraft/
│   │   ├── bot.ts
│   │   ├── events.ts
│   │   ├── perception.ts
│   │   ├── movement.ts
│   │   ├── inventory.ts
│   │   ├── crafting.ts
│   │   ├── combat.ts
│   │   ├── world.ts
│   │   └── protection.ts
│   │
│   ├── agent/
│   │   ├── agent.ts
│   │   ├── scheduler.ts
│   │   ├── state.ts
│   │   ├── task.ts
│   │   ├── bootstrap.ts
│   │   ├── maintenance.ts
│   │   └── background.ts
│   │
│   ├── llm/
│   │   ├── client.ts
│   │   ├── schemas.ts
│   │   ├── prompt.ts
│   │   └── context.ts
│   │
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── schemas.ts
│   │   ├── navigation.ts
│   │   ├── resources.ts
│   │   ├── crafting.ts
│   │   ├── storage.ts
│   │   ├── combat.ts
│   │   └── utility.ts
│   │
│   ├── skills/
│   │   ├── collect-resource.ts
│   │   ├── ensure-item.ts
│   │   ├── gather-food.ts
│   │   ├── hunt.ts
│   │   ├── death-recovery.ts
│   │   ├── bootstrap-survival.ts
│   │   ├── organize-storage.ts
│   │   ├── expedition.ts
│   │   └── skill-library.ts
│   │
│   ├── memory/
│   │   ├── database.ts
│   │   ├── migrations.ts
│   │   ├── locations.ts
│   │   ├── storage.ts
│   │   ├── resources.ts
│   │   ├── tasks.ts
│   │   └── skill-successes.ts
│   │
│   ├── policy/
│   │   ├── safety.ts
│   │   ├── item-policy.ts
│   │   ├── protection.ts
│   │   └── maintenance.ts
│   │
│   ├── events/
│   │   ├── bus.ts
│   │   └── types.ts
│   │
│   ├── tui/
│   │   ├── app.ts
│   │   ├── panels.ts
│   │   └── format.ts
│   │
│   └── config/
│       ├── load.ts
│       └── schema.ts
│
├── config/
│   ├── agent.yaml
│   ├── minecraft.yaml
│   ├── maintenance.yaml
│   ├── stockpiles.yaml
│   ├── item-policy.yaml
│   └── logging.yaml
│
├── prompts/
│   ├── system.md
│   ├── decision.md
│   ├── idle-proposal.md
│   └── conversation.md
│
├── scripts/
│   ├── start-bot.sh
│   └── dev.sh
│
├── data/
│   └── .gitkeep
│
├── logs/
│   └── .gitkeep
│
└── tests/
    ├── unit/
    ├── integration/
    └── scenarios/
```

---

# 32. Logging

Two logging streams should exist.

## 32.1 Human-Readable Log

Example file:

```text
logs/blockhead.log
```

Example:

```text
14:21:02 TASK      Collect 64 oak logs
14:21:03 SEARCH    Oak found 74 blocks east
14:21:18 ACTION    Gathering oak
14:22:34 STATUS    41/64 collected
14:23:12 COMPLETE  64/64 oak logs
14:23:13 TASK      Resuming stockpile maintenance
```

## 32.2 Detailed Debug Log

Example:

```text
logs/blockhead-debug.jsonl
```

Entries may include:

```json
{
  "timestamp": "2026-09-11T14:21:03Z",
  "event": "agent_decision",
  "task_id": "task_183",
  "world_state": {},
  "llm_request": {},
  "llm_response": {},
  "selected_tool": "collect_resource",
  "arguments": {
    "resource": "oak_log",
    "quantity": 64
  },
  "duration_ms": 921
}
```

**Important:** The detailed log must capture the exact state snapshot that was sent to the LLM. This is essential for reproducing and debugging bad decisions.

Secrets and credentials must not be logged.

---

# 33. Development TUI

A development terminal dashboard should be added relatively early.

Concept:

```text
BLOCKHEAD — CobbleBob

STATE
Health       20/20
Hunger       18/20
Position     184, 67, -291
Dimension    Overworld
Time         Night
Danger       0.2

TASK
Foreground   Collect iron x32
Status       PAUSED - nighttime

BACKGROUND
Maintain stockpiles
Wood         64/64
Food         28/64
Fuel         71/64
Torches      12/64

ACTION
Organizing storage

INVENTORY
Iron Pickaxe
Iron Sword
Bread x12
Torch x42

LLM
Model        local llama.cpp model
Last call    1.1 sec ago
Latency      742 ms
Last tool    collect_resource
Rationale    User requested iron

EVENT
Zombie detected - 18m
```

The TUI is diagnostic, not required for game control.

Minecraft chat remains the primary command interface.

Additional observability:

- Optional prismarine-viewer (or similar) for live position and inventory visualization during development.
- Clear display of the last LLM decision, selected tool, rationale, and latency.

---

# 34. Safety and Reliability Rules

The policy layer must enforce hard constraints independently of the LLM.

Initial rules:

```text
Never execute arbitrary generated JavaScript.
Never execute shell commands requested by the model.
Never attack human players.
Do not destroy protected structures.
Do not discard critical items.
Do not intentionally enter known lava.
Do not dig straight down blindly.
Do not continue dangerous work below health limits.
Do not begin long expeditions without minimum supplies.
Do not enter another dimension unless explicitly allowed by policy.
```

The LLM proposes.

The validator and policy layer decide whether the proposal is legal.

---

# 35. Error Handling Philosophy

Skills should return structured results.

Example:

```ts
export interface SkillResult<T = unknown> {
  ok: boolean;
  status:
    | "completed"
    | "partial"
    | "blocked"
    | "failed"
    | "interrupted";
  data?: T;
  errorCode?: string;
  message?: string;
  retryable?: boolean;
}
```

Examples:

```text
RESOURCE_NOT_FOUND
PATH_UNREACHABLE
TOOL_REQUIRED
INVENTORY_FULL
DANGER_TOO_HIGH
PROTECTED_REGION
CRAFTING_STATION_REQUIRED
INSUFFICIENT_MATERIALS
PLAYER_NOT_FOUND
DEATH_OCCURRED
```

The LLM should reason from explicit failure data rather than vague prose whenever possible.

---

# 36. Testing Strategy

Testing must not rely only on live play.

## 36.1 Unit Tests

Test:

- Task priority resolution
- Pause/resume behavior
- Config parsing
- Tool schema validation
- Item policy
- Protected-region math
- Stockpile deficit calculation
- Expedition threshold behavior
- Maintenance triggers
- Skill success recording and retrieval ranking
- Danger score calculation
- Observation compression size limits

## 36.2 Integration Tests

Test:

- Mineflayer connection
- Chat parsing
- Tool execution
- SQLite persistence
- llama.cpp response validation
- Skill cancellation
- Restart/resume behavior
- Skill library write + retrieve cycle

## 36.3 Scenario Tests

Useful scenario tests:

```text
Fresh spawn, no equipment
Low food during wood task
Tool breaks during mining
Night falls during surface gathering
Death 100 blocks from home
Requested item already exists in storage
No oak within first search radius
Chest becomes full
User says "come here" during expedition
User says "stop" during resource gathering
Idle with no foreground task triggers a director decision
Skill success is later retrieved as few-shot example
```

Scenario tests should become a major debugging tool.

---

# 37. Implementation Phases

## Phase 1 — Connect CobbleBob

Goal:

> CobbleBob can reliably join the private server and communicate.

Requirements:

- Create TypeScript/Node project
- Install Mineflayer + recommended plugins
- Connect to Eros
- Spawn successfully
- Read position
- Read health/hunger
- Receive chat
- Send chat
- Log events

Acceptance:

```text
Corey: CobbleBob?
CobbleBob: Yep.
```

No LLM required.

---

## Phase 2 — Deterministic Movement

Implement:

```text
come_to_player()
follow_player()
stop_following()
wait_here()
go_home()
travel_to()
```

Acceptance:

```text
"Come here."
"Follow me."
"Wait here."
"Go home."
```

All function reliably without LLM reasoning.

---

## Phase 3 — State, Events, and Persistence

Implement:

- Event bus
- State manager
- SQLite
- World identity
- Home location
- Protected 100 × 100 home region
- Task model
- Scheduler skeleton
- Skill success table (schema only)

Acceptance:

- Restart Blockhead
- Home and task state persist
- Protected region reloads correctly

---

## Phase 4 — llama.cpp Integration + Prompt Discipline

Implement:

- HTTP client
- Structured prompt
- Zod validation
- Short conversational replies
- Tool-selection response schema
- Basic few-shot examples in the decision prompt
- Exact state snapshot logging

Acceptance:

```text
Corey: What are you doing?
CobbleBob: Following you.
```

and:

```text
Corey: Come here.
```

produces a validated high-level action.

---

## Phase 5 — Bootstrap Survival

Implement:

- Wood gathering
- Basic crafting
- Stone tools
- Food hunting
- Sheep/wool acquisition
- Bed crafting/placement
- Chest crafting/placement
- Furnace
- Coal/charcoal
- Torches
- Basic tool upgrades
- Skill success recording on successful bootstrap stages

Acceptance:

> Starting from a fresh spawn and configured home coordinate, CobbleBob can establish a minimally functional home setup without manual inventory assistance.

---

## Phase 6 — Resource Gathering

Implement:

```text
collect_resource()
search expansion (consistent contract)
inventory progress
tool replacement
return home
storage deposit
skill success recording
```

Primary milestone:

```text
CobbleBob, get 32 oak logs.
```

Acceptance:

- Finds oak
- Acquires needed tools
- Gathers at least 32
- Returns home
- Deposits logs into chest
- Reports completion
- Records a SkillSuccess entry

---

## Phase 7 — Background Stockpile Maintenance + Idle Proposal

Implement target maintenance:

```text
wood >= 64
food >= 64
fuel >= 64
torches >= 64
```

Plus the LLM background director whenever idle and no survival floor is breached.

Acceptance:

With no user task active, the director chooses each background task; when the model is disabled or unreachable, the deterministic ladder detects shortages and restores stockpiles, then organizes storage or stands by.

---

## Phase 8 — Interrupt and Resume

Implement:

- Foreground/background preemption
- Maintenance preemption
- Soft interrupts
- Hard interrupts
- Task resume state

Acceptance:

```text
CobbleBob is gathering wood.
User requests iron.
CobbleBob pauses wood.
Food runs low.
CobbleBob pauses iron.
CobbleBob restores food.
CobbleBob finishes iron.
CobbleBob resumes wood.
```

---

## Phase 9 — Expedition Mode

Implement:

- 256-block threshold
- Expedition supply check
- Extended searches
- Safe return logic
- Distance-aware risk

Acceptance:

A search beyond 256 blocks correctly enters expedition behavior and still returns home.

---

## Phase 10 — Death Recovery

Implement:

- Death recording
- Respawn handling
- Recovery task
- Value-aware item prioritization
- Failure reason recording
- Failure fallback

Acceptance:

CobbleBob dies during an ordinary task, attempts recovery using value order, records the outcome, and returns to useful operation whether recovery succeeds or fails.

---

## Phase 11 — Storage Organization

Implement:

- Container registration
- Category metadata
- Chest capacity checks
- Automatic chest creation
- Item organization

Acceptance:

CobbleBob can expand storage without user micromanagement.

---

## Phase 12 — Development TUI + Observability

Implement live display of:

- Health / Hunger / Position / Dimension / Time / Danger score
- Task + status
- Background target status
- Current skill
- Recent event
- Inventory summary
- LLM latency, last tool, and rationale

Acceptance:

A developer can understand CobbleBob's current behavior and the last LLM decision without reading raw logs.

---

# 38. First Major End-to-End Demonstration

The first important end-to-end test remains:

```text
CobbleBob, get me 32 oak logs.
```

Starting conditions should eventually include:

- Arbitrary safe starting position
- No guarantee that oak is immediately visible
- CobbleBob may need an axe
- CobbleBob may need to search
- CobbleBob may encounter interruptions
- CobbleBob must return home
- CobbleBob must deposit the result into storage
- CobbleBob must resume background work afterward
- A SkillSuccess record is written on completion

Success means the core architecture works:

```text
natural language
→ task
→ high-level decision
→ deterministic skill
→ world interaction
→ persistence
→ skill library update
→ task completion
→ autonomous continuation
```

---

# 39. Recommended Initial Dependencies

Likely initial dependencies:

```text
mineflayer
mineflayer-pathfinder
mineflayer-collectblock
mineflayer-tool
mineflayer-auto-eat
mineflayer-armor-manager
mineflayer-pvp
minecraft-data
zod
better-sqlite3
yaml
pino
```

Potential development dependencies:

```text
typescript
tsx
vitest
@types/node
eslint
prettier
```

A TUI library and optional prismarine-viewer can be selected after the core control path works.

---

# 40. Non-Goals for the Initial Version

Do not attempt initially:

- General-purpose building generation
- Complex farms
- Redstone engineering
- Nether automation
- End progression
- PvP
- Voice commands
- Discord control
- Web UI
- Autonomous social roleplay
- Multi-agent coordination
- Arbitrary code execution
- Vision models
- Full-world mapping
- Perfect structure recognition

The initial project should solve survival, resource work, persistent memory, skill library learning, and reliable task execution first.

---

# 41. Design Principles to Preserve

Throughout implementation:

1. **Keep the LLM at the intent level.**
2. **Keep mechanics deterministic.**
3. **Use structured state instead of giant prompts.**
4. **Use SQLite instead of relying on conversation memory.**
5. **Prefer resumable state machines over monolithic scripts.**
6. **Make background behavior useful and predictable.**
7. **Keep chat concise.**
8. **Validate every LLM action.**
9. **Treat survival policy as code, not personality.**
10. **Log enough information to reproduce bad decisions (including the exact state sent to the LLM).**
11. **Build one reliable skill at a time.**
12. **Do not over-engineer features that are not yet needed.**
13. **Record successful skill executions and retrieve them as few-shot examples.**
14. **Keep observation compression tight and high-signal.**
15. **Use mature Mineflayer plugins instead of re-implementing core mechanics.**

---

# 42. Prompt Engineering Guidelines for Local Models

Because the system targets llama.cpp (and similar local runtimes), the following practices are required:

- Keep the system prompt short, strict, and focused on the allowed tools and personality.
- Always include 2–4 relevant few-shot examples (drawn from the skill library when available).
- Force structured output and retry on invalid responses (Zod + limited retries).
- Explicitly instruct the model: “You only choose high-level tools from the provided list. Never invent new tools. Never control movement, pathfinding, or inventory slots directly.”
- Place current task progress and the last error near the top of the state object.
- Prefer short rationales.
- For background direction, use a strict schema and a dispatcher-capable task list.

These patterns materially improve reliability of smaller local models.

---

# 43. Definition of the Initial Successful System

The first genuinely successful Blockhead version should be able to start in a fresh private Minecraft world and, with only a configured home coordinate:

1. Join the server.
2. Reach home.
3. Gather wood.
4. Create basic tools.
5. Acquire food.
6. Find sheep and make a bed.
7. Create storage.
8. Create a furnace.
9. Acquire coal or charcoal.
10. Create torches.
11. Upgrade tools over time.
12. Maintain minimum stockpiles.
13. Sleep automatically when appropriate.
14. Accept chat instructions.
15. Pause background work for foreground tasks.
16. Handle maintenance interruptions.
17. Gather requested resources.
18. Return requested resources to home storage.
19. Avoid damaging protected human structures.
20. Recover from death when possible (with value-aware prioritization).
21. Resume useful autonomous activity when no user task exists.
22. Record successful skills and reuse them as few-shot examples.
23. Optionally propose useful work when fully idle and healthy.

At that point CobbleBob is no longer simply a Mineflayer bot with an LLM attached.

He is a persistent autonomous Minecraft worker with a small reasoning model operating over a deterministic embodied skill system that improves through recorded experience.
