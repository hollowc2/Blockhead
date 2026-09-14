import { z } from "zod";

export const MinecraftConfigSchema = z.object({
  server: z.object({
    host: z.string(),
    port: z.number().int().positive().default(25565),
    username: z.string(),
    /** Distinguishes worlds on the same server (memory identity). */
    world_key: z.string().default("default"),
  }),
  /** Agent identity and the trusted owner who may issue LLM-routed commands. */
  agent: z
    .object({
      name: z.string().default("CobbleBob"),
      owner: z.string().default("Corey"),
    })
    .optional(),
  /**
   * Agent behavior switches (spec 30.1). `allow_pvp` is the ONLY way human
   * targets become legal (spec 25 — out of scope by default); the combat
   * policy layer consults it before every attack.
   */
  behavior: z
    .object({
      /** Short, task-oriented chat replies (spec 3, 42). */
      concise_chat: z.boolean().default(true),
      /** Sleep in the home bed at night when idle (spec 9). */
      auto_sleep: z.boolean().default(true),
      /** Upgrade tools wood -> stone -> iron when resources allow (spec 10.2). */
      auto_upgrade_tools: z.boolean().default(true),
      /** Player-vs-player combat; false is a hard policy veto (spec 25). */
      allow_pvp: z.boolean().default(false),
    })
    .optional(),
  /**
   * Deterministic safety policy (spec 34). Enforced by policy/safety.ts and
   * policy/protection.ts before dangerous work starts; the LLM only proposes.
   */
  policy: z
    .object({
      /**
       * Health at or below which dangerous work (hunting hostiles, defending,
       * exploring) retreats instead of continuing.
       */
      health_retreat_threshold: z.number().int().min(1).max(20).default(8),
      /**
       * Dimensions the agent may enter; any other dimension is refused with
       * DIMENSION_FORBIDDEN (spec 34: "Never enter another dimension unless
       * explicitly allowed by policy").
       */
      allowed_dimensions: z.array(z.string()).default(["overworld"]),
      /** Standoff radius kept from known lava while choosing work sites. */
      lava_avoidance_radius: z.number().int().positive().default(4),
    })
    .optional(),
  /** Local llama.cpp HTTP server connection (spec 30.1). */
  llm: z
    .object({
      base_url: z.string().url().default("http://127.0.0.1:8080"),
      timeout_ms: z.number().int().positive().default(30000),
      max_retries: z.number().int().min(0).default(2),
    })
    .optional(),
  home: z.object({
    dimension: z.string().default("overworld"),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    /** Protected home region footprint (spec 8.1), in blocks. */
    protected_size_x: z.number().int().positive().default(100),
    protected_size_z: z.number().int().positive().default(100),
  }),
  /** Bootstrap state machine tuning (Phase 5.6: home / wood / crafting / stone tools / food / wool / bed / storage / furnace / fuel / torches / iron / iron tools). */
  bootstrap: z
    .object({
      /** Raw logs to gather in the WOOD stage; 3 logs make the full starter kit. */
      wood_logs: z.number().int().positive().default(8),
      /** Initial log-search radius in blocks; expands by 2x up to `hunt_max_radius` on misses. */
      search_radius: z.number().int().positive().default(48),
      /**
       * Furthest radius the hunt expands to before giving up (gather_food
       * patrols its ring edges because the entity scan only sees loaded
       * chunks). Mirrors skill-library's uniform search cap of 1024 used by
       * collect_resource.
       */
      hunt_max_radius: z.number().int().positive().default(1024),
      /**
       * Cobblestone to gather in the STONE_TOOLS stage: three per pickaxe /
       * axe / shovel (9) plus one for the sword and a small spare stockpile.
       */
      cobblestone: z.number().int().positive().default(12),
      /** Craft a stone sword for defense (one cobblestone and one stick). */
      stone_sword: z.boolean().default(true),
      /**
       * Food items (raw or cooked meat) the FOOD stage aims to carry before
       * moving on; mirrors spec 10's minimum_food_reserve (default 8).
       */
      food_items: z.number().int().positive().default(8),
      /**
       * Wool blocks the WOOL stage aims to carry; three make the Phase 5.4
       * bed, and hunting sheep yields their dyed fleece as a drop.
       */
      wool_blocks: z.number().int().positive().default(3),
      /**
       * Coal/charcoal the FUEL stage aims to carry (spec 7.1 item 14); each
       * torch craft burns one fuel unit for four torches.
       */
      fuel_items: z.number().int().positive().default(4),
      /**
       * Torches the TORCHES stage aims to stock at home (spec 7.1 item 15);
       * the stockpile target (64) is maintained by a later phase.
       */
      torches: z.number().int().positive().default(16),
      /**
       * Raw iron the IRON stage aims to gather when exposed ore is reachable
       * (spec 7.1 item 17: "opportunistically gather iron"). One ingot needs
       * one raw iron; six covers a pickaxe and an axe. A miss never blocks
       * bootstrap — the stage records what was found and moves on.
       */
      iron_ore: z.number().int().positive().default(6),
    })
    .optional(),
  /**
   * Phase 9 (spec 12): beyond this distance from home, in blocks, the gather
   * skills run the expedition supply check (food, tools, inventory space,
   * health, return plan) before expanding the search, then operate under the
   * distance-aware risk policy.
   */
  navigation: z
    .object({
      expedition_threshold: z.number().int().positive().default(256),
    })
    .optional(),
  /**
   * Background coordinator tuning (Phase 7, spec 29 and 4.3). `stockpiles`
   * mirrors spec 29's yaml; a target of 0 disables maintenance for that
   * stockpile. `stockpile_minimums` are the Phase 8 survival floors (spec
   * 5.4): a stockpile below its floor is restored at MAINTENANCE priority,
   * preempting foreground user work. Above the floors the LLM director
   * decides each background task (`llm_decisions`); the deterministic
   * shortage-then-storage ladder runs only as its failure fallback.
   */
  background: z
    .object({
      stockpiles: z
        .object({
          wood: z.number().int().nonnegative().default(64),
          food: z.number().int().nonnegative().default(64),
          fuel: z.number().int().nonnegative().default(64),
          torches: z.number().int().nonnegative().default(64),
        })
        .default({ wood: 64, food: 64, fuel: 64, torches: 64 }),
      /** Survival floors for preemptive maintenance (Phase 8, spec 5.4). */
      stockpile_minimums: z
        .object({
          wood: z.number().int().nonnegative().default(16),
          food: z.number().int().nonnegative().default(16),
          fuel: z.number().int().nonnegative().default(16),
          torches: z.number().int().nonnegative().default(8),
        })
        .optional(),
      /** How often the idle loop re-measures stockpiles. */
      check_interval_seconds: z.number().int().positive().default(30),
      /**
       * How long a failed stockpile restore backs off before the same kind
       * is attempted again. Prevents a structurally impossible restore
       * (empty world, unhealable health) from re-enqueuing every settled
       * tick; the kind is retried once this window expires.
       */
      restore_cooldown_seconds: z.number().int().positive().default(60),
      /**
       * Identical game-chat announcements repeat at most once per this
       * window (per skill runner), so a stuck loop cannot trip the server's
       * `disconnect.spam` rate limit. A separate process-wide budget caps
       * ANY two announcements 15s apart regardless of content, so bursts
       * across skills (food hunt + torches expansion) stay under the spam
       * floor too. Log output is not throttled.
       */
      announce_throttle_seconds: z.number().int().positive().default(30),
      /**
       * Master switch: the LLM director chooses the next background task
       * (spec 4.3). Off, or whenever the model call fails, the deterministic
       * shortage-then-storage ladder runs instead, so the bot never stalls.
       */
      llm_decisions: z.boolean().default(true),
      /**
       * Minimum seconds between LLM director calls. The bot stands by (the
       * model's "wait" is honored) within the window; survival floors still
       * preempt immediately.
       */
      llm_decision_interval_seconds: z.number().int().nonnegative().default(60),
    })
    .optional(),
  storage: z
    .object({
      /** SQLite database path; created on first run. */
      db_path: z.string().default("data/blockhead.db"),
    })
    .optional(),
  /**
   * Item value overrides (spec 24.5, Phase 10): exact item name -> category,
   * consulted before the built-in rules by the ItemPolicy. Drives the
   * death-recovery pickup order (spec 26.1) without hardcoding decisions.
   */
  items: z
    .record(z.string(), z.enum(["critical", "valuable", "useful", "common", "expendable"]))
    .optional(),
  /**
   * Phase 12 development TUI (spec 33): the terminal dashboard. `enabled`
   * defaults to true when stdout is a TTY; while it runs, pino's console
   * echo is redirected (the TUI owns the screen) and the human-readable log
   * stream in logs/blockhead.log keeps recording. Diagnostic only — never
   * required for game control.
   */
  tui: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),
});

export type MinecraftConfig = z.infer<typeof MinecraftConfigSchema>;