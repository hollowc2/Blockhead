# Public model answers — live re-verification (2026-11-01, PST)

Re-checks the October 29 rollout
([deployment receipt](public-model-answer-deployment-2026-10-29.md)) against
the [enablement runbook](public-model-answer-enablement.md). Nothing was
deployed, restarted or reconfigured. Maia was already in the target state,
and the Aegis roadmap's "not deployed" entry was stale. It is now corrected.

## Live state (read-only)

- Aegis: `aegis.service` active since 2026-10-31 14:22 PDT (after a host reboot),
  0 restarts, runtime `26e0fcc` (clean). The `public-enforce.conf` drop-in, the
  `public-enforce.env` and `uv.lock` SHA-256 values match the October 29 receipt
  and the source. Audit DB 0600, logs dir 0700. Readiness: `ready`, `enforce`,
  cascade2 loaded, `scan_roles: [user]`, `backend_stream`, `cancel_on_disconnect`,
  `audit_prompt_text: false`, retention 7 days, `backend_inflight: 0`.
- Audit DB: before the probes it had 16 rows, all `[REDACTED]`. The 10 unredacted
  rows from before October 29 have aged out under the 7-day retention.
- Blockhead: `blockhead.service` active since 2026-10-31 19:25 PDT, 0 restarts,
  one bot (tsx wrapper plus node child), runtime `0ed2a31` (contains `d2e8371`),
  with `model_questions.enabled: true` → `http://127.0.0.1:8000`. Diagnostics:
  `modelQuestions: true`, `modelFirewall.state: ready` at revision `26e0fcc`,
  0 probe failures. Gestures/actions are off.

## Private Aegis probes (loopback, GPU)

| Probe | Result |
|---|---|
| Benign, enforcement header | 200 in 3.5 s, `x-aegis-enforcement: enforce`, 1 llama launch |
| Synthetic guard-positive | 403 `prompt_injection_detected` in 36 ms, **0** llama launches |
| Long answer, client closed at 1.5 s | `backend_inflight` 0 at 0.05 s; llama `cancel task` 0.05 s, slot release 0.09 s after the close |

## End to end through the public listener (loopback, configured origin)

| Probe | Response | Records (same request ID) | llama-server |
|---|---|---|---|
| 3 benign questions, 31 s apart | 200 `answerKind: model`, 1.8–2.2 s | `answer` + `model_settled: answer` | 1 launch/release each |
| Synthetic guard-positive | 200 `answerKind: refusal`, 30 ms | `blocked` + `model_settled: blocked` | **no launch** |
| Abandoned (socket closed at 0.4 s) | — | `abandoned`/`cancelled` + `model_settled: cancelled` (683 ms) | launch, `cancel task` 0.74 s later, release at 0.78 s |

Diagnostics afterwards: outcomes `answer 3, blocked 1, cancelled 1` and 0 for all
other outcomes. Firewall `ready`, `settles 1`, `settleFailures 0`, `maxSettleMs 283`.
`modelOutstanding 0`, an empty queue, and Aegis `backend_inflight 0`. 8 new audit rows,
all `[REDACTED]` (`allow/allow` 4, `allow/cancelled` 2, `block/n/a` 2). The probe
texts appear 0 times in `blockhead.log`, `blockhead-debug.jsonl` and the user
journal. No error-level bot records, 0 restarts. No owner/director model request
fell in the window, so owner latency wasn't re-measured.

## Notes

- Aegis `cobblebob-prod` still points at `4b46205`. Production runs `26e0fcc`
  from `public-enforcement`.
- The Blockhead runtime carries an uncommitted `src/skills/ensure-item.ts` change
  (the 2026-10-31 equipment repair in progress). It is unrelated to this path.
- Disable/rollback paths are unchanged: see the
  [deployment receipt](public-model-answer-deployment-2026-10-29.md#stop-conditions-disable-and-rollback).

## Later the same day: public exposure removed

- The owner turned Tailscale Funnel off (`tailscale funnel --https=443 off`). That
  also removed the tailnet-only `:443 → 127.0.0.1:3003` Serve route, so the public
  page is now reachable only on maia's loopback. Private Serve routes 3000/3001 are unchanged.
- With nothing public, `aegis.service` was stopped and disabled (`systemctl --user
  disable --now`), freeing about 340 MB. Blockhead was not restarted. A loopback
  question now gets `answerKind: rules` (the firewall fails closed). The config
  still has `model_questions.enabled: true`.
- To expose the page again: `systemctl --user enable --now aegis.service`, check
  readiness, then restore Serve/Funnel. Don't re-expose it with Aegis stopped and
  then rely on model answers.
