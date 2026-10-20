# Anonymous public Q&A and simple commands

Status: deployed on Maia; deterministic Q&A enabled privately in memory. Follow-up found a food-readiness dependency deadlock; a tested one-file repair awaits explicit deployment/restart approval. Actions remain disabled pending a genuine safe-idle window. Both configured startup defaults remain false; the exact HTTPS origin is configured. Model-backed Q&A remains unavailable. Network exposure is unchanged.

## Goal

Let visitors ask CobbleBob questions and click four simple action buttons on the existing public viewer. No accounts, arbitrary task instructions, movement commands, persistent visitor tasks, or new public ports.

The first release offers:

- **Say hello:** send the fixed Minecraft message `Hello, everyone!`.
- **Wave:** swing Bob's main arm once, without attacking or using an item.
- **Look left:** turn 45 degrees left, preserving pitch and position.
- **Look right:** turn 45 degrees right, preserving pitch and position.

All four commands are available only while Bob is safely idle. A busy Bob refuses the request immediately; it does not wait in a queue. Questions remain read-only and responses appear only in the requesting visitor's browser.

These commands provide visible interaction without granting access to Bob's existing owner task controls. Additional commands require a separate review of their effects and safety checks.

## Current code and the boundary to preserve

- `src/dashboard/viewer-shell.ts` has separate private and public HTTP handlers. The public handler currently allows the viewer and redacted state, and refuses command/chat POSTs.
- `src/index.ts:deliverOwnerCommand` emits a Minecraft chat event as the configured owner. The public implementation must never call it or forward to the private command route.
- `src/dashboard/viewer-chat.ts` is tool-free, but its context includes private self/path information, task text, errors, and model rationale. It cannot be reused as the public context builder.
- `src/llm/client.ts` serializes requests process-wide through `requestTail`. Its existing requests can use 512 output tokens, the configured timeout, and retries. A public question must not enter this potentially long FIFO unchanged.
- `src/agent/world-actions.ts` provides action ownership and cancellation. Public gestures must not race existing movement, eating, combat, or world actions.

Keep the existing public state allowlist, viewer redaction, socket limits, security headers, and private controls. The work below adds narrow public capabilities through explicit handlers.

## 1. Public API and UI

Add exactly two public POST routes:

- `POST /api/public/question` with strict JSON `{ "question": "What are you doing?" }`.
- `POST /api/public/action` with strict JSON `{ "action": "wave" }`; allowed IDs are `hello`, `wave`, `look_left`, and `look_right`.

Reject unknown fields, unknown action IDs, arrays, oversized strings, and all action arguments. An action body cannot contain a message, tool name, player, coordinates, amount, or task ID. Use an explicit enum and switch; never dynamic property dispatch or model interpretation.

Return a small typed response with a fixed result code and safe display text. Use 400 for invalid input, 403 for origin refusal, 413 for size, 415 for content type, 429 for limits/capacity, and 503 for disabled/offline/unavailable service. Include `Retry-After` with throttled responses. Do not return internal exceptions.

The public page gets one question form, four buttons, and a short status/reply area. Explain: “Simple actions work while Bob is idle.” Disable buttons while submitting and when public state says unavailable. Server checks remain authoritative even if someone bypasses the UI.

Use text-only DOM rendering (`textContent`), no HTML/Markdown rendering, links, automatic URL fetching, or shared visitor message feed. Do not automatically retry actions or questions. A lost action response should say delivery could not be confirmed.

The private `/api/command`, `/api/chat`, dashboard, and operator endpoints must remain unreachable through the public listener. Public question text must never become Minecraft chat, owner instructions, goals, or model context for autonomous decisions.

## 2. Restricted action controller

Create a small public-action controller with only the four explicit operations above. It has no reference to `deliverOwnerCommand`, the tool registry, goal creation, terrain/building managers, or inventory/container APIs.

Before every action, check authoritative session and ownership state:

- Public actions are enabled and the same live bot session is connected/spawned.
- No active, runnable queued, paused, or resumable owner/system/background task; no pending autonomous work or decision; no bootstrap, recovery, or shelter activity.
- No action lease is active or waiting; Bob is not pathfinding, digging, placing, using/eating an item, sleeping, riding, falling, or swimming.
- Bob is grounded and safe, above the configured health retreat threshold, without a current hostile threat or survival interrupt.

If any required fact is missing, refuse. Do not guess idle state from the cached dashboard snapshot alone.

Reserve public action ownership before the first asynchronous operation, using the existing action executor with immediate admission only. If necessary, add a small `tryRun` facility that refuses when ownership is occupied or pending; do not enqueue behind another action. Recheck session identity and safety after acquiring ownership and immediately before execution.

Allow at most one public action at a time, with a one-second execution budget. Use a single immediate turn for look commands, not a sustained look loop or delayed restoration. Wave is animation only: no attack, activate-item, block interaction, or movement calls. Hello is a constant string, never visitor text.

Owner commands, safety interrupts, disconnects, and disabling actions invalidate pending public work. Cancellation/timeout must prevent a late continuation from acting on a new session or restoring an old orientation. Do not release ownership while an asynchronous primitive can still issue commands; if settlement cannot be confirmed, disable public actions until the session is safe again. No gesture should clear Bob's movement controls or cancel his task as cleanup.

No public tasks are persisted or resumed. This avoids adding visitor permissions to the full goal/task system for this release.

## 3. Read-only public Q&A

Create a separate public context builder from a fresh allowlisted object. Do not send the full dashboard snapshot, private Q&A context, or raw event/story strings to the model.

Allowed context:

- Connected/offline state.
- Rounded health/hunger and day/night.
- A fixed activity enum such as `idle`, `working`, `resting`, or `recovering`, derived in code rather than copied from task text.
- Which public actions are currently available.

Exclude coordinates, player names, inventory, task/goal descriptions, chat, errors, filesystem paths, endpoints, prompts, model rationale, and raw logs. Render the bot's public display name as a fixed product label.

Use a dedicated tool-free prompt: answer briefly as Bob using the supplied public facts; admit uncertainty; direct requests for actions to the buttons. A question cannot authorize an action. Do not rely on the prompt to hide information: private information must never enter this request.

Set initial hard bounds:

- Question: 200 Unicode characters after trimming/control-character cleanup.
- Public context: at most 2 KiB of UTF-8 JSON.
- Output: at most 120 model tokens, then at most 500 displayed characters.
- Deadline: eight seconds end-to-end, including admission/model lookup/response reading; no public retries.
- Upstream response body: enforce an actual streaming byte cap, initially 64 KiB, before JSON parsing.

Extend the existing LLM admission code with a public attempt that starts only if no internal request is running or waiting. Allow one public generation and zero public waiters across the process. A second client instance with the same FIFO is insufficient. When internal work arrives, abort public generation; skip aborted requests before they can call the model. Release the slot only after transport settlement, with a bounded failure path.

Verify against the installed llama.cpp runtime that disconnect/abort stops generation. A client-side timeout alone is not proof that GPU work stopped. If cancellation or the eight-second budget cannot be demonstrated, keep model-backed public Q&A disabled and provide deterministic answers from the same public fields until corrected. A shared model can impose bounded delay; do not claim zero impact without evidence.

Public questions and answers stay out of Bob's memory and autonomous decision inputs. Render model output only as text in the requesting browser.

## 4. Anonymous abuse controls

Use no accounts, public bearer secret, or new session system. IP limits reduce casual abuse; global budgets bound consumption even when visitors rotate IPs. Anonymous users can exhaust a small shared allowance, so fairness is best-effort and the UI should explain cooldowns plainly.

Initial server-enforced limits:

- Questions: one per IP per 30 seconds; globally one start per 15 seconds and at most 120 starts per rolling hour; one in flight and no queue.
- Actions: one per IP per 10 seconds; globally one accepted action per five seconds, with hello additionally limited to once per 30 seconds.
- Both POST routes: per-IP attempt limit of 10 per minute, plus a combined process-wide limit of 120 attempts per minute, including invalid requests. Reuse the existing public HTTP limiter as an outer layer.
- Request body: at most 1 KiB of actual received bytes, regardless of `Content-Length`; reject unsupported content encodings and cap body-reading time at five seconds.
- At most eight public interaction requests may be reading/processing at once; refuse excess before reading a body. Timeouts and disconnects must release counters in `finally`.

Use bounded limiter storage with expired-entry cleanup. Reject new keys when the interaction limiter is full rather than evicting active limits to admit a flood. Normalize IP addresses, including IPv4-mapped IPv6; group IPv6 clients by /64 for abuse limits using a tested address parser. Do not log raw addresses as routine interaction records. Daily/hourly limits are process-local for this single-process release; restarts reset them. Do not run multiple replicas without shared limits.

Require `application/json`, an exact match to a configured public HTTPS Origin, and refusal of cross-site Fetch Metadata. Send no permissive CORS headers. An absent Origin is refused for these browser-only routes. Origin checks stop unwanted browser requests; scripts can forge them, so all validation and limits still apply.

Only trust forwarded client addresses from the existing verified loopback proxy path. Validate the actual Funnel forwarding behavior during deployment before relying on `clientAddress(request, true)`. Ignore client-supplied forwarding/identity headers outside that path; continue stripping the public marker and other unapproved forwarded headers. No route, query parameter, or header may select private mode.

Keep public interaction processing inside the existing allowlisted public listener. No generic proxy to the bot's private API, raw viewer server, or LLM endpoint. These routes do not provide protection against an upstream bandwidth flood; application limits bound work reaching Bob.

## 5. Configuration and observability

Add a small Zod-validated `dashboard.public_viewer.interactions` section with:

- `questions_enabled: false` and `actions_enabled: false` by default.
- `allowed_origin`, required to enable either feature and restricted to an HTTPS origin without a path/query.

Keep the reviewed limits as named constants initially rather than exposing numerous tuning settings. Add a loopback/private operator-only control to disable questions and actions independently at runtime; disabling immediately blocks admissions and cancels in-flight public work. Re-enabling uses the same private control, and service restarts use the configured defaults. Do not expose this control through the public listener or embed its authority in public JavaScript.

Log bounded structured records: time, generated request ID, feature/action ID, accepted/refused outcome, duration, and fixed reason code. Do not log raw questions, answers, IPs, model requests, or exceptions in public responses. Keep aggregate accepted/rejected/timeout counters and current in-flight counts available privately. Reuse existing logging rather than creating a new monitoring stack.

## 6. Implementation sequence and files

1. **Policy and public data:** add `src/dashboard/public-interactions.ts` for strict schemas, limits, and response codes; add `src/dashboard/public-chat.ts` for the public context and prompt. Extend `src/config/schema.ts`; document disabled defaults in `config/minecraft.yaml`.
2. **Model admission:** update `src/llm/client.ts` with bounded, cancellable, no-queue public inference while preserving existing internal behavior. Add focused client tests for internal priority and cancellation.
3. **Action admission:** add `src/agent/public-actions.ts` with the four-operation controller. Add immediate lease admission in `src/agent/world-actions.ts` only if needed. Wire current session/safety facts and private disable control in `src/index.ts` and the existing private operator channel.
4. **Transport:** add explicit public handlers in `src/dashboard/viewer-shell.ts`, preserve private route refusal, and pass separate public callbacks through `src/dashboard/prismarine-adapter.ts`. Reuse `src/dashboard/http-guard.ts` where appropriate without changing existing viewer limits accidentally.
5. **UI:** update `src/dashboard/public/viewer-shell.html`, `.js`, and `.css` with public Q&A and four buttons. Add only sanitized availability flags to `src/dashboard/public-state.ts`. Keep private task controls distinct.
6. **Verification and rollout:** complete the acceptance tests below, review the final diff, and prepare a deployment manifest/rollback procedure for the exact candidate files.

The checkout already contains other viewer and movement changes. Preserve them, identify the runtime baseline, and package only reviewed changes for deployment. Do not copy the entire working tree to the running service.

## 7. Required acceptance tests

Automate the trust-boundary tests; use fake bots/models for action and transport coverage.

- Only the four exact action IDs execute. Unknown fields, nested payloads, prototype-like keys, arbitrary text, and owner command strings cannot invoke other capabilities.
- Spies prove public handlers never call owner delivery, the generic tool registry, scheduler enqueue/cancel, goal creation, movement, attack, dig/place, or inventory operations.
- Each action performs its exact fixed effect once; look preserves pitch/position, and wave never attacks or uses an item.
- Busy/unsafe/offline/missing-state checks refuse actions. Two concurrent submissions produce at most one action. A new owner/safety event, disable, timeout, or reconnect prevents stale execution.
- Seed every private snapshot field with recognizable secrets. None appear in public model input, responses sourced from that state, availability flags, or public errors. Test malicious task/event strings as well as coordinates and names.
- Injection attempts in questions cannot produce an action or change permissions. HTML/script-looking questions and model output remain inert text. No public message enters autonomous context or persistence.
- A public model request cannot queue behind internal work. Internal arrivals cancel public inference; disconnect/timeout does not leave a hidden FIFO waiter or release capacity while the old request still runs. Failed/cancelled requests do not retry.
- Oversized streaming bodies, slow bodies, malformed JSON, spoofed forwarding headers, absent/wrong origins, exhausted per-IP/global budgets, full limiter maps, and abandoned connections fail with bounded memory/time and safe responses.
- Public `/api/command`, private `/api/chat`, status/operator routes, and unsupported methods/paths remain refused. Existing viewer redaction and read-only socket tests still pass.
- Private controls work while public interactions are throttled or disabled. Test desktop/mobile form states and avoid duplicate submissions/retries.

Run focused new tests first, then `npm run typecheck`, `npm test`, and `git diff --check`. Perform isolated browser verification with fake services; separately verify real llama.cpp cancellation before enabling model-backed public Q&A.

## 8. Rollout and completion criteria

Deployment is a later action, not part of writing this plan.

1. Prepare the reviewed candidate, baseline hashes, backup, exact install manifest, and rollback instructions using the repository's existing deployment practice. No Funnel/Serve or public port changes are expected.
2. Deploy with both features disabled. Confirm public/private route separation through the actual HTTPS URLs and verify proxy client-address behavior.
3. Enable actions during a supervised idle window. Try each once, then verify that a busy Bob refuses them and the private disable control works.
4. Enable Q&A only after the real model deadline/cancellation check passes. Exercise normal questions, privacy canaries, throttling, an internal decision arriving mid-answer, and disable/re-enable.
5. Watch a supervised public trial for denied requests, CPU/model load, response times, and any interference with owner/survival work. Leave a failing feature disabled while investigating.

Complete when anonymous visitors can ask bounded read-only questions and trigger the four gestures, all refusal/priority/privacy tests pass, private controls retain authority, and disabling either feature stops its work without restoring world/database state. Roll back reviewed application files if needed; do not roll back Minecraft progress to undo this feature.

Rough planning allowance: 3–5 focused engineering days including integration and supervised validation, assuming the existing lease and model cancellation paths can support immediate admission. Re-estimate if runtime cancellation fails; deterministic Q&A is the simpler fallback. No extra infrastructure, account system, task permission migration, or new world is required for these four commands.

## Security references

- [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): keep tool permissions outside the model and minimize the data/capabilities it receives.
- [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html): explicit endpoint access rules, input bounds, rate limiting, and safe responses.


## Local implementation results — 2026-10-19

The candidate implements the two explicit public POST routes and exactly four gesture IDs. The existing uncommitted viewer command, event-history, and movement work was retained. Checkout HEAD at implementation time was `297e260f447ec3cc9cee6ee894a577cb5ba46613`; this is a local source reference, not a verified live-service baseline.

### Implemented boundaries

- `public-chat.ts` constructs a fresh seven-field public object and deterministic answers. No public model admission exists: there is no public call to `LlmClient`, its FIFO, the owner command channel, the registry, memory, or task persistence. Model-backed public Q&A is unavailable in this release, including through operator controls. Consequently model token/streaming response limits and priority cancellation machinery are deliberately deferred, rather than adding an unverified model path. The deterministic response is capped at 500 Unicode code points.
- `public-actions.ts` exposes only constant hello chat, one right-arm animation, and one forced ±45-degree look preserving pitch. The installed Mineflayer physics implementation performs forced look synchronously before returning its settled promise; there is no restoration or sustained look loop. Mineflayer applies its normal sensitivity rounding to the yaw angle.
- Admission checks the live READY session, completed bootstrap, all scheduler tasks (including blocked/paused work), pending background evaluation, active decisions/goals, hostiles/death-loop state, lease occupancy/waiters, and fresh physical/plugin observations. Missing observations refuse admission. This is intentionally conservative: blocked tasks, active goals, nearby tracked hostiles, or an unfinished bootstrap can keep buttons unavailable even when the bot appears stationary.
- `WorldActionExecutor.tryRun` reserves immediately, never enqueues public work, and retains ownership through actual primitive settlement. Each gesture has a one-second result deadline. An unsettled gesture quarantines public actions for the rest of the process; a later settlement releases the lease but does not automatically clear quarantine. If a primitive never settles, the lease remains held. The deployed forced-look implementation has no pending continuation, but this conservative failure policy avoids releasing ownership around an unknown outstanding plugin. Recovery would require a separately supervised process restart; the private enable control cannot override quarantine.
- Owner commands, task admission/activation, damage/hostile/death events, disconnects, listener shutdown and private disabling invalidate pending work. No gesture cleanup clears controls, cancels a task, restores orientation, or rolls back world state.
- Interaction limits use bounded rolling-window maps with no eviction of active keys. Both features share per-IP/global attempt and concurrent-body budgets; successful question starts also have a rolling hourly budget. Bodies are limited by received UTF-8 bytes, with five-second read and eight-second request cancellation bounds. Limit responses include Retry-After. IPv4-mapped addresses normalize to IPv4 and IPv6 uses /64 grouping after Node address validation and URL canonicalization.
- Forwarded addresses are honored only from a loopback peer. The existing public outer viewer limiter, redaction, security headers, socket restrictions and private controls remain in place. The production proxy's actual header behavior still requires deployment verification.
- Runtime controls are `GET /public-interactions` and strict-JSON `POST /public-interactions` on the existing loopback status listener only. POST takes both boolean keys, for example `{"questions_enabled":false,"actions_enabled":false}`. Browser Origin headers are refused. There is no public route or JavaScript authority for this control. Re-enabling requires a configured exact HTTPS origin. Private diagnostics expose fixed counters, in-flight counts, and gesture quarantine; logs contain generated request IDs and fixed outcomes, without questions, answers or addresses.
- Public UI renders responses using textContent, uses no shared visitor feed, disables unavailable/submitting buttons, and never retries. Both schema defaults and `config/minecraft.yaml` set questions/actions to false. No allowed public origin was configured.

### Local verification

- Focused security/concurrency tests cover strict payloads and prototype-like keys, Unicode limits, exact gesture effects, lease contention, stale session/invalidation, unsafe/missing state, timeout quarantine, private-fact canaries, origin/encoding/size errors, slow and abandoned bodies, eight-request capacity, rotating-IP global/hourly/hello budgets, map exhaustion, IPv6 grouping, spoofed forwarding, private route refusal, independent private disabling, and configuration defaults.
- Existing redaction, viewer socket, private Q&A and private owner-control regression tests were included.
- Isolated headless Chromium verified the real shell assets against fake state/viewer/interaction services at 1365×1000 and 390×844. Checks passed for four buttons, literal HTML-looking reply text, duplicate-submit suppression, disabled availability, hidden private controls, no JavaScript errors and no horizontal overflow. Screenshots: `/tmp/blockhead-public-1365.png` and `/tmp/blockhead-public-390.png`. No live viewer or bot was contacted.
- Final focused command: `npx tsx --test src/agent/public-actions.test.ts src/dashboard/public-interactions.test.ts src/dashboard/public-state.test.ts src/dashboard/viewer-shell.test.ts src/dashboard/http-guard.test.ts src/status/public-controls.test.ts` — **40 passed, 0 failed**.
- `npm run typecheck` — passed.
- `npm test` — **831 passed, 0 failed, 0 cancelled, 0 skipped** in the final run. An earlier complete run passed 829 before the two private-control tests were added; the initial run was interrupted and is not counted as validation.
- `git diff --check` — passed.
- Local candidate hashes and overlapping pre-existing files: [candidate manifest](investigations/public-interactions-2026-10-19-manifest.json). Live baseline hashes remain a deployment-time requirement.

### Remaining rollout work and limitations

No real llama.cpp cancellation test was attempted and no inference can be enabled publicly. A future model-backed implementation needs the separate admission, internal-priority abort, streaming-byte cap, settlement and real GPU cancellation evidence specified above. Deterministic Q&A answers only general status questions; it does not attempt open-ended world knowledge.

All anonymous limits and counters are single-process and reset at restart. IPv6 grouping and the shared global allowance provide bounded work, not fair allocation or bandwidth-flood protection. The existing outer viewer token bucket is unchanged apart from Retry-After and the loopback forwarding trust check; the stricter no-eviction limiter is specific to interactions.

Before any later deployment: record the actual installed file hashes, reconcile the candidate's overlapping pre-existing viewer edits, back up only reviewed application/config files, and validate actual HTTPS route separation and Funnel forwarding. Install with both features disabled and without adding ports or changing Funnel/Serve. During a separately authorized supervised idle window, configure the exact origin, enable only actions, verify all four effects and busy refusal, then test private disabling. Deterministic Q&A may be enabled separately once its production origin/limits are verified; model-backed Q&A remains unavailable. Rollback restores only the backed-up reviewed application/config files under a separately authorized service restart; never roll back Minecraft world progress. The candidate manifest records local hashes, not authorization to install them.


## Authorized deployment — 2026-10-19

Corey subsequently requested “commit push and deploy,” authorizing this candidate on the existing Maia `blockhead.service`. Preflight verified the installed runtime hashes against the prior viewer-control manifest and confirmed the earlier movement/event changes already match the checkout. GitHub main is an ancestor of the local ten existing commits. Both public features remain disabled; no origin or network exposure changes are included.

The exact 16-file runtime delta and rollback hashes are recorded in [deployment manifest](investigations/public-interactions-2026-10-19-deployment.json). Back up originals to `/home/corey/.local/share/blockhead-backups/public-interactions-20261019`, stop only the bot at a safe task boundary, take a consistent SQLite backup, install only those files with hash checks, and start the same user unit. Shared configuration already contains the disabled defaults. Rollback stops that unit, restores the archived original files and verifies hashes, then starts the unit; newly added unused modules can remain. Do not restore Minecraft/database progress or restart model/Minecraft services. The final deployment receipt follows after live validation.


### Deployment receipt

Implementation commit `4b1fab2847b35bf977d810b8ae49616b629e17bd` was pushed to `origin/main`, including the ten pre-existing local commits. The preserved earlier movement and viewer-control changes were committed with this reviewed candidate; their already-installed runtime files were retained. Exactly 16 changed runtime files were installed after before/after SHA256 checks. No dependencies, Minecraft files, database contents, model service or network settings were changed.

Backup and rollback evidence: `/home/corey/.local/share/blockhead-backups/public-interactions-20261019` contains `runtime-before.tar.gz`, a consistent stopped-service SQLite backup, configuration, original/candidate manifest, release ID, before/after status, `rollback.txt`, `receipt.json` and `https-acceptance.json`. The bot was idle with no pending interrupt before stopping. Only `blockhead.service` was stopped and started; Minecraft and llama.cpp retained PIDs 980 and 952. The new bot process was PID 66961, active/running with `NRestarts=0`, connected at health/hunger 20/20. No rollback was needed.

Live acceptance passed through the actual HTTPS endpoints: public and private pages 200; public redacted state 200 with both flags false and no private task/LLM/inventory/event fields; public owner and operator paths 404; both public POST routes 403 at the unconfigured-origin gate; empty private command and Q&A bodies 400 without executing commands or model calls. The private diagnostic endpoint confirms questions/actions false and modelQuestions false. No critical startup module, syntax, type, address-in-use, schema or unhandled-rejection errors were found. Public request IP attribution is still unverified because no feature was enabled and no proxy configuration was changed; validate it before a later supervised enablement.

The public interaction rollout remains disabled. This deployment does not claim in-game gesture acceptance or runtime model cancellation verification.


## Supervised public trial — 2026-10-19

Corey authorized proceeding with the next rollout steps. The configured origin is now exactly `https://maia.tailceb694.ts.net`. The configuration retains `questions_enabled: false` and `actions_enabled: false`, so a service restart disables both features. Deterministic questions were enabled only through the private operator control after validation; actions were returned to disabled.

Actual Funnel forwarding was verified by resolving the public DNS A record and sending HTTPS requests directly to that edge with normal TLS hostname verification. A temporary nonce-scoped runtime probe observed two requests, one with forged X-Forwarded-For. Both arrived from loopback with a single forwarding value matching the independently measured outbound client address; the forged value was replaced, not appended. Only salted hashes and booleans were recorded privately. Thus selecting the final forwarding value is safe for the observed proxy path, although the old source comment describing an append is inaccurate for this installed Funnel version. Temporary instrumentation was removed and the original runtime file hash restored. The bot alone was restarted to install/remove the probe and load the origin. Minecraft/model processes and Funnel/Serve configuration were unchanged.

Live checks through the actual public edge passed: all four action IDs returned 503/unavailable while three maintenance tasks were queued; the gesture execution count remained zero. No task was cancelled, removed or reordered to force an idle window. Q&A returned deterministic allowed health facts for an instruction/privacy-canary question; the next question returned 429 and a question after the 30-second cooldown returned 200. Both private disable controls returned their feature's public route to 503/disabled, and independent re-enabling did not enable the other feature. The public owner command route remained 404. The canary was absent from private status and SQLite/WAL bytes. The model flag remained false, with zero timeouts or remaining in-flight requests.

The actual live shell passed desktop (1365×1000) and mobile (390×844) form checks: question submission enabled, exactly four disabled action buttons, owner form hidden, no horizontal overflow. The unrelated 3D iframe was suppressed only in the headless form check. Focused action, interaction and private-control tests passed again (18 tests). No application source changes were needed; only the origin configuration and this receipt changed in the checkout. The newer camera commits and their deployed runtime files were preserved.

Final observed state: connected, health 20, hunger 11; questions enabled in memory, actions disabled, modelQuestions false, no gesture quarantine. The remaining action acceptance work is to wait for the authoritative task queue and other safety conditions to clear, briefly enable actions privately, verify the four fixed effects and priority/disable behavior, then decide whether to keep actions enabled. This trial does not claim successful in-game gesture effects.

Private backup/evidence: `/home/corey/.local/share/blockhead-backups/public-trial-20261019T234304Z`. Local structured receipt: [trial evidence](investigations/public-interactions-2026-10-19-trial.json). To disable Q&A immediately, POST `{"questions_enabled":false,"actions_enabled":false}` as application/json with no Origin to loopback `http://127.0.0.1:8155/public-interactions`. Restore the saved configuration and restart only the bot if origin rollback is required; never restore world/database progress.


## Remaining-action follow-up — October 19 PDT / October 20 UTC

**Rollout remains incomplete and actions remain disabled.** Fresh live checks at
2026-10-20T02:21:46Z used the real public Funnel edge `208.111.34.11`, resolved
through public DNS, with normal HTTPS hostname verification and curl `--resolve`.
See [follow-up evidence](investigations/public-actions-2026-10-19-followup.json)
and [exact repair delta](investigations/public-actions-2026-10-19-repair-deployment.json).
No live code was installed and no service was restarted in this follow-up.

### Why the maintenance queue does not drain

The original three priority-80 maintenance `ensure_item` tasks for stone sword,
pickaxe and axe are still queued, with no active task or pending interrupt.
The live inventory contains dirt, rotten flesh, wheat and seeds. None count as
carried food under `countFoodItems`; health is 20 and hunger 11. Home stockpiles
report 357 food, above their target of 64, so stockpile crisis handling does not
supply carried food. Runtime hashes of background, work-safety and work-readiness
match the inspected source baseline.

`WorkSafetyCoordinator` correctly defers re-arm work until food is carried.
`BackgroundManager` incorrectly returns for any queued/paused task at foreground
priority or above before reaching its existing `workReadiness` bread path. Thus
the maintenance tasks block the very prerequisite that would let them run.
The local repair applies the existing `taskSafeToRun` predicate to that pending
work test. Safety-deferred autonomous work can reach readiness recovery; owner
and system work still own the floor. The scheduler guard, durable task IDs,
checkpoints, owner dispatch, and recovery cooldowns are unchanged. No tasks were
cancelled, deleted, reordered or edited live; no idle state was manufactured.

A separate current public-action blocker is the strict `hostile.count === 0`
gate: private telemetry reports 81 loaded hostiles (nearest spider 27 metres).
This count alone is not evidence of an immediate attack, but it does prevent
public gestures under the reviewed policy. That gate remains unchanged. Queue
recovery cannot be treated as proof of safe idle.

### Fresh acceptance evidence and final runtime state

- `blockhead.service` is active, MainPID 70576, NRestarts 0. Minecraft PID 980 and
  llama.cpp PID 952 are unchanged, active, with NRestarts 0.
- Private control reapplied questions true/actions false. Two simultaneous
  actual public action requests each returned 503/disabled. This proves disabled
  admission refusal, **not** live enabled-action concurrency or cancellation.
- Deterministic public Q&A returned 200 with only health/hunger facts. Public
  owner and operator routes returned 404; the private owner form returned its
  expected 400 validation response to an empty payload. No owner task was sent.
- Final runtime: questions true, actions false, configuredActions false,
  modelQuestions false; no gesture active/quarantine; all in-flight counts zero,
  timeouts zero. Both YAML startup defaults remain false and the exact origin is
  unchanged. Accepted/rejected counters are now 3/9; the new acceptance was Q&A.
- Say hello, arm animation, left/right orientation preservation, enabled-action
  concurrency, busy-to-idle priority and disable-during-execution remain
  **unverified in game**. Prior busy refusals and local concurrency/effect tests
  remain useful evidence but do not replace live effect observation. No action
  was enabled or attempted with uncertain delivery, and no action was retried.
- Model-backed Q&A remains unavailable. Network configuration and exposure,
  Minecraft, llama.cpp, world progress and database progress were not changed.

Focused tests: **56 passed** across background, work-safety, public actions,
public interactions and private controls. New regressions reproduce the deadlock
using a real SQLite repository and scheduler, retain queued/paused checkpoints,
run bread recovery before re-arm, resume original re-arm tasks after food arrives,
retain owner precedence and respect the bread failure cooldown. Typecheck passed;
full suite **838 passed, 0 failed/skipped/cancelled**; `git diff --check` passed.

### Prepared deployment and rollback (not executed)

Explicit approval is required before installing the repair or restarting the
live bot, as requested for this follow-up. Only `src/agent/background.ts` is in
the runtime delta; the tests and these records are source-only. Recheck service
state, runtime hashes, source commit and defaults immediately before deployment.
If the installed baseline differs, reconcile it rather than overwriting it.

After approval, execute on Maia at a safe checkpoint boundary (no active task,
interrupt or unsettled lease; queued/resumable work remains persisted). Save
before-status and the runtime original before stopping the same user unit:

```bash
cd /mnt/Repos/Games/Blockhead
repair_backup=/home/corey/.local/share/blockhead-backups/public-actions-food-readiness-20261020
repair_runtime=/home/corey/.local/share/blockhead-runtime
# Require this backup path to be new; never overwrite an earlier rollback copy.
test ! -e "$repair_backup" || exit 1
printf '%s  %s\n' 6090d1ff1c7567a19625cdcdd03d4562c89ed6a7b3c4d21d93ee06ce89f19886 "$repair_runtime/src/agent/background.ts" | sha256sum -c - || exit 1
printf '%s  %s\n' 10aa752a5f39f19a11d0349b55790e9d229da3cfc8e7f6cd7e8bcadca94b3614 src/agent/background.ts | sha256sum -c - || exit 1
mkdir -p "$repair_backup/src/agent"
cp "$repair_runtime/src/agent/background.ts" "$repair_backup/src/agent/background.ts"
git rev-parse HEAD > "$repair_backup/source-commit.txt"
curl -fsS http://127.0.0.1:8155/status > "$repair_backup/status-before.json"
systemctl --user stop blockhead.service
cp src/agent/background.ts "$repair_runtime/src/agent/background.ts"
printf '%s  %s\n' 10aa752a5f39f19a11d0349b55790e9d229da3cfc8e7f6cd7e8bcadca94b3614 "$repair_runtime/src/agent/background.ts" | sha256sum -c - || exit 1
systemctl --user start blockhead.service
systemctl --user is-active blockhead.service
```

Validate connection, task/checkpoint continuity, prerequisite progress or bounded
failure, logs and startup-disabled feature state. Restore deterministic Q&A
privately only after validation. If validation fails, use the same approval's
rollback before further live debugging:

```bash
repair_backup=/home/corey/.local/share/blockhead-backups/public-actions-food-readiness-20261020
repair_runtime=/home/corey/.local/share/blockhead-runtime
printf '%s  %s\n' 6090d1ff1c7567a19625cdcdd03d4562c89ed6a7b3c4d21d93ee06ce89f19886 "$repair_backup/src/agent/background.ts" | sha256sum -c - || exit 1
systemctl --user stop blockhead.service
cp "$repair_backup/src/agent/background.ts" "$repair_runtime/src/agent/background.ts"
printf '%s  %s\n' 6090d1ff1c7567a19625cdcdd03d4562c89ed6a7b3c4d21d93ee06ce89f19886 "$repair_runtime/src/agent/background.ts" | sha256sum -c - || exit 1
systemctl --user start blockhead.service
```

Never restore world/database progress or restart Minecraft/model services for
this repair. Immediate feature rollback needs no restart: POST
`{"questions_enabled":false,"actions_enabled":false}` as application/json without
Origin to loopback `http://127.0.0.1:8155/public-interactions` on Maia. To retain
current deterministic Q&A while blocking actions, use questions true/actions
false. Any restart returns both features to false.

After the approved repair, observe real recovery without deleting or cancelling
work. If every authoritative gate eventually permits actions, temporarily enable
privately and verify all four effects once through actual public HTTPS with
production cooldowns (10 seconds per IP, global 5 seconds; hello 30 seconds).
Observe chat and game/entity effects independently of the HTTP response. Never
retry uncertain delivery. Exercise owner/busy/concurrent/disable authority and
return actions to false on any failure or absence of a safe-idle window. The
repair does not authorize weakening the hostile or other safety predicates.
