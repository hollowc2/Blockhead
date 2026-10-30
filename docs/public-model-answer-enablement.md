# Public model answers through Aegis — enablement package (2026-10-29)

**Decision: the candidate meets the enablement criteria locally and on an
isolated real stack. It is ready for a bounded, authorized trial. Public model
answers stay disabled until that trial is authorized and its staged Aegis checks
pass on Maia.** Nothing live was changed: Maia still runs Aegis `ec36ec9` in
monitor mode, Blockhead `87ec52c` has `model_questions.enabled: false`, and the
code below is uncommitted in both repositories.

Evidence: [sanitized evidence file](investigations/public-model-answer-enablement-2026-10-29.json).
It separates read-only live observations, the isolated stack and tests. It has
no tokens, prompts, canaries, questions or answers.

## Baseline (read-only Maia, 2026-10-29)

- Aegis: user `aegis.service`, runtime `~/.local/share/aegis-runtime` at
  `ec36ec9b` (clean, detached), unit with no drop-ins, settings only from
  `~/.config/aegis/aegis.env` (0600, not read). There is no `.env` in the runtime
  directory. Process environment overrides `.env` under pydantic-settings.
  Effective allowlisted settings: `ENFORCEMENT_MODE=monitor`,
  `REDACT_PROMPTS_IN_LOGS=false`, `SCAN_ROLES=user`, cascade2 INT8,
  `BACKEND_TIMEOUT=60`, `AUDIT_RETENTION_DAYS=30`, `LOG_LEVEL=INFO`, loopback:8000.
- Source: `/mnt/Repos/Utilities/Aegis-ML`, branch `cobblebob-prod` at
  `4b46205` (docs only after `ec36ec9`). `uv.lock`/`pyproject.toml` hashes match
  the runtime. Work is on the new branch `public-enforcement`.
- In `ec36ec9`, monitor mode forwards flagged input (output guard still
  applies). A classifier *error* in monitor mode was also forwarded. `/health`
  says only "classifier loaded". The httpx client followed redirects. Nothing
  cancelled backend work when the caller left.
- The Aegis audit DB holds 10 rows with raw visitor text (mode 0644). None of the
  journals (llama-server, Aegis, Blockhead) or Blockhead log files contain the
  public system-prompt marker. `blockhead.log` is ~597 MB, mode 0644.
- llama-server b11425 runs with 4 slots and unified KV, so orphaned public work
  runs *alongside* owner requests, not just ahead of them.

## What changed

### Aegis (`public-enforcement`, not committed)

- `x-aegis-require-enforcement` request header (`app/api/routes.py`): monitor
  mode or an unloaded classifier → 503 `enforcement_unavailable`, before any
  classification or backend call.
- Classifier errors and `INPUT_GUARD_TIMEOUT` (5 s) block with 403
  `guard_unavailable` in **every** mode (`input_guard.py`). Output-guard failures
  return `guard_unavailable` too, so Blockhead never presents an infrastructure
  failure as a verified verdict.
- `GET /aegis/readiness` (`aegis.readiness/1`): readiness, fixed reason codes,
  enforcement, classifier state, scanned roles, redirect/stream/cancellation
  capability, whether the audit keeps prompt text, open backend requests
  (`backend_inflight`), revision and per-boot instance. It has no URLs or tokens.
  Only loopback can reach it, and it confers no management authority.
- Replies carry `x-aegis-enforcement: enforce|monitor`.
- `follow_redirects=False`: a 3xx from the backend becomes a 502.
- `backend_call`: one total `BACKEND_TIMEOUT` bound, counted in
  `backend_inflight` until it really finishes. A caller that left during
  classification never starts backend work. A disconnect mid-request cancels the
  task and closes its upstream connection (polled every 250 ms).
- `BACKEND_STREAM=true`: Aegis streams from llama-server internally, then
  assembles one non-streaming reply (bounded at 1 MiB, output guard unchanged).
  **This is what makes cancellation work** (see below). Readiness reports
  `cancel_on_disconnect` only when it is on. Default off for other consumers.
- Privacy: exceptions are logged and returned as type names only. The
  `aiosqlite` DEBUG logger is silenced (it echoes SQL parameters, including audit
  text). Backend timeouts/errors and cancellations get fixed audit
  `output_verdict` codes.
- `deploy/public-enforce.conf` + `deploy/public-enforce.env`: a drop-in that adds
  a second, secret-free `EnvironmentFile` after `aegis.env` (later wins), plus
  `UMask=0077`.

### Blockhead (uncommitted)

- `src/llm/public-firewall.ts`: `PublicFirewall`. Before any public request it
  needs a fresh (30 s) readiness report, bounded to 2 s and 8 KiB, with no
  redirects. That report must show ready, enforce, classifier loaded, `user`
  scanned, no audit prompt text, no redirects, cancellation on disconnect and
  the expected header name. Anything else is a fixed reason (`monitor_mode`,
  `incompatible`, `http_status`, `unreachable`, ...). llama.cpp's own endpoints
  fail as `http_status`/`incompatible`. A 503 `enforcement_unavailable` or a
  network error forces a re-probe. A reply without `x-aegis-enforcement: enforce`
  is discarded. `sameEndpoint` folds loopback aliases and default ports.
- `src/llm/client.ts`: optional request headers, bounded reply reads, typed
  `LlmHttpError` (only a short `error.code`, never message text), and a
  `CompletionGuard`. `before` runs while holding model ownership, right before
  any request. `settle` runs, *still holding ownership*, after a request
  abandoned by its caller or its own timeout. Every fetch uses `redirect:
  "error"`. The owner client has no guard: same path, same retries.
- `settle()` polls readiness until `backend_inflight` is 0, bounded to 15 s. If
  it can't confirm that, the firewall goes `unsettled`: public model answers stay
  off until a probe shows zero open work, and the owner continues.
- `src/llm/public-model.ts`: the one production wiring, used by `index.ts` and
  the stack script. No retries, enforcement header, 64 KiB replies. Failure logs
  hold only the kind and attempt, because upstream error text can quote replies.
- `public-model-chat.ts`: only a 403 with an Aegis verdict code is a block
  (refusal). `guard_unavailable`, `not_ready`, `unverified`, `busy`, `timeout`,
  `cancelled`, `empty` and `error` are fixed outcomes with a rules answer.
  Timeouts/cancellations are never answers.
- `public-interactions.ts`: the deadline aborts with `TimeoutError`. Every log
  record has a fixed `modelOutcome` (`abandoned` if the visitor left first), plus
  a `model_settled` record under the same request ID when the model work ends.
  Diagnostics add `modelOutcomes` and `modelFirewall`.
- Unchanged: owner chat, director and goals still go straight to `llm.base_url`.
  Public messages are one system message from `publicFacts()` plus the visitor's
  question; no tools or actions; nothing in memory or tasks. The queue keeps 64
  max, one outstanding public job, private priority and a public turn after
  three private jobs.

## Effective policy against Blockhead's real message shape

Blockhead sends exactly `[system: rules + publicFacts JSON, user: question]`,
with no `tools`/`tool_choice` (the body keys are asserted in tests). With
`SCAN_ROLES=user`, Aegis scores only the visitor's text (asserted against the
real route). The system prompt (which cascade2 flags) is not scanned. Visitors
can't select roles, models, endpoints or policy: the body is built server-side,
and the base URL and headers are configuration. A canary is appended to the
system prompt and leaked canaries are blocked. Moderation is an extra defense:
the classifier catches known injection styles, not all prompt injection, and the
model can still produce wrong or unkind prose within the 1–3 sentence limit.

## Cancellation evidence (isolated stack)

Zeus ran Maia's exact llama-server b11425 binary (CUDA backend removed, CPU,
Qwen3.5-9B Q5_K_M, 4 slots), candidate Aegis (cascade2 INT8, enforce), a
monitor-mode instance and the `ec36ec9` baseline. All were on loopback and torn
down afterwards. The script is `scripts/validate-public-model-stack.ts`.

| Probe | Result |
|---|---|
| Benign question (production wiring) | model answer, 1 backend launch |
| Guard-positive synthetic input | refusal in 6 ms, **0** backend launches |
| Monitor Aegis / `ec36ec9` / direct llama as firewall / `localhost` alias | rules fallback, **0** launches |
| Required-enforcement header on monitor Aegis | 503 `enforcement_unavailable` |
| Abort while queued behind owner work | cancelled, only the owner job launched |
| Abort while generating, owner waiting | Aegis upstream closed 209 ms after abort; owner request started 257 ms after abort; llama logged cancel; slot released 4.4 s after abort |
| Client transport timeout | settled; slot idle 6.3 s after return (22.6 s without streaming) |
| Raw aborts ×4: `ec36ec9` / direct non-stream / candidate+stream | llama cancel logged 0/4 / 0/4 / **4/4** |
| Owner behind an uncancelled public answer | waited 20.8 s (the public answer took 20.3 s on CPU) |

Findings:

1. **llama-server b11425 often ignores a closed non-streaming request.** Two of
   three direct aborts and all candidate aborts without streaming ran 16–26 s to
   completion. Streaming made every abort cancel. So Aegis streams upstream, and
   Blockhead requires `cancel_on_disconnect`.
2. **The cancel lands at the next batch boundary.** One trial logged cancel 4.0 s
   after launch (at the abort) but released at 12.6 s with 252 tokens: it was
   still evaluating the prompt. Qwen3.5's hybrid layers can't reuse a partial
   prefix, and the per-request canary changes the prompt, so each guarded
   request re-evaluates the whole prompt (~250 tokens). On Zeus CPU that's ~12 s
   that can't be interrupted. Maia's GPU prompt rate (~585 tok/s) implies about
   0.5 s. **This has not been observed on Maia.** Settlement means Aegis has
   closed upstream; an already-running batch still finishes, and an owner
   request queued behind it waits for it.
3. **Owner delay is bounded but not zero:** at most one active public job (45 s
   question deadline, 40 s request timeout) plus settlement (≤ 15 s, then
   `unsettled`). In the `unsettled` failure case the owner may share the backend
   with leftover work for up to Aegis's `BACKEND_TIMEOUT` (60 s).

## Regression matrix (deterministic tests)

- Aegis `tests/test_enforcement.py` (24): required enforcement, flagged input
  never forwarded, user-only scanning, classifier error/timeout in both modes,
  readiness (ready/not ready/no secrets), redirects, disconnect/deadline in
  `backend_call`, pre-forward disconnect, real-uvicorn socket tests that the
  upstream connection closes (and a streaming backend stops at its next write),
  SSE assembly limits, output-guard failure code, and canaries absent from logs,
  the audit DB bytes and error bodies on six paths.
- Blockhead `public-firewall.test.ts` (10), `public-client.test.ts` (12, counting
  fake backend), `public-model-chat.test.ts` (13, up from 9): readiness
  acceptance/rejection, TTL, mid-session loss, unmarked replies, aliases, bounded
  bodies, no retry, firewall-only URLs, no tools, fixed error codes, abort while
  queued/probing/generating, own timeout, settlement holding ownership (a
  mutation that releases early fails two tests), unsettled → off, 20 abandon
  cycles with zero leftover queue/abort listeners, outcome honesty, settlement
  records, canaries absent from logs/diagnostics on all 11 outcomes, and question
  text not reaching gestures. Existing viewer security/auth suites are unchanged
  and green.

Commands and results: Blockhead `npm run typecheck` ✓, `npm test` **1032/1032**
(35.9 s), `npm run audit:production` ✓ (12 moderate, 0 high/critical, reviewed
UUID advisory), `git diff --check` ✓. Aegis `uv run pytest tests/` **142 passed,
18 skipped** (baseline 118/18), `ruff check app tests` ✓, `git diff --check` ✓.
Remaining ruff/format findings are in untouched files; mypy can't run in the
local venv (numpy stubs) before or after. No dependency changes.

## Logging and retention coverage

| Sink | Visitor question | Answer | Status |
|---|---|---|---|
| Blockhead `public interaction` records / diagnostics | no | no | fixed codes, IDs, durations (tested) |
| Blockhead debug log (`public_llm_*`) | no | no | now kind+attempt only (was raw error message) |
| Aegis audit DB | `[REDACTED]` with `REDACT_PROMPTS_IN_LOGS=true` | never stored | tested on six paths plus isolated run (21/21 redacted) |
| Aegis app/journal logs | no | no | request IDs, verdict codes, exception *types* (tested at DEBUG) |
| aiosqlite DEBUG | would echo audit parameters | — | silenced; keep `LOG_LEVEL=INFO` |
| uvicorn access log | path only | — | suppressed to WARNING |
| llama-server log/journal | not at default verbosity | — | 0 markers on Maia; never run with `-v` |
| Aegis error bodies → Blockhead | — | — | only `error.code` kept |

`REDACT_PROMPTS_IN_LOGS` affects only the audit `input_text` column: it never
covered answers (not stored), error text (now type-only) or downstream logs.
Audit `client_ip` is always Blockhead's loopback address, never a visitor's.
Not inspected: kernel/socket buffers and swap; Tailscale's own logs.

Proposed, not done: `chmod 600 ~/.local/share/aegis-runtime/logs/aegis_audit.db`,
`chmod 700` on its directory, and `UMask=0077` (in the drop-in). Retention drops
from 30 to 7 days for new pruning. **The existing 10 unredacted rows are a
separate remediation**: under its own authorization, either run
`UPDATE audit_log SET input_text='[REDACTED]'` on a backup-verified copy or let
retention prune them. `blockhead.log` (597 MB, 0644, no rotation) remains the
open item from the viewer receipt. No logs were deleted and journald was not
touched.

## Candidate deployment (prepared; requires authorization)

Order matters: Aegis is validated privately **before** Blockhead's model flag
changes. Blockhead fails closed against old or monitor-mode Aegis, so neither
order can serve unguarded answers. Services that restart: `aegis.service` once,
`blockhead.service` once. Minecraft, llama-server, journald, Funnel/Serve,
firewalls and gestures are unchanged.

0. **Commit** the reviewed Aegis branch and the Blockhead changes; record both
   SHAs (the immutable revisions for this rollout).
1. **Read-only preflight** (Maia): one bot process; Aegis PID/revision
   `ec36ec9`; `/aegis/readiness` → 404; `uv.lock` hash unchanged; free RAM ≥ 2 GB.
2. **Backups** in `~/.local/share/aegis-backups/<UTC stamp>/` (0700): tarball of
   the runtime excluding `.venv`, plus `git rev-parse HEAD`; an SQLite
   `.backup` of `aegis_audit.db` with `integrity_check`; the unit file; a
   `cp -p` copy of `aegis.env` (0600, never printed). Record SHA-256 of each.
   Blockhead backups follow the [viewer receipt's](public-viewer-deployment.md)
   staged process.
3. **Aegis code:** `git -C ~/.local/share/aegis-runtime fetch /mnt/Repos/Utilities/Aegis-ML <AEGIS_SHA> && git -C ~/.local/share/aegis-runtime checkout --detach FETCH_HEAD`,
   then `UV_PROJECT_ENVIRONMENT=$HOME/.local/share/aegis-runtime/.venv uv sync --locked --no-dev --extra serve`
   (expected no-op) and an import check. Don't run `install.sh --start`.
4. **Aegis settings:** `install -m 600 deploy/public-enforce.env ~/.config/aegis/public-enforce.env`,
   `install -D -m 644 deploy/public-enforce.conf ~/.config/systemd/user/aegis.service.d/public-enforce.conf`,
   `chmod 600` audit DB, `chmod 700` logs dir. `aegis.env` is not edited.
   `systemctl --user daemon-reload && systemctl --user restart aegis.service`.
5. **Private Aegis validation** (loopback only; each probe is one shared-model
   call). Expect readiness `ready:true, enforcement:"enforce",
   backend_stream:true, cancel_on_disconnect:true, audit_prompt_text:false`,
   revision = `<AEGIS_SHA>`. Then: one benign request with the header → 200 +
   `x-aegis-enforcement: enforce`; one synthetic guard-positive → 403 and no new
   `launch_slot_` in `journalctl --user -u llama-server`; one benign request
   aborted with `curl --max-time 1` → a `cancel task` line, and slot release
   timing **on the GPU**; new audit rows `[REDACTED]`. Stop and roll back Aegis
   if any check fails.
6. **Blockhead:** install the committed runtime per the staged receipt process,
   set `dashboard.public_viewer.interactions.model_questions.enabled: true` in
   `config/minecraft.yaml` (base URL stays `http://127.0.0.1:8000`), restart
   `blockhead.service` once. Check: one bot process, health/owner views,
   `public model firewall ready` at startup, authenticated diagnostics
   `modelFirewall.state: "ready"` with the expected revision.

## Bounded supervised trial (requires authorization)

Duration ≤ 2 hours with the owner watching; gestures stay off. Ask 5–10 benign
questions through the public page. Each should be `answerKind: model`. Log
records should show `modelOutcome: answer` and a `model_settled` record, with
`modelOutcomes`/`modelFirewall` in diagnostics and the queue back to zero. Owner
commands and autonomous decisions should stay responsive: compare their latency
with the pre-trial journal. Guard-positive or abort probes on the live endpoint
happen only if the authorization lists them (proposed: one synthetic
guard-positive question → `refusal`; one question with the tab closed while it
waits → `abandoned` then `model_settled`, settle failures 0).

Stop, then disable, on any of these:
- an answer while readiness is not `ready`;
- a reply without enforcement;
- `settleFailures > 0` or `unsettled`;
- `backend_inflight` above 0 at idle;
- owner starvation beyond one public job plus settlement;
- any visitor text in a sink;
- a restart loop, or a crash in Aegis or the bot.

## Disable and rollback

- **Fastest (no bot restart):** `systemctl --user stop aegis.service`. The next
  readiness probe fails (`unreachable`) and questions fall back to rules. To stop
  all Q&A, use the operator CLI and set `questions_enabled: false` (JSON on stdin
  to `scripts/operator-request.py public-interactions`).
- **Durable:** `model_questions.enabled: false` in the config, then restart
  `blockhead.service` (returns to the current rules-only state).
- **Aegis rollback:** remove the drop-in, `checkout --detach ec36ec9`,
  daemon-reload, restart. Do this only with Blockhead's model flag off or Aegis
  stopped. Blockhead would refuse the old Aegis anyway (no readiness → rules),
  but don't leave public model answers configured on against monitor mode.
- **Blockhead rollback:** use the receipt's captured procedure. Keep current
  SQLite/world progress, `operator.env` and `aegis.env` (both untouched by this
  rollout). No schema migration is involved.

## Remaining limitations and stale documentation

- The GPU cancellation latency and owner delay on Maia are unobserved (step 5
  measures them). Zeus used CPU and Python 3.12; Maia uses CUDA and 3.13 with
  the same lock.
- The readiness endpoint trusts whatever answers on the configured loopback port;
  a hostile local process is out of scope (see the launch assessment).
- Classifier coverage is limited: the six synthetic attacks in Aegis's replay
  fixture and one live-stack sample were blocked. Long-document attacks remain
  weak (Aegis benchmarks).
- [`public-model-questions-2026-10-24.md`](public-model-questions-2026-10-24.md)
  describes the old contract (any 403 = refusal, URL-string check only); it now
  has a pointer here. The October 29 receipt and launch assessment are historical
  and were not rewritten.
