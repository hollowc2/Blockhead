import type { LlmMessage } from "./client.js";
import type { StateSnapshot } from "./context.js";
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
 * Few-shot examples (spec 42: "Always include 2-4 relevant few-shot
 * examples"); drawn from prompts/decision.md's JSON block. Later these can
 * be re-ranked from skill-library retrieval.
 */
export const FEW_SHOT_EXAMPLES: readonly { user: string; assistant: string }[] = assets.fewShot;

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