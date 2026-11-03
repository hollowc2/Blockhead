import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDirectorMessages, buildGoalDecisionMessages } from "../llm/prompt.js";
import { loadPromptAssets } from "../llm/prompts.js";
import { capAtWord, fallbackThought, publicThought, thinkingRejection, THINKING_MAX_CHARS, type ThinkingRejection } from "./public-thinking.js";

/** Owner, bot, a whitelisted player, a chat sender and Maia's host names, as telemetry supplies them. */
const TERMS = ["Barnabyisbig", "CobbleBob", "Dark_Knight", "Ed", "maia", "maia.tailceb694.ts.net", "tailceb694"];
const think = (rationale: string | null, tool = "collect_resource", callType: "background_director" | "goal_decision" | "owner_instruction" = "background_director"): string =>
  publicThought({ rationale, tool, callType, privateTerms: TERMS });

/** Rationales that go public whole: the shipped few-shot examples and real ones from Maia's debug log. */
const GOOD: readonly [string, string][] = [
  ["Approach the owner.", "Approach the owner."],
  ["Gather logs and deposit them at home.", "Gather logs and deposit them at home."],
  ["Craft an iron pickaxe, mining and smelting iron as needed.", "Craft an iron pickaxe, mining and smelting iron as needed."],
  ["Answer a status question.", "Answer a status question."],
  ["Worked before; same approach.", "Worked before; same approach."],
  ["Search the surrounding area for water sources.", "Search the surrounding area for water sources."],
  ["Smelt the carried iron into ingots using home furnace fuel.", "Smelt the carried iron into ingots using home furnace fuel."],
  ["Build the stockpile shed at home.", "Build the stockpile shed at home."],
  ["Start gathering iron for the full suit and weapons.", "Start gathering iron for the full suit and weapons."],
  // Snake_case tool and item names read as words; that is formatting, not scrubbing.
  ["Both collect_resource and upgrade_equipment are blocked by cooldowns; waiting is the only valid action to progress.",
    "Both collect resource and upgrade equipment are blocked by cooldowns; waiting is the only valid action to progress."],
  ["  Head   north to find a cave.  ", "Head north to find a cave."],
  // Plain item counts are not places.
  ["Gather 20 oak logs for planks.", "Gather 20 oak logs for planks."],
  ["Craft 4 torches and 2 sticks before night.", "Craft 4 torches and 2 sticks before night."],
  ["Stock up on wood before the Nether trip.", "Stock up on wood before the Nether trip."],
];

/** Rationales that must be replaced whole, with the check that catches each. */
const BAD: readonly [string, ThinkingRejection][] = [
  ["", "empty"],
  ["   ", "empty"],
  // Real log lines: stockpile counts and coordinates are digits.
  ["The goal requires the torches stockpile to reach 128. The current state shows the stockpile is at 66.", "digits"],
  ["Walk to 120, 64, -30 and dig.", "digits"],
  ["Go to x=-1200 z=950", "digits"],
  ["Player Steve42 is nearby.", "digits"],
  ["Connect to 10.0.0.5", "digits"],
  // Numbers that measure a place, depth or distance, or are too many or too big to be a count.
  ["Mine 20 blocks down.", "digits"],
  ["Go 120 blocks north for iron.", "digits"],
  ["Dig down to 59 and mine.", "digits"],
  ["Collect 1200 cobblestone.", "digits"],
  ["Gather 3 logs, 2 planks and 5 sticks.", "digits"],
  ["Build a 3 x 3 platform.", "digits"],
  ["Mine iron at level 16 today.", "digits"],
  ["The player is currently at distance 13 from home.", "digits"],
  ["Deposit 20 logs in the chest by the house.", "place"],
  // Coordinates spelled out in words.
  ["Walk to x twenty two z minus forty.", "digits"],
  ["Diamonds are deep, around level negative fifty-nine.", "digits"],
  // Addresses, paths and URLs.
  ["Message me at bob@example", "address"],
  ["Open https://maia", "address"],
  ["Read /home/corey/notes first.", "address"],
  ["Check C:\\Users\\corey", "address"],
  ["Join mc.example.org for help.", "address"],
  ["Look it up, e.g. on the wiki.", "address"],
  ["The server runs on localhost.", "address"],
  ["Ask for the server address.", "address"],
  ["Check the port first.", "address"],
  // Known names, in any case or spacing, and the hosts.
  ["Follow Barnabyisbig to the mine.", "name"],
  ["follow barnabyisbig", "name"],
  ["Wait for barnaby is big.", "name"],
  ["Ask cobblebob to wait.", "name"],
  ["Meet Dark_Knight at the farm.", "name"],
  ["Meet dark knight at the farm.", "name"],
  ["Ed asked for wood.", "name"],
  ["Maia is busy.", "name"],
  // The start of a known name, and capitalised words that may be unknown players.
  ["Barnaby wants more wood for the tower.", "name"],
  ["Heading to barnabys house.", "name"],
  ["Gathering logs for Jenny's house by the lake.", "name"],
  ["Trade with the villager like Steve said.", "name"],
  // Unknown names hide in camelCase and mixed-case snake_case.
  ["Ask xXSteveXx for help.", "identifier"],
  ["Meet Night_Owl at the farm.", "identifier"],
  ["Use __proto__ tricks.", "identifier"],
  // Coordinates and secrets as words.
  ["Travel to a high coordinate to begin flattening the area.", "words"],
  ["Share the world seed.", "words"],
  ["Add them to the whitelist.", "words"],
  // Private places with a direction, number or distance.
  ["Head to the chest north of home.", "place"],
  ["Store loot in the chest two blocks behind the house.", "place"],
  ["The base is a hundred paces west.", "place"],
  ["Sleep in the bed left of the door.", "place"],
  ["Return to spawn, then go east.", "place"],
  ["Search the first chest at home.", "place"],
  // Anything stripCoordinates would change.
  ["Walk to the village near", "coordinates"],
  ["Something to.", "coordinates"],
  // Non-ASCII: look-alike letters dodge the name check, control characters break the page.
  ["Follow B\u0430rnabyisbig.", "characters"],
  ["Ring the bell\u0007", "characters"],
  ["Café break.", "characters"],
];

test("clean rationales pass whole", () => {
  for (const [rationale, expected] of GOOD) {
    assert.equal(thinkingRejection(rationale, TERMS), null, rationale);
    assert.equal(think(rationale), expected, rationale);
  }
});

test("each doubtful rationale is caught by the expected check and replaced, never partially scrubbed", () => {
  for (const [rationale, reason] of BAD) {
    assert.equal(thinkingRejection(rationale, TERMS), reason, rationale);
    assert.equal(think(rationale), "Deciding what to gather next…", rationale);
  }
});

test("the shipped prompt examples' rationales pass", () => {
  for (const shot of loadPromptAssets().fewShot) {
    const rationale = (JSON.parse(shot.assistant) as { rationale?: string }).rationale;
    if (rationale !== undefined) assert.equal(thinkingRejection(rationale, TERMS), null, rationale);
  }
});

test("owner-instruction rationales never go public: they paraphrase private chat", () => {
  assert.equal(think("Approach the owner.", "come_to_player", "owner_instruction"), "Working out what the owner asked for…");
  assert.equal(think(null, "respond", "owner_instruction"), "Working out what the owner asked for…");
});

const thinkWith = (spectator: string | null | undefined, rationale: string | null, callType: "background_director" | "goal_decision" | "owner_instruction" = "background_director"): string =>
  publicThought({ spectator, rationale, tool: "collect_resource", callType, privateTerms: TERMS });
/** The real rationale shape that fails the filter ~97% of the time. */
const COUNTING = "The goal requires the torches stockpile to reach 128. The current state shows the stockpile is at 66.";

test("a clean spectator line is shown in preference to the rationale", () => {
  assert.equal(thinkWith("Chopping trees so I can make more torches.", COUNTING), "Chopping trees so I can make more torches.");
  assert.equal(thinkWith("Chopping trees so I can make more torches.", "Gather logs and deposit them at home."), "Chopping trees so I can make more torches.");
  assert.equal(thinkWith("  Smelting   some iron_ingot bars. ", null, "goal_decision"), "Smelting some iron ingot bars.");
});

test("a doubtful spectator line gets the same checks and falls back to the rationale, then the fixed phrase", () => {
  for (const [line] of BAD) {
    assert.equal(thinkWith(line, "Gather logs and deposit them at home."), "Gather logs and deposit them at home.", line);
    assert.equal(thinkWith(line, COUNTING), "Deciding what to gather next…", line);
    assert.equal(thinkWith(line, null), "Deciding what to gather next…", line);
  }
  // Absent spectator lines leave the old behavior unchanged.
  assert.equal(thinkWith(undefined, "Gather logs and deposit them at home."), "Gather logs and deposit them at home.");
  assert.equal(thinkWith(null, COUNTING), "Deciding what to gather next…");
  assert.equal(thinkWith("x".repeat(200), "Gather wood."), "Gather wood.", "uncuttable line: next candidate");
});

test("owner-instruction thoughts stay the fixed phrase even with a clean spectator line", () => {
  assert.equal(thinkWith("Fetching some wood for a friend.", "Approach the owner.", "owner_instruction"), "Working out what the owner asked for…");
});

test("the spectator examples the prompts teach pass the filter", () => {
  const snapshot = {} as Parameters<typeof buildDirectorMessages>[0];
  const prompts = [...buildDirectorMessages(snapshot, "idle"), ...buildGoalDecisionMessages(snapshot, "goal")].map((m) => m.content).join("\n");
  const lines = [...prompts.matchAll(/"spectator":"([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(thinkingRejection(line, TERMS), null, line);
});

test("the fixed phrase follows the task type", () => {
  const cases: readonly [string | null, string][] = [
    ["collect_resource", "Deciding what to gather next…"],
    ["stockpile_maintenance", "Deciding what to gather next…"],
    ["build_design", "Planning the next part of the build…"],
    ["travel_to", "Choosing where to head next…"],
    ["defend_self", "Working out how to stay safe…"],
    ["wait", "Deciding it's a good time for a break…"],
    ["complete_goal", "Checking that the plan is finished…"],
    ["abandon_goal", "Rethinking the current plan…"],
    ["craft_item", "Thinking about what to do next…"],
    ["constructor", "Thinking about what to do next…"],
    [null, "Thinking about what to do next…"],
  ];
  for (const [tool, phrase] of cases) {
    assert.equal(fallbackThought(tool, "background_director"), phrase, String(tool));
    assert.equal(publicThought({ rationale: "Gather wood at 12 64 -3.", tool, callType: "goal_decision", privateTerms: TERMS }), phrase, String(tool));
  }
});

test("long rationales are cut on a word boundary within the cap", () => {
  const long = "Gather more oak logs from the forest so there is enough wood for planks, sticks, a crafting table and a big batch of torches before night falls again.";
  const text = think(long);
  assert.ok(text.length <= THINKING_MAX_CHARS + 1, text);
  assert.ok(text.endsWith("…"));
  assert.ok(long.startsWith(text.slice(0, -1)), "the cut keeps a prefix of the original");
  assert.ok(/\w…$/.test(text), "no dangling punctuation or half word");
  assert.ok(long.charAt(text.length - 1) === " " || long.charAt(text.length - 1) === ",", "ends on a word boundary");
  assert.equal(capAtWord("x".repeat(200)), null);
  assert.equal(think("x".repeat(200)), "Deciding what to gather next…", "no boundary to cut at: replaced");
  // The checks see the whole text, not just the part that fits.
  assert.equal(think(`${"Gather wood ".repeat(12)}for Barnabyisbig.`), "Deciding what to gather next…");
});
