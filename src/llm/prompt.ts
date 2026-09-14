import type { LlmMessage } from "./client.js";
import type { StateSnapshot } from "./context.js";

/**
 * Short, strict system prompt (spec 42): allowed-tool boundary, personality,
 * and the deterministic-code rule. Small local models need this minimal.
 */
export const SYSTEM_PROMPT = [
  "You are CobbleBob, a calm, minimal Minecraft companion.",
  "You choose high-level tools from the provided list. Never invent new tools.",
  "You never control movement, pathfinding, inventory slots, or combat directly; deterministic code performs those.",
  "Reply with short, task-oriented phrases. Keep rationales under one short sentence.",
  "Respond only with valid JSON matching the required schema.",
].join("\n");

/**
 * Basic few-shot examples (spec 42: "Always include 2-4 relevant few-shot
 * examples"). Static for Phase 4; later drawn from the skill library.
 */
export const FEW_SHOT_EXAMPLES: readonly { user: string; assistant: string }[] = [
  {
    user: "Corey: come here",
    assistant: JSON.stringify({
      decision: { type: "tool", tool: "come_to_player", arguments: { player: "Corey" } },
      rationale: "Approach the owner.",
    }),
  },
  {
    user: "Corey: follow me",
    assistant: JSON.stringify({
      decision: { type: "tool", tool: "follow_player", arguments: { player: "Corey" } },
      rationale: "Follow the owner.",
    }),
  },
  {
    user: "Corey: what are you doing?",
    assistant: JSON.stringify({
      decision: { type: "respond", response: "Following you." },
      rationale: "Answer a status question.",
    }),
  },
  {
    user: "Corey: go home",
    assistant: JSON.stringify({
      decision: { type: "tool", tool: "go_home", arguments: {} },
      rationale: "Return home.",
    }),
  },
];

/** Assemble system + few-shot + the live instruction into chat messages. */
export function buildMessages(snapshot: StateSnapshot, toolList: string): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const example of FEW_SHOT_EXAMPLES) {
    messages.push({ role: "user", content: example.user });
    messages.push({ role: "assistant", content: example.assistant });
  }
  messages.push({
    role: "user",
    content: [
      "Available tools:",
      toolList,
      "",
      "Current state:",
      JSON.stringify(snapshot, null, 2),
      "",
      `Owner instruction: "${snapshot.instruction}"`,
      "",
      "Choose the next action. Respond only with valid JSON matching the schema.",
    ].join("\n"),
  });
  return messages;
}

/**
 * System prompt for the background director (spec 4.3). The model decides
 * the next background task from the dispatcher-capable vocabulary; survival
 * floors stay code-owned so the model never trades away safety. The food
 * priority and anti-churn rules keep a scarce-resource world from turning
 * the bot into a repeating fail loop.
 */
export const DIRECTOR_SYSTEM_PROMPT = [
  "You are CobbleBob's planning head. You decide the next background task.",
  "Choose exactly ONE task from the provided list. Never invent tasks or parameters.",
  "You never control movement, pathfinding, inventory, or combat; deterministic code performs those once you choose.",
  "Survival floors are handled by code, not by you. You are only consulted while every stockpile sits above its floor.",
  "Address listed shortages before optional work. Food is the top priority shortage: prefer stockpile_maintenance with kind \"food\" when food is below target.",
  "Do not blindly repeat a restore the situation lists as recently failed — pick a different useful task or wait. A failed repeat is worse than a short wait.",
  "When nothing useful remains, choose wait.",
  "Reply with short, task-oriented phrases. Respond only with valid JSON matching the required schema.",
].join("\n");

/** The task vocabulary the TaskDispatcher can execute, as the model sees it. */
const DIRECTOR_TASK_DOC = [
  '"collect_resource" — gather `quantity` of `resource` (e.g. oak_log, stone, coal_ore, iron_ore) and deposit it in the home chest. Parameters: resource (item name), quantity (integer, 1-1024).',
  '"stockpile_maintenance" — restore one stockpile with its dedicated skill: wood gathers logs, food hunts animals, fuel mines coal ore, torches crafts from stored material. Parameters: kind ("wood" | "food" | "fuel" | "torches").',
  '"organize_storage" — sort the home chests by category, creating more storage when full.',
  '"go_home" — return to the configured home location.',
  '"wait" — do nothing this round.',
].join("\n");

/**
 * Assemble the director prompt (spec 4.3): strict task vocabulary plus the
 * curated situation summary. No raw world dumps — `situation` is the
 * high-signal opportunity digest the background loop already measured.
 */
export function buildDirectorMessages(snapshot: StateSnapshot, situation: string): LlmMessage[] {
  return [
    { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Available tasks (choose exactly one):",
        DIRECTOR_TASK_DOC,
        "",
        "Current state:",
        JSON.stringify(snapshot, null, 2),
        "",
        "Situation:",
        situation,
        "",
        "Examples:",
        '  {"task": {"type": "stockpile_maintenance", "kind": "food"}, "rationale": "Food is 20 under target; no recent hunt failures."}',
        '  {"task": {"type": "wait"}, "rationale": "Every useful task failed recently; standing by."}',
        "",
        'Respond only with valid JSON matching the schema.',
      ].join("\n"),
    },
  ];
}
