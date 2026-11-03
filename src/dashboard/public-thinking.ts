import { publicActivityForTask, type PublicActivity } from "./public-status.js";
import { stripCoordinates } from "./story.js";
import type { LlmDecisionType } from "./types.js";

/**
 * The public thinking bubble: the model's latest spectator line, else its
 * rationale, else a fixed phrase. Policy (owner decision, 2026-11-02) is
 * scrub + reject-on-doubt: the whole line must pass every check below or the
 * next candidate is tried, ending at the fixed phrase for the task type.
 * The spectator line is a short sentence the model writes for viewers
 * (llm/prompt.ts); it gets exactly the same checks as a rationale. It is never partially scrubbed, because a
 * scrubber that removes the one leak it knows about leaves the ones it
 * doesn't. Only cosmetic changes survive: whitespace, snake_case item and
 * tool names written with spaces, and the length cap.
 */

export const THINKING_MAX_CHARS = 120;

export type ThinkingRejection = "empty" | "characters" | "digits" | "address" | "name" | "identifier" | "words" | "place" | "coordinates";

/** Owner chat is private, and owner-instruction rationales paraphrase it. */
const OWNER_PHRASE = "Working out what the owner asked for…";
const ACTIVITY_PHRASE: Record<Exclude<PublicActivity, "offline">, string> = {
  gathering: "Deciding what to gather next…",
  building: "Planning the next part of the build…",
  exploring: "Choosing where to head next…",
  recovering: "Working out how to stay safe…",
  resting: "Deciding it's a good time for a break…",
  working: "Thinking about what to do next…",
};
const TOOL_PHRASE: Partial<Record<string, string>> = {
  complete_goal: "Checking that the plan is finished…",
  abandon_goal: "Rethinking the current plan…",
};

/** Network addresses and paths: `@`, URLs, slashes, and dotted names like `mc.example` or `e.g`. */
const ADDRESS = /@|:\/\/|\bwww\b|[/\\]|\b[a-z0-9-]+\.[a-z][a-z0-9-]*\b|\b(?:localhost|tailscale|tailnet|ipv[46]|ip|port|host|hostname|endpoint|url|api|server address)\b/i;
/** Words that only appear when the text is about coordinates or secrets. */
const WORDS = /\b(?:coordinates?|coords?|xyz|seed|whitelist|password|token)\b/i;
/** Private places become a location once paired with a direction, number or distance. */
const PLACE = /\b(?:home|base|chests?|house|bed|shed|storage|spawn)\b/i;
const DIRECTION = /\b(?:north|south|east|west|(?:north|south)(?:east|west)|northern|southern|eastern|western|(?:north|south|east|west)wards?|left|right|above|below|behind|beneath|underneath|uphill|downhill|blocks?|meters?|metres?|paces?)\b/i;
const NUMBER_WORD = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozens?|half|first|second|third|fourth|fifth)\b/i;
const SNAKE = /^[a-z]+(?:_[a-z]+)+$/;
/** Signed or axis-named numbers are positions however they are written. */
const POSITION_WORDS = /\b(?:minus|negative)\b/i;
const AXIS = /(?:^|[^A-Za-z])[xyzXYZ](?=$|[^A-Za-z'])/;
/** A count is "20 oak logs"; these words before or after a number make it a place, depth or distance. */
const BEFORE_COUNT = /\b(?:at|to|near|around|reach|level|depth|height|layer|distance|of|is|by|about)\s$/i;
const AFTER_COUNT = /^\s(?:blocks?|meters?|metres?|paces?|steps?|chunks?|levels?|deep|down|up|high|low|below|above|away|far|out|north|south|east|west|left|right|forward|back|behind|ahead|over|across|along)\b/i;
const MAX_COUNTS = 2;
/** Capitalised words that may appear mid-sentence; any other one may be a name. */
const PROPER_NOUNS = new Set(["I", "Minecraft", "Nether", "End", "Overworld"]);
/** A word this long that starts a private term is that name too ("Barnaby" for Barnabyisbig). */
const MIN_FRAGMENT = 5;

/** Lowercase letters and digits only, so `Dark_Knight` and `dark knight` compare equal. */
const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Why a text may not go public, or null when it passes every check. */
export function thinkingRejection(text: string, privateTerms: readonly string[]): ThinkingRejection | null {
  const value = normalize(text);
  if (value === "") return "empty";
  // Printable ASCII only: no control characters or look-alike letters that dodge the name check.
  if (/[^\x20-\x7E]/.test(value)) return "characters";
  if (!onlyCounts(value)) return "digits";
  if (ADDRESS.test(value)) return "address";
  const flat = compact(value);
  const lower = value.toLowerCase();
  for (const term of privateTerms) {
    const key = compact(term);
    if (key === "") continue;
    // Short terms would match inside ordinary words once spaces are gone; match them as words.
    if (key.length >= 3 ? flat.includes(key) : new RegExp(`\\b${key}\\b`).test(lower)) return "name";
    // The start of a name ("Barnaby wants wood") is still that name.
    for (const word of lower.match(/[a-z]+/g) ?? []) {
      const stem = word.replace(/s$/, "");  // "barnabys house"
      if (stem.length >= MIN_FRAGMENT && key.startsWith(stem)) return "name";
    }
  }
  // Usernames hide in camelCase and mixed-case snake_case; registry names are lowercase snake_case.
  if (/[a-z][A-Z]/.test(value)) return "identifier";
  for (const token of value.match(/[A-Za-z_]*_[A-Za-z_]*/g) ?? []) if (!SNAKE.test(token)) return "identifier";
  // Any other capitalised word mid-sentence may be a player we have never seen.
  if (hasMidSentenceCapital(value)) return "name";
  if (WORDS.test(value)) return "words";
  if (PLACE.test(value) && (DIRECTION.test(value) || NUMBER_WORD.test(value) || /\d/.test(value))) return "place";
  if (stripCoordinates(value) !== value) return "coordinates";
  return null;
}

/**
 * Digits pass only as item counts: at most two plain 1–3 digit numbers, each
 * followed by an ordinary word ("Gather 20 oak logs") and never a distance,
 * direction or position word. Anything else with a digit is doubt.
 */
function onlyCounts(value: string): boolean {
  const numbers = [...value.matchAll(/\d+/g)];
  if (numbers.length === 0) return !(POSITION_WORDS.test(value) || (AXIS.test(value) && NUMBER_WORD.test(value)));
  if (numbers.length > MAX_COUNTS || POSITION_WORDS.test(value) || AXIS.test(value)) return false;
  return numbers.every((match) => {
    const start = match.index, end = start + match[0].length;
    if (match[0].length > 3 || /^0\d/.test(match[0])) return false;
    // A space before (or the start), a space and a lowercase word after: nothing glued on.
    if (start > 0 && value[start - 1] !== " ") return false;
    if (!/^ [a-z]/.test(value.slice(end, end + 2))) return false;
    return !BEFORE_COUNT.test(value.slice(0, start)) && !AFTER_COUNT.test(value.slice(end));
  });
}

/** A capitalised word that doesn't start a sentence and isn't a known game noun. */
function hasMidSentenceCapital(value: string): boolean {
  for (const match of value.matchAll(/[A-Z][A-Za-z']*/g)) {
    const before = value.slice(0, match.index).trimEnd();
    if (before === "" || /[.!?;:]$/.test(before)) continue;
    if (!PROPER_NOUNS.has(match[0].replace(/'s$/, ""))) return true;
  }
  return false;
}

export function isPublicSafeText(text: string, privateTerms: readonly string[]): boolean {
  return thinkingRejection(text, privateTerms) === null;
}

/** The fixed phrase shown instead of a rejected or missing rationale. */
export function fallbackThought(tool: string | null | undefined, callType: LlmDecisionType | null | undefined): string {
  if (callType === "owner_instruction") return OWNER_PHRASE;
  const byTool = typeof tool === "string" && Object.hasOwn(TOOL_PHRASE, tool) ? TOOL_PHRASE[tool] : undefined;
  return byTool ?? ACTIVITY_PHRASE[publicActivityForTask(tool) ?? "working"];
}

/** Cut at a word boundary within `max` characters, ending in an ellipsis; null if no boundary fits. */
export function capAtWord(text: string, max = THINKING_MAX_CHARS): string | null {
  if (text.length <= max) return text;
  const cut = text.slice(0, max).lastIndexOf(" ");
  if (cut <= 0) return null;
  return `${text.slice(0, cut).replace(/[\s,;:.!?-]+$/, "")}…`;
}

export interface ThoughtInput {
  rationale: string | null | undefined;
  /** The model's viewer-facing line, preferred over the rationale when it passes. */
  spectator?: string | null | undefined;
  tool: string | null | undefined;
  callType: LlmDecisionType | null | undefined;
  privateTerms: readonly string[];
}

/**
 * The spectator line if it passes every check, else the rationale if it
 * does, otherwise the fixed phrase for the task type. Owner-instruction
 * thoughts are always the fixed phrase.
 */
export function publicThought(input: ThoughtInput): string {
  const fallback = fallbackThought(input.tool, input.callType);
  if (input.callType === "owner_instruction") return fallback;
  for (const candidate of [input.spectator, input.rationale]) {
    const shown = displayable(candidate, input.privateTerms);
    if (shown !== null) return shown;
  }
  return fallback;
}

/** The text as the bubble shows it, or null when any check doubts it or it can't be cut to fit. */
function displayable(text: string | null | undefined, privateTerms: readonly string[]): string | null {
  if (typeof text !== "string" || thinkingRejection(text, privateTerms) !== null) return null;
  const display = normalize(text).replace(/[a-z]+(?:_[a-z]+)+/g, (token) => token.replace(/_/g, " "));
  return capAtWord(display);
}
