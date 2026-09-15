import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompt asset loader (spec 42): the system prompt, decision contract, and
 * idle-proposal prompt live in prompts/*.md so they are short, strict, and
 * editable without touching code. The loader parses the decision file's
 * few-shot JSON block, and falls back to the built-in defaults (below) when
 * the files are absent — unit tests and exotic working directories keep
 * working with the exact same behavior.
 */

export interface PromptAssets {
  system: string;
  decision: string;
  fewShot: readonly { user: string; assistant: string }[];
  idleProposal: string;
  goal: string;
}

/** Built-in fallbacks: identical to the shipped prompts/*.md files. */
const FALLBACK_SYSTEM = [
  "You are CobbleBob, a calm, minimal Minecraft companion.",
  "You choose high-level tools from the provided list. Never invent new tools.",
  "You never control movement, pathfinding, inventory slots, or combat directly; deterministic code performs those.",
  "An autonomous goal, when active, appears in the state and is pursued across many actions; when the owner names a multi-step objective use start_goal, and the owner may cancel it with stop/cancel or by starting a new goal.",
  "Reply with short, task-oriented phrases. Keep rationales under one short sentence.",
  "Respond only with valid JSON matching the required schema.",
].join("\n");

const FALLBACK_DECISION = [
  "Choose exactly ONE action from the available tools (type \"tool\") or answer directly (type \"respond\").",
  "Only tools from the provided list. Never invent tool names.",
  "Arguments must match the tool's documented shape; invalid arguments are rejected, nothing executes.",
  "`message` is optional; `rationale` is one short sentence or omitted.",
].join("\n");

const FALLBACK_FEW_SHOT: readonly { user: string; assistant: string }[] = [
  {
    user: "Corey: come here",
    assistant: JSON.stringify({
      decision: { type: "tool", tool: "come_to_player", arguments: { player: "Corey" } },
      rationale: "Approach the owner.",
    }),
  },
  {
    user: "Corey: get me 32 oak logs",
    assistant: JSON.stringify({
      decision: { type: "tool", tool: "collect_resource", arguments: { resource: "oak_log", quantity: 32 } },
      rationale: "Gather logs and deposit them at home.",
    }),
  },
  {
    user: "Corey: make me an iron pickaxe",
    assistant: JSON.stringify({
      decision: { type: "tool", tool: "ensure_item", arguments: { item: "iron_pickaxe", quantity: 1 } },
      rationale: "Craft an iron pickaxe, mining and smelting iron as needed.",
    }),
  },
  {
    user: "Corey: what are you doing?",
    assistant: JSON.stringify({
      decision: { type: "respond", response: "Standing by." },
      rationale: "Answer a status question.",
    }),
  },
];

const FALLBACK_IDLE = [
  "You are CobbleBob's planning head. You decide the next background task.",
  "Choose exactly ONE task from the provided list. Never invent tasks or parameters.",
  "You never control movement, pathfinding, inventory, or combat; deterministic code performs those once you choose.",
  "Survival floors are handled by code, not by you. You are only consulted while every stockpile sits above its floor.",
  "Address listed shortages before optional work. Food is the top priority shortage: prefer stockpile_maintenance with kind \"food\" when food is below target.",
  "Do not blindly repeat a restore the situation lists as recently failed — pick a different useful task or wait. A failed repeat is worse than a short wait.",
  "When nothing useful remains, choose wait.",
  "Reply with short, task-oriented phrases. Respond only with valid JSON matching the required schema.",
].join("\n");

const FALLBACK_GOAL = [
  "You are CobbleBob's planning head, driving ONE autonomous goal to completion.",
  "Pick exactly ONE next action from the provided list. Never invent actions or parameters.",
  "You never control movement, pathfinding, inventory, or combat; deterministic code performs those once you choose.",
  "Progress the goal with task actions. Choose \"complete\" ONLY when every success criterion is satisfied by the current state. Choose \"abandon\" only when the goal is impossible.",
  "Recent results are outcomes of previous choices. A failed step is information, not a mandate to repeat it — pick what unblocks the goal or wait.",
  "Reply with short, task-oriented phrases. Respond only with valid JSON matching the required schema.",
].join("\n");

function readPromptFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The repo's prompts/ directory, resolved from this module's location. */
function promptsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../prompts");
}

/** Parse the few-shot array out of a decision.md ```json fenced block. */
export function parseFewShot(markdown: string): readonly { user: string; assistant: string }[] {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(markdown);
  if (match === null) return [];
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const examples: { user: string; assistant: string }[] = [];
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { user?: unknown }).user === "string" &&
        typeof (entry as { assistant?: unknown }).assistant === "string"
      ) {
        examples.push({ user: (entry as { user: string }).user, assistant: (entry as { assistant: string }).assistant });
      }
    }
    return examples;
  } catch {
    return [];
  }
}

/** Load the three prompt assets with built-in fallbacks. Cache once loaded. */
let cached: PromptAssets | null = null;

export function loadPromptAssets(dir?: string): PromptAssets {
  if (cached !== null) return cached;
  const base = dir ?? promptsDir();
  const system = readPromptFile(resolve(base, "system.md"));
  const decision = readPromptFile(resolve(base, "decision.md"));
  const idle = readPromptFile(resolve(base, "idle-proposal.md"));
  const goal = readPromptFile(resolve(base, "goal.md"));
  const fewShot = decision === null ? FALLBACK_FEW_SHOT : parseFewShot(decision);
  cached = {
    system: system ?? FALLBACK_SYSTEM,
    decision: decision ?? FALLBACK_DECISION,
    fewShot: fewShot.length > 0 ? fewShot : FALLBACK_FEW_SHOT,
    idleProposal: idle ?? FALLBACK_IDLE,
    goal: goal ?? FALLBACK_GOAL,
  };
  return cached;
}