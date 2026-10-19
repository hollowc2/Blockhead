/** Public Q&A deliberately has no LLM client, tools, persistence or snapshot access. */
export interface PublicFacts {
  connected: boolean;
  health: number | null;
  hunger: number | null;
  time: "day" | "night" | null;
  activity: "idle" | "working" | "resting" | "recovering";
  actions: boolean;
}
export function publicFacts(input: PublicFacts): PublicFacts {
  const rounded = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) ? Math.round(Math.max(0, Math.min(20, n))) : null;
  return {
    connected: input.connected === true, health: rounded(input.health), hunger: rounded(input.hunger),
    time: input.time === "day" || input.time === "night" ? input.time : null,
    activity: ["idle", "working", "resting", "recovering"].includes(input.activity) ? input.activity : "working",
    actions: input.actions === true,
  };
}
export function answerPublicQuestion(question: string, input: PublicFacts): string {
  const facts = publicFacts(input);
  if (!facts.connected) return "I'm offline right now. — CobbleBob";
  if (/health|hunger|food|how.*going/i.test(question)) return `My health is ${facts.health ?? "unknown"}/20 and hunger is ${facts.hunger ?? "unknown"}/20.`;
  if (/time|day|night/i.test(question)) return facts.time ? `It's ${facts.time} here.` : "I don't know the time right now.";
  if (/doing|busy|working|idle/i.test(question)) return `I'm ${facts.activity}. Simple actions work while Bob is idle.`;
  return `I'm CobbleBob. I can share my connection, health, hunger, time and general activity. Use the buttons for simple actions${facts.actions ? "." : " when available."}`;
}
