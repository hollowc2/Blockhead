# Anonymous public Q&A and simple commands

Status: deployed on Maia; deterministic Q&A enabled privately in memory. The approved food-readiness repair is deployed; live bread recovery and original re-arm work now progress. Actions remain disabled pending a genuine safe-idle window. Both configured startup defaults remain false; the exact HTTPS origin is configured. Model-backed Q&A remains unavailable. Network exposure is unchanged.

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


## Approved repair deployment — October 19 PDT / October 20 UTC

Corey approved the exact repair/restart proposal. At 2026-10-20T02:42:25Z,
source commit `445ccb0149981da7fcbe46cc5a545eae0ea68ac2` was deployed on Maia.
Only `src/agent/background.ts` changed in the runtime tree; before/after hashes
match the prepared manifest. The backup directory recorded above contains the
original file, full runtime hash list, before-status, original unfinished task
rows/checkpoints, a stopped-state SQLite evidence backup, source commit,
rollback commands and deployment receipt. The database backup is preservation
evidence, **not** a rollback instruction. No database or world progress was
restored. The unrelated Maia `.claude/` directory was left alone.

Only user `blockhead.service` was stopped/started, after rechecking no active
task or interrupt and disabled actions. Shutdown completed cleanly and the bot
reconnected. MainPID changed from 70576 to 75070; NRestarts remains 0. Minecraft
PID 980 and llama.cpp PID 952 were retained. No dependencies, configuration,
network exposure, Minecraft or model service changed. Rollback was not needed.
Both public features started false, including modelQuestions false; the three
original re-arm IDs and resume checkpoints were verified intact after restart.

The first normal 30-second background pass reached food readiness, created
bread prerequisite `acd94edf-e45c-4bf9-96dd-1e5a61dc1b74`, withdrew six bread
from home storage and completed at 02:43:00Z. Auto-eat consumed one, raising
hunger from 11 to 16. The **original** stone-axe task activated and completed
at 02:43:46Z, followed by the original pickaxe task. This confirms the dependency
deadlock repair live, without cancelling or editing any task to obtain idle.
Deterministic Q&A was restored through the private control only after recovery
progress was observed. Actions remained disabled throughout.

At 02:43:37Z, actual public HTTPS rechecks used the public-DNS Funnel edge with
normal TLS hostname verification. Q&A returned 200 with health/hunger only;
two simultaneous action requests returned 503/disabled; public owner/operator
routes returned 404; the private owner form retained its 400 empty-body
validation. This concurrent refusal is evidence only for the disabled state.
No gesture effect or enabled-action concurrency acceptance is implied.

Evidence: [deployment receipt](investigations/public-actions-2026-10-20-repair-receipt.json),
[post-deployment HTTPS checks](investigations/public-actions-2026-10-20-post-deploy.json).
The existing exact rollback procedure remains valid and restores only the one
application file under a bot stop/start; it must never restore database/world
progress. Immediate runtime rollback is still the private loopback feature
control. A restart disables both configured startup features.

The approved source repair was already verified by 56 focused tests, typecheck,
838 full-suite tests and diff checks. This follow-up changes only rollout
records; it does not introduce additional source repairs or authorize another
application deployment.


### Final supervised observation and remaining acceptance

Final state at **2026-10-20T02:46:54Z**: connected, health/hunger **20/20**,
six bread carried, no active/queued task or interrupt. All original re-arm tasks
completed successfully on their first attempt: axe at 02:43:46Z, pickaxe at
02:44:31Z, sword at 02:45:12Z. Their task IDs and terminal resume-state records
remain in SQLite. The original queue drained by executing its work normally.

Sixteen private observations from 02:42:48Z to 02:46:34Z (225 seconds) recorded
79–83 loaded hostiles, never zero. Final hostile count is 81, nearest spider
27 metres. Although the scheduler queue became empty, the reviewed public
predicate requires `hostile.count === 0`, so no safe-idle acceptance window was
observed. Actions were never enabled. No admission checks were bypassed, no
mob/world/network state was changed to manufacture safety, and no uncertain
action was retried. The hostile count is a conservative gate, not a finding
that every loaded mob is attacking Bob. Changing that policy is outside this
approved repair.

Final runtime features: **questions true, actions false, configuredActions
false, modelQuestions false**; no active/quarantined gesture, no in-flight
requests or timeouts. Startup YAML defaults are still questions false/actions
false. Both public-action requests in this follow-up were disabled refusals;
one deterministic public question was accepted. All services are active with
NRestarts 0 and the PIDs recorded above. Full runtime hash comparison again
shows exactly the approved one-file delta. No critical startup/module/socket
or background-tick error markers were found in the deployment journal.

The action rollout is **still incomplete**: exact hello delivery, main-arm-only
wave, approximately 45-degree left/right turns with preserved pitch/position,
enabled-action concurrency/busy priority, and disabling active admissions still
need a genuinely eligible live window and independent game-effect observation.
Public/private separation, disabled concurrent refusal, private control
availability and deterministic Q&A passed again. Local tests cover the remaining
code paths, but are not recorded as live gesture acceptance.

Structured evidence: [final runtime and task results](investigations/public-actions-2026-10-20-final-state.json).
The private backup directory also holds the 16 observation records and deployment
journal. No rollback was needed. For immediate disable, use the loopback control
with both booleans false; restore the one backed-up application file and restart
only the bot if a later explicitly approved rollback is necessary. Never restore
SQLite/Minecraft progress. This follow-up adds records only; source validation
remains 56 focused tests, typecheck, 838 full-suite tests, with final diff checks
passing.

## Hostile admission review — October 19 PDT / October 20 UTC

**Local candidate only; rollout remains blocked and actions remain disabled.**
No live code deployment, service restart, network change, model-backed public
Q&A, Minecraft command, mob kill, task cancellation or progress restoration was
performed by this follow-up. One mistaken private owner-command probe was
issued; its effect is explicitly recorded below. It must not be counted as a
successful boundary validation or as an authorized owner request.

### What the sensor actually establishes

`src/minecraft/entities.ts:HostileTracker` subscribes after spawn, inserts on
`entitySpawn`, removes on `entityGone`, and holds references to the mutable
Mineflayer entity positions. It does not seed itself from the initial entity
registry, limit distance, check visibility, classify threat transitions, or
record observation freshness. `count` is the map size, intended for diagnostics;
`nearest()` prunes invalid entries as a side effect and rounds 3D distance.
Consequently the count and nearest result can also reflect different pruning
points. Its private mob-name set differs from the canonical combat list (for
example, guardians, shulkers and piglins are absent). `hostile.detected` is a
spawn signal, not a continuous assertion that a mob is attacking. An already
loaded mob moving into range does not generate another spawn event.

Thus `hostile.count === 0` is neither a precise current-threat check nor a
complete fail-closed safety sensor. It overblocks distant/covered ordinary mobs
and can underrepresent entities missed before attachment or omitted by its
name list. The dashboard counter remains unchanged as diagnostic telemetry.

The existing actionable-threat policy is `nearestThreat` in
`src/agent/self-defense.ts`, also used by work safety/readiness. It scans the live
entity registry; excludes invalid/dead mobs and unprovoked endermen/piglins;
uses horizontal range 6 and vertical separation at most 3 for melee, or range
16 and height 12 for skeleton/stray/pillager/drowned; and checks an eye-to-body
ray for solid cover. Damage triggers defense independently, including during
passive failure cooldowns. Work safety, shelter, food readiness and emergency
survival tasks retain their existing authority. Merely reusing
`nearestThreat(bot) === null` would not suffice for public admission: missing
state or unloaded ray samples can yield no threat in that work-policy helper,
and turns can provoke an enderman.

At 03:29:32Z the existing private viewer's read-only initial entity replay
contained 114 entities, including 74 canonical hostiles and **zero geometry
candidates**. Nearby dashboard telemetry reported 82 tracked hostiles. These
are separate asynchronous observations, not proof of exact counter drift.
A skeleton was 2.0001 blocks away horizontally but 34 blocks below Bob; the
nearest replayed spider was 26.84 blocks away with a 7.9-block height gap.
An enderman was also loaded. No click/control events were emitted by this
observer. The viewer lacks authoritative validity, physics, freshness and
visibility facts, so this is diagnostic evidence only, never an admission
substitute. See [entity geometry observation](investigations/public-actions-2026-10-20-threat-observation.json).

### Candidate repair and remaining conservative limits

The three-file runtime delta is `src/index.ts`,
`src/agent/public-action-safety.ts`, and `src/agent/self-defense.ts`.
The latter only extracts the unchanged reflex range/height values into a shared
helper. Self-defense targeting, cooldowns, task scheduling and attack behavior
are unchanged. Public admission now scans the live registry synchronously at
both existing controller safety checks, using those shared bounds for ten
reviewed ordinary mob types. Known solid cover separates a threat; missing or
unknown ray samples refuse. Nonfinite/missing positions, missing registry or
world lookup, and thrown observation errors refuse.

Unreviewed hostile types, including exotic ranged/flying mobs and neutral mobs
such as endermen/piglins, **still refuse at any loaded distance**. The existing
combat policy has no adequate public-turn-safe profile for them. This is an
intentional unresolved conservative limit, not evidence they are all currently
attacking. The observed enderman would itself prevent candidate admission;
this repair must not be expanded merely to get a passing trial.

A session-scoped observer requires a real server `time` event within 2.5 seconds
and local `physicsTick` within 250 ms, measured with a monotonic clock. The
installed Mineflayer time plugin emits `time` from server `update_time` packets,
not local physics. Both observations start unknown; death, respawn, disconnect,
detach and a new session invalidate them. A local physics loop alone cannot
prove a live server. Entity positions are the latest protocol-maintained state;
stationary entities need not emit movement updates. This does not claim an
individual timestamp for every entity or omniscience beyond loaded entities.

Other admission gates were reviewed. The live session/READY identity, physical
state, queue (including paused/blocked work), interrupt, pending/active lease,
background pass/kick/recheck, active decision/goal, bootstrap and death-loop
checks remain. New refusals cover halted scheduling and any unfinished
build/terrain project, even when no child task is currently queued. Physical
checks now reject nonfinite health/hunger and missing/throwing plugin methods.
Hunger must exceed 10, conservatively covering the existing hunger-emergency
threshold before its five-second watcher runs; the health retreat threshold is
unchanged. Hunger-low and night signals join the existing synchronous owner,
damage, spawn, task and death cancellation bindings. No task is removed to
establish idle, no ownership is queued, and gesture settlement/quarantine,
production cooldowns, fixed effects and private disable behavior are unchanged.

Regression checks cover all ten melee/ranged profiles at inclusive horizontal
and positive/negative vertical boundaries; 83 distant mobs; solid cover,
unknown/unloaded visibility; missing/nonfinite state; canonical name fallback;
unknown/exotic/neutral mobs; dead/invalid records; stale server vs local physics;
lifecycle invalidation; and incoming nearby/ranged threats plus real owner,
hunger and night bus interruptions between reservation and effect for all four
gestures. Existing tests cover occupied leases, concurrent refusal, disabling,
reconnects and unsettled-primitive quarantine. **39 focused tests passed;
typecheck passed; 843 full-suite tests passed with no failures/skips/cancellations;
`git diff --check` passed.** These are local checks, not game-effect acceptance.

### Live changes during observation and operator-probe incident

Bob initially remained at health/hunger 20/20 with an empty queue. By 03:29:11Z,
autonomous work had activated an iron-pickaxe goal task. Combat, shelter/retreat
failures and two deaths followed. These happened with public actions disabled;
this follow-up did not direct movement or combat. The original three re-arm
IDs remain completed; later deaths created **new** re-arm tasks.

At 03:30:47.090Z the agent mistakenly POSTed the literal bytes `{}` to private
`http://127.0.0.1:8155/command`, expecting empty JSON form validation. That
endpoint accepts plain text and delivered `{}` as the configured owner. The
model subsequently selected `defend_self`, enqueuing task
`5732b99f-cce2-4fbe-9abf-07e03651dda3` at 03:31:00.045Z. This was an operator
error and violated the intended read-only owner check. It is **not** a passed
validation. The death recorded at 03:30:46.290Z preceded delivery of this
instruction. No causal claim about earlier deaths is inferred from the probe.
No cancellation, movement, stop, restoration or further owner instruction was
used to undo it; subsequent follow-up used GETs and read-only process/journal
queries. Preserve the resulting work/checkpoints. Future owner-boundary checks
must use read-only route inspection; even a nominally empty test payload must
not be sent to a live owner-command endpoint.

At 03:30:43–44Z, through the actual public-DNS HTTPS edge `208.111.34.11` with
normal TLS verification, simultaneous hello/wave requests both returned
503/disabled; deterministic health/hunger Q&A returned 200. Public owner and
operator paths returned 404. No gesture was delivered, enabled or retried.
These disabled refusals do not establish enabled concurrency, busy-state
acceptance or game effects. See [HTTPS evidence and probe incident](investigations/public-actions-2026-10-20-threat-final-state.json).

Latest read-only state at **03:34:22Z**: connected, health **16.83/20**,
hunger **16/20**, with the original paused iron-pickaxe goal task now active
and no queued task at that observation. The new re-arm tasks completed normally;
the accidentally requested owner-defense task completed at 03:33:51.398Z. Its
world/combat effects were not independently characterized. The earlier 03:32:11Z
busy/recovery snapshot is retained inside the latest evidence. Hostile telemetry
now reports 82, nearest enderman 17 blocks. Runtime flags:
questions true, actions/configuredActions false, modelQuestions false; no active
or quarantined gesture, zero in-flight requests and timeouts, accepted/rejected
counters 2/4. Both configured startup defaults remain false. All three user
services remain active with NRestarts 0 and unchanged MainPIDs: bot 75070,
Minecraft 980, llama.cpp 952. The three candidate target runtime hashes still
match the original source baseline; no candidate was installed. See
[latest state and incident timeline](investigations/public-actions-2026-10-20-threat-latest-state.json).

The rollout remains incomplete. Exact once-only hello chat, main-arm wave
without attack/use, both 45-degree turns with preserved pitch/position,
enabled busy/concurrent refusal, immediate disable admission, and owner/survival
priority during enabled actions still need a genuine eligible window and
independent game-effect observation. Current task/recovery state and the
undeployed repair preclude that trial. A future candidate window may also be
blocked by an enderman or another unreviewed hostile. Do not move Bob, kill mobs,
clear tasks, change exposure or weaken the policy to obtain a window.

### Exact proposed deployment and rollback — approval pending

[Prepared manifest](investigations/public-actions-2026-10-20-threat-deployment.json)
records the installed before hashes and exact candidate hashes for all three
files. Tests and evidence are source-only. Explicit approval is required before
any live copy, deployment or bot restart; none has been granted in this turn.
Do not deploy during this recovery/owner work. Recheck session, active/queued/
paused work, interrupts, leases, feature defaults and installed hashes at a
later safe boundary. If any baseline hash differs, reconcile rather than
overwrite. Approval alone does not authorize cancelling work to make deployment
possible.

After approval and a verified safe boundary, run on Maia using the manifest
from the approved source commit. The following is a prepared procedure, **not
executed**. All three files already exist in the runtime; no dependencies or
configuration change is required:

```bash
cd /mnt/Repos/Games/Blockhead
python3 - <<'PY'
import hashlib, json, pathlib, shutil, subprocess
manifest = json.loads(pathlib.Path('docs/investigations/public-actions-2026-10-20-threat-deployment.json').read_text())
runtime = pathlib.Path(manifest['runtime'])
backup = pathlib.Path(manifest['backup_proposed'])
assert not backup.exists(), 'Require a new rollback directory'
for f in manifest['files']:
    assert hashlib.sha256((runtime / f['path']).read_bytes()).hexdigest() == f['before_sha256']
    assert hashlib.sha256(pathlib.Path(f['path']).read_bytes()).hexdigest() == f['candidate_sha256']
backup.mkdir(parents=True)
shutil.copy2('docs/investigations/public-actions-2026-10-20-threat-deployment.json', backup / 'manifest.json')
(backup / 'source-commit.txt').write_bytes(subprocess.check_output(['git', 'rev-parse', 'HEAD']))
(backup / 'status-before.json').write_bytes(subprocess.check_output(['curl', '-fsS', 'http://127.0.0.1:8155/status']))
for f in manifest['files']:
    saved = backup / f['path']
    saved.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(runtime / f['path'], saved)
    assert hashlib.sha256(saved.read_bytes()).hexdigest() == f['before_sha256']
subprocess.run(['systemctl', '--user', 'stop', 'blockhead.service'], check=True)
for f in manifest['files']:
    shutil.copy2(f['path'], runtime / f['path'])
    assert hashlib.sha256((runtime / f['path']).read_bytes()).hexdigest() == f['candidate_sha256']
subprocess.run(['systemctl', '--user', 'start', 'blockhead.service'], check=True)
PY
```

Validate startup-disabled flags, session connection, queue/checkpoint continuity,
freshness refusal before initial observations, logs and all unchanged services.
Restore deterministic Q&A privately only after validation. A separately supervised
action trial must satisfy every authoritative condition; do not infer admission
from viewer geometry. If validation fails, use the approved rollback before
further live debugging:

```bash
python3 - <<'PY'
import hashlib, json, pathlib, shutil, subprocess
backup = pathlib.Path('/home/corey/.local/share/blockhead-backups/public-actions-threat-gate-20261020')
manifest = json.loads((backup / 'manifest.json').read_text())
runtime = pathlib.Path(manifest['runtime'])
for f in manifest['files']:
    assert hashlib.sha256((backup / f['path']).read_bytes()).hexdigest() == f['before_sha256']
subprocess.run(['systemctl', '--user', 'stop', 'blockhead.service'], check=True)
for f in manifest['files']:
    shutil.copy2(backup / f['path'], runtime / f['path'])
    assert hashlib.sha256((runtime / f['path']).read_bytes()).hexdigest() == f['before_sha256']
subprocess.run(['systemctl', '--user', 'start', 'blockhead.service'], check=True)
PY
```

Never restore world/SQLite progress. No Minecraft/llama.cpp restart, dependency
change, network change or model-backed public Q&A is authorized. Immediate
feature rollback remains POSTing `{"questions_enabled":false,"actions_enabled":false}`
as application/json without Origin to loopback **`/public-interactions`**, never
`/command`. Questions true/actions false preserves deterministic Q&A. Any bot
restart returns both configured public features to false. No rollback was
performed because the local candidate has not been deployed.
