/**
 * ffmpeg's stderr can echo the output URL, and so the stream key. Lines are
 * reassembled across chunk boundaries before filtering, URLs of any rtmp(s)
 * form and the literal key are masked, and lines are length-capped.
 */
const URL_RE = /\b(rtmps?|rtmpt|rtmpe|srt|https?):\/\/[^\s'"]*/gi;
const MAX_LINE = 300, MAX_PENDING = 8192;

export function redactLine(line, secrets = []) {
  let out = line.replace(URL_RE, (_m, scheme) => `${scheme.toLowerCase()}://[redacted]`);
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  // Long opaque tokens (keys look like xxxx-xxxx-xxxx-xxxx-xxxx) never belong in a log line.
  out = out.replace(/\b[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}(-[\w]{4})?\b/g, "[redacted]");
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE)}…` : out;
}

/** Feed raw chunks; emit(line) receives complete, redacted lines. */
export function lineRedactor(emit, secrets = []) {
  let pending = "", skipping = false;
  const flushLine = line => { const text = line.replace(/\r$/, ""); if (text.trim()) emit(redactLine(text, secrets)); };
  return {
    push(chunk) {
      pending += String(chunk);
      const parts = pending.split(/\n|\r(?!\n)/);
      pending = parts.pop() ?? "";
      // The tail of a skipped runaway line is dropped too: a fragment could hold part of a secret.
      if (skipping && parts.length) { parts.shift(); skipping = false; }
      for (const line of parts) flushLine(line);
      // A runaway line without newlines must not grow without bound.
      if (pending.length > MAX_PENDING) { pending = ""; if (!skipping) emit("[overlong line dropped]"); skipping = true; }
    },
    end() { if (pending && !skipping) flushLine(pending); pending = ""; skipping = false; },
  };
}
