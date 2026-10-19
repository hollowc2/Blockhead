import type { ViewerChatResult } from "./viewer-chat.js";

export const MAX_COMMAND_CHARS = 500;

/** The private viewer uses the existing owner command channel, never the Q&A model. */
export function createViewerCommand(options: {
  deliver: (command: string) => void;
  now?: () => number;
}): (raw: unknown) => Promise<ViewerChatResult> {
  const now = options.now ?? Date.now;
  let lastSent = -Infinity;
  return async (raw) => {
    if (typeof raw !== "string") return { ok: false, status: 400, error: "Enter a task for CobbleBob." };
    const command = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!command || command.length > MAX_COMMAND_CHARS) return { ok: false, status: 400, error: `Use 1–${MAX_COMMAND_CHARS} characters for a task.` };
    // Stop must remain available even immediately after another instruction.
    const stopping = /^(?:(?:cobblebob|cobble|bob)[\s,!?.]+)?(?:stop|cancel)[!?.]*$/i.test(command);
    if (!stopping && now() - lastSent < 1000) return { ok: false, status: 429, error: "Wait a second before sending another task." };
    try {
      options.deliver(command);
      lastSent = now();
      return { ok: true, answer: "Sent to CobbleBob. Watch his reply and task status." };
    } catch {
      return { ok: false, status: 503, error: "CobbleBob is disconnected. Try again when he reconnects." };
    }
  };
}
