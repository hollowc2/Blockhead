import type { LlmMessage } from "./client.js";
import type { StateSnapshot } from "./context.js";
import type { SkillSuccess } from "../memory/skills.js";
import { loadPromptAssets } from "./prompts.js";

/**
 * Prompt construction (spec 42). The system prompt, the decision contract
 * (with few-shot examples), and the background-director instructions are
 * loaded from prompts/*.md, falling back to built-ins; the tool list and the
 * live state snapshot are always injected fresh. Small local models get a
 * short, strict, tool-bounded prompt.
 */

const assets = loadPromptAssets();

/** Personality + tool boundary (prompts/system.md). */
export const SYSTEM_PROMPT: string = assets.system;

/** The decision contract text (prompts/decision.md). */
export const DECISION_CONTRACT: string = assets.decision;

/**
 * Static few-shot examples (spec 42: "Always include 2-4 relevant few-shot
 * examples"); drawn from prompts/decision.md's JSON block. Recent local
 * skill-library runs are preferred when available (see `fewShotsFromSkills`);
 * the static set fills the rest and is the fallback on an empty library.
 */
export const FEW_SHOT_EXAMPLES: readonly { user: string; assistant: string }[] = assets.fewShot;

/** Few-shot cap: spec 42 wants 2-4 total examples (dynamic + static). */
const FEW_SHOT_CAP = 4;

/**
 * Turn completed local skill runs into few-shot examples (spec 20.2 /
 * 42 "prefer skill-library retrieval when available"). Only skills with a
 * user-facing tool are convertible: the run's parameters become the tool
 * arguments, the skill name maps to its tool, and the canned instruction
 * echoes a plausible owner request. Unmappable runs (death_recovery,
 * bootstrap stages, ensure_torches) are skipped — offering the model a tool
 * that does not exist would violate the registry boundary. Same-skill/same-
 * parameters duplicates collapse — `recent()` feeds newest-first, so the
 * first occurrence kept is the freshest run of that shape.
 */
export function fewShotsFromSkills(records: readonly SkillSuccess[]): readonly { user: string; assistant: string }[] {
  const seen = new Set<string>();
  const out: { user: string; assistant: string }[] = [];
  for (const record of records) {
    const example = skillSuccessToFewShot(record);
    if (example === null) continue;
    const key = `${example.assistant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(example);
    if (out.length >= FEW_SHOT_CAP) break;
  }
  return out;
}

/** Map one success record to a valid few-shot pair, or null when unmappable. */
function skillSuccessToFewShot(record: SkillSuccess): { user: string; assistant: string } | null {
  const tool = TOOL_FOR_SKILL[record.skillName];
  if (record.skillName.startsWith("ensure_item_")) return argumentFewShot("ensure_item", { item: record.parameters.item, quantity: record.parameters.quantity }, `Corey: get me ${quantityOf(record)} ${String(record.parameters.item ?? "it")}`);
  if (tool === undefined) return null;
  switch (tool) {
    case "collect_resource":
      return argumentFewShot(tool, { resource: record.parameters.resource ?? "", quantity: quantityOf(record) }, `Corey: get me ${quantityOf(record)} ${String(record.parameters.resource ?? "it")}`);
    case "gather_food":
      return argumentFewShot(tool, { quantity: quantityOf(record) }, `Corey: gather me ${quantityOf(record)} food`);
    case "organize_storage":
      return argumentFewShot(tool, {}, "Corey: tidy up the storage");
    case "defend_self":
      return argumentFewShot(tool, {}, "Corey: defend me");
    case "defend_player":
      return argumentFewShot(tool, { player: String(record.parameters.player ?? "Corey") }, `Corey: defend ${String(record.parameters.player ?? "Corey")}`);
    default:
      return null;
  }
}

const TOOL_FOR_SKILL: Readonly<Record<string, string>> = {
  collect_resource: "collect_resource",
  gather_food: "gather_food",
  organize_storage: "organize_storage",
  defend_self: "defend_self",
  defend_player: "defend_player",
};

/** The run's requested quantity, defaulting to 1 when unset/not a number. */
function quantityOf(record: SkillSuccess): number {
  const raw = Number(record.parameters.quantity);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/** Build a few-shot pair whose assistant content is a valid AgentDecision tool call. */
function argumentFewShot(
  tool: string,
  argumentsJson: Record<string, unknown>,
  user: string,
): { user: string; assistant: string } {
  return {
    user,
    assistant: JSON.stringify({
      decision: { type: "tool", tool, arguments: argumentsJson },
      rationale: "Worked before; same approach.",
    }),
  };
}

/** Assemble system + few-shot + the live instruction into chat messages. */
export function buildMessages(snapshot: StateSnapshot, toolList: string, dynamicFewShots: readonly { user: string; assistant: string }[] = []): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const examples = [...dynamicFewShots, ...FEW_SHOT_EXAMPLES].slice(0, FEW_SHOT_CAP);
  for (const example of examples) {
    messages.push({ role: "user", content: example.user });
    messages.push({ role: "assistant", content: example.assistant });
  }
  messages.push({
    role: "user",
    content: [
      "Available tools:",
      toolList,
      "",
      "Decision contract:",
      DECISION_CONTRACT,
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

/** System prompt for the background director (prompts/idle-proposal.md). */
export const DIRECTOR_SYSTEM_PROMPT: string = assets.idleProposal;

/** System prompt for the goal driver (prompts/goal.md). */
export const GOAL_SYSTEM_PROMPT: string = assets.goal;

/** The task vocabulary the TaskDispatcher can execute, as the model sees it. */
const DIRECTOR_TASK_DOC = [
  '"collect_resource" — gather `quantity` of `resource` (e.g. oak_log, stone, coal_ore, iron_ore) and deposit it in the home chest. Parameters: resource (item name), quantity (integer, 1-1024).',
  '"stockpile_maintenance" — restore one stockpile with its dedicated skill: wood gathers logs, food hunts animals, fuel mines coal ore, torches crafts from stored material. Parameters: kind ("wood" | "food" | "fuel" | "torches").',
  '"organize_storage" — sort the home chests by category, creating more storage when full.',
  '"build_base" — build or repair the stockpile shed at home (plank walls, roof, door); chests, the crafting table, and the furnace have fixed slots inside it.',
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
        "Situation:",
        situation,
        "",
        "Current state:",
        JSON.stringify(snapshot, null, 2),
        "",
        "Choose the next background task. Respond only with valid JSON matching the schema.",
      ].join("\n"),
    },
  ];
}

/**
 * The goal action vocabulary the goal driver may choose, as the model sees
 * it. The director tasks plus the production actions the expedition goal
 * needs; `complete` / `abandon` are the terminal verdicts.
 */
const GOAL_ACTION_DOC = [
  '"collect_resource" — gather `quantity` of `resource` (e.g. oak_log, stone, coal_ore, iron_ore) and deposit it in the home chest. Parameters: resource (item name), quantity (integer, 1-1024).',
  '"ensure_item" — craft (or gather) `quantity` of `item` (e.g. iron_pickaxe), keeping equipment carried. Parameters: item (item name), quantity (integer, 1-1024).',
  '"upgrade_equipment" — forge the best tool you can from the stockpile.',
  '"stockpile_maintenance" — restore one stockpile with its dedicated skill: wood gathers logs, food hunts animals, fuel mines coal ore, torches crafts from stored material. Parameters: kind ("wood" | "food" | "fuel" | "torches").',
  '"organize_storage" — sort the home chests by category, creating more storage when full.',
  '"build_base" — build or repair the stockpile shed at home.',
  '"go_home" — return to the configured home location.',
  '"wait" — do nothing this round.',
  '"complete" — declare the goal finished because every success criterion is satisfied by the current state.',
  '"abandon" — give up on the goal because it is impossible.',
].join("\n");

/**
 * Assemble the goal-driver prompt: the objective (description, criteria,
 * current step, recent results) plus the same curated situation digest the
 * director sees. The LLM only hears the goal + high-signal state, never raw
 * world dumps, and only answers from the closed action vocabulary.
 */
export function buildGoalDecisionMessages(snapshot: StateSnapshot, context: string): LlmMessage[] {
  return [
    { role: "system", content: GOAL_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Available actions (choose exactly one):",
        GOAL_ACTION_DOC,
        "",
        "Goal:",
        context,
        "",
        "Current state:",
        JSON.stringify(snapshot, null, 2),
        "",
        "Choose the next action that progresses the goal. Respond only with valid JSON matching the schema.",
      ].join("\n"),
    },
  ];
}