# Public model answers deployment — 2026-10-29 (PDT)

Following the user's instruction to proceed with the prepared
[enablement package](public-model-answer-enablement.md), Maia now runs Aegis
`26e0fcc` with enforcement and Blockhead `d2e8371` with
`model_questions.enabled: true`. Public visitors' questions are answered by the
model through the enforcing firewall. Gestures remain disabled. Nothing was
pushed. Only `aegis.service` and `blockhead.service` were restarted. Minecraft
(PID 43017) and llama-server (PID 988) kept their processes. There was no
journald, network, Funnel or firewall change.
[Machine-readable receipt](investigations/public-model-answer-deployment-2026-10-29.json).

## Aegis (from 01:43 UTC)

- Backup: `~/.local/share/aegis-backups/public-enforce-20261030T014319Z/`
  (0700). It holds the runtime archive, an audit DB online backup (integrity ok,
  10 rows), the unit, a 0600 copy of `aegis.env`, `SHA256SUMS` and `rollback.sh`.
- Runtime `ec36ec9` → `26e0fcc` (detached, clean). `uv.lock` was unchanged
  (`uv sync --locked` checked 99 packages, installed nothing). The
  `public-enforce.env` (0600) and `aegis.service.d/public-enforce.conf` drop-in
  were installed. `aegis.env` was not edited. Audit DB set to 0600, logs dir 0700.
- The user ran the install/restart command (the agent's own invocation was
  blocked by its permission policy). Result: active, PID 376813, 0 restarts.
  Readiness: `ready`, `enforce`, cascade2 loaded, `scan_roles: [user]`,
  `backend_stream: true`, `cancel_on_disconnect: true`,
  `audit_prompt_text: false`, retention 7 days, revision `26e0fcc`.
- Private loopback probes (one shared-model call each):

  | Probe | Result |
  |---|---|
  | Benign, enforcement header | 200 in 2.8 s, `x-aegis-enforcement: enforce` |
  | Synthetic guard-positive | 403 `prompt_injection_detected` in 15 ms; audit `block`/`n/a` (never forwarded) |
  | Benign long answer, client aborted at 1.5 s | Aegis upstream closed in 0.14 s; llama-server `cancel task` **0.09 s** and slot release **0.12 s** after the abort (GPU) |
  | Audit | 3 new rows, all `[REDACTED]` |

## Blockhead (02:13–02:16 UTC)

- Staged `d2e8371` in `~/.local/share/blockhead-releases/public-model-d2e8371`,
  with hard-linked dependencies (lock hash identical). On Maia (Node v26.7.0):
  typecheck ✓, **1032/1032** tests, production audit 12 moderate / 0 high.
- Backup: `~/.local/share/blockhead-backups/public-model-20261030T021355Z/`.
  It holds the config before the change (hash matches the October 29 receipt),
  the unit and drop-ins, an SQLite online backup taken with the bot stopped
  (integrity ok), `SHA256SUMS` and `rollback.py`.
- The bot was stopped, and the runtime fast-forwarded `87ec52c` → `d2e8371`.
  **Deviation:** the first script's config regex didn't allow for the comment
  line inside `model_questions`. It stopped with the bot down and the config
  unchanged, for about 2.5 minutes until the corrected script ran. The corrected
  script changed exactly two lines: the stale "keep off" comment, and
  `enabled: false` → `true`. Parsed flags: viewer on, questions on, actions off,
  model on, model URL `:8000`, LLM URL `:8080`.
- Started once: active, PID 379774, 0 restarts, one bot (tsx wrapper plus node
  child), connected at health 20, 0 warning/error journal records. The startup
  log reads `public model firewall ready` (revision `26e0fcc`). Authenticated
  diagnostics GET: `modelQuestions: true`, `modelFirewall.state: ready`,
  `probeFailures: 0`.

## Supervised trial so far

Three benign questions went through the public listener on loopback, with the
configured origin, 31 s apart. All returned HTTP 200 with `answerKind: model`
in 1.46–1.78 s. Each produced a `model_settled` record and an accepted record
under the same request ID, with fixed fields only. Afterwards, diagnostics
showed `modelOutcomes.answer: 3` and no other outcomes, `modelOutstanding: 0`,
`settleFailures: 0`, and Aegis `backend_inflight: 0`. No synthetic guard-positive
or abandoned-tab probe was sent through the live public page; those weren't
explicitly included in the authorization.

Not yet observed: an owner or autonomous model call on the new code. For more
than 13 minutes after the restart, the bot ran deterministic background work
(`upgrade_equipment` branch mining) that doesn't use the model. Its LLM client
reported zero failures. The owner path is unchanged in code and covered by
tests, but the live observation is pending.

## Stop conditions, disable and rollback

Stop conditions are in the [enablement package](public-model-answer-enablement.md#bounded-supervised-trial-requires-authorization).

- **Fastest disable:** `systemctl --user stop aegis.service`. Public questions
  fall back to rules on the next question, with no bot restart.
- **Durable disable:** set `model_questions.enabled: false`, then restart
  `blockhead.service`.
- **Blockhead rollback:** `python3 ~/.local/share/blockhead-backups/public-model-20261030T021355Z/rollback.py`
  restores `87ec52c` and the flag off, keeping SQLite/world progress.
- **Aegis rollback:** `~/.local/share/aegis-backups/public-enforce-20261030T014319Z/rollback.sh`.
  Blockhead refuses the restored `ec36ec9` (it has no readiness endpoint) and
  answers with rules.

## Still outstanding

- The 10 earlier unredacted audit rows. They now sit in a 0600 file and will
  age out under the 7-day retention, unless separately remediated.
- `blockhead.log` (598 MB, 0644, no rotation).
- The remaining launch gates from the
  [October 29 receipt](public-viewer-deployment.md): tailnet ACLs, Minecraft
  ingress, forwarded-address trust, and a paired restore rehearsal.
