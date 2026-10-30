# Model-backed public questions through Aegis (2026-10-24)

> **Superseded 2026-10-29** by [public-model-answer-enablement.md](public-model-answer-enablement.md):
> public questions now also require an enforcing `aegis.readiness/1` report, the
> enforcement-required header and an enforced reply; only a 403 with an Aegis
> verdict code is a refusal; aliases of `llm.base_url` are refused; abandoned work
> is settled before the model queue moves on. The enabling steps below are
> incomplete without that package. Model answers were disabled live on 2026-10-29.

Public visitors can ask CobbleBob free-form questions answered by the LLM.
Every such call goes through the Aegis-ML firewall; nothing else changes.

## What goes where

- **Public questions** (`/api/public/question`, when `model_questions.enabled`):
  a separate `LlamaClient` pointed at `model_questions.base_url` (Aegis).
- **Owner chat, "Give a task", director and goal decisions**: unchanged, straight
  to `llm.base_url`, unfiltered.

If `model_questions.base_url` equals `llm.base_url`, the bot logs an error and
keeps public questions rules-based, so public text can't bypass the firewall
by misconfiguration.

## Behaviour

- The model sees `publicFacts()` only (connection, health, hunger, time,
  activity, actions), in the system message. The visitor's question is the only
  user message, so Aegis with `SCAN_ROLES=user` scans exactly the untrusted text.
- Answers only: no tools or actions. Answers are cleaned with `cleanAnswer`
  (think blocks stripped, 600-char cap) and the response is capped at 500 chars.
- Aegis 403 (flagged input or leaked canary): in-character refusal
  (`BLOCKED_ANSWER`).
- Model slow, down, empty or erroring: the existing rules-based answer.
- A model question gets a 45 s deadline (`PUBLIC_LIMITS.modelDeadlineMs`)
  because llama.cpp is shared with the bot's own decisions; rules-based
  questions keep 8 s. Existing per-IP and global limits are unchanged
  (1 question per IP per 30 s, 1 per 15 s globally, 120 per hour).
- Safety interrupts (task changes, damage, night, hostiles) cancel public
  actions only. A question waiting on the model is left to finish, since
  answering never moves the bot; otherwise routine task changes cut answers
  off and they fell back to rules (seen on the first live attack question).
- Each public interaction log record now carries `answeredBy`
  (`model`, `rules` or `firewall`); diagnostics report `modelQuestions`.

## Enabling

Off by default. With Aegis running on loopback (see the Aegis-ML runbook):

```yaml
dashboard:
  public_viewer:
    interactions:
      questions_enabled: true
      allowed_origin: https://<public origin>
      model_questions:
        enabled: true
        base_url: http://127.0.0.1:8000   # Aegis, never llama.cpp
        request_timeout_ms: 40000
```

Roll back by setting `model_questions.enabled: false` (or removing the block)
and restarting the bot.
