# Validate Blockhead public launch readiness

You are working in the Blockhead repository after implementing the security and viewer-experience prompts. Validate the combined result and produce a concrete, evidence-based launch assessment. Complete local preparation and testing; do not stop after offering a plan.

## Scope and authorization

Read applicable repository instructions and the implementation changes. Preserve unrelated edits. This prompt authorizes local verification, isolated test fixtures, documentation, and preparation of a deployment/rollback plan. It does not authorize changing live services, network exposure, credentials, firewall rules, or feature flags, nor enabling gestures or testing attacks against the public deployment.

If remote observations are needed, first use any already-authorized read-only access and applicable server-management instructions. If live changes or additional access require approval, finish the concrete local preparation first, then state exactly which remaining action needs authorization and why. Do not repeatedly ask for authorization already granted in the session.

## 1. Validate the implemented security boundaries

Review the final code and run the targeted regressions. Verify:

- Malformed HTTP/WebSocket targets cannot terminate the process or reach an unintended upstream.
- Pending and established polling/WebSocket sessions cannot exceed global/public/per-address limits; upgrades and disconnects count correctly.
- Public viewers cannot consume reserved private capacity; slow clients and abandoned chunk work remain bounded.
- Operator commands/settings require the intended credential, reject browser-origin requests, and remain inaccessible through the public listener.
- Public HTTP state, WebSocket events, chunk serialization, errors, logs exposed to the browser, and client-side history do not contain private fields or block metadata.
- Public questions receive only allowlisted public facts, cannot invoke tools, cannot bypass the configured model firewall, and cannot retain cancelled queued inference.
- Owner/bot inference is prioritized correctly without breaking shared-backend serialization.
- Gesture controls preserve every existing deterministic safety gate and uncertainty handling.

Use the actual shell-to-viewer-to-fake-bot path where appropriate, not only isolated helper tests. Reproduce the original failure cases against the revised implementation and prove normal behavior still works afterward.

## 2. Validate viewer behavior and capacity under controlled load

Create a bounded local load scenario representing the configured public audience size, plus a modest over-capacity burst. Do not run an unbounded stress test.

Measure and record the relevant observations: admitted/refused/pending sessions, listener counts after cleanup, API responsiveness, event-loop delay, memory/buffering behavior, reconnect rate, and model queue depth under mocked slow inference. State the workload, duration, fixture limitations, and thresholds used. Do not invent production capacity guarantees from fake-world results.

Verify first load, full capacity, reconnect, server unavailable, bot offline, WebGL failure, lightweight mode, hidden-tab release/recovery, cooldowns, questions, fallback answers, and uncertain gesture delivery. Check at least desktop and narrow mobile layouts with keyboard accessibility. Use a browser where available and report any unavailable visual validation.

Run the full tests, typechecking, diff checks, and current production dependency audit. Explain remaining advisories by affected path and reachability, not just severity totals. Record the source revision and dependency-lock identity used for the assessment.

## 3. Check deployment assumptions without manufacturing evidence

Determine which of the following are supported by current source, which by current read-only deployment evidence, and which remain unverified:

- Only the intended redacted listener is exposed through Tailscale Funnel. Private shell, raw viewer, dashboard, status/operator routes, llama.cpp, and the firewall's administrative interfaces are not publicly exposed.
- The edge's path normalization and upgrade handling preserve the application's assumptions. Local listener tests are not proof of edge behavior.
- Trusted client-address handling matches how the real proxy appends/rewrites forwarding headers.
- Private viewer access is limited to the intended tailnet users/devices, rather than assuming everyone on the tailnet is an owner.
- Minecraft access is appropriately isolated. The bot uses offline authentication and owner trust is based on a configured player name; unauthorized players must not be able to join under that name. Inspect server bind/firewall/authentication/allowlist configuration when authorized; do not assume a player-name allowlist alone fixes offline impersonation.
- Public questions actually reach the configured firewall and no alias/misconfiguration bypass exists. A different base-URL string is not proof that a service is a firewall.
- Operator credentials can be installed securely, with an explicit migration for existing tooling and no unauthenticated fallback.
- Service identity, filesystem access, logs, and dependencies are suitable for the deployment. Log retention is bounded and security-relevant events can be investigated without retaining raw visitor questions unnecessarily.
- Backups cover both Minecraft world data and SQLite state, with a documented consistent backup method and tested restoration into an isolated location. Preparing a rollback is not evidence that a restore has been exercised.

Do not enable or invoke public gestures merely to complete a checklist. Any authorized live trial must follow the existing independent-effect verification and safety requirements. Keep unverified effects explicitly unverified.

## 4. Produce concrete launch and rollback instructions

Write `docs/public-viewer-launch-readiness.md` with:

1. A clear recommendation: ready for a limited launch, ready only for observation/basic Q&A, or not ready, with reasons.
2. A concise threat model showing public browser, public proxy/listener, private/operator surfaces, bot process, model firewall/backend, Minecraft server, and persistent data.
3. Findings sorted by severity, with code references, reproduction/validation evidence, and remaining work.
4. Test results and measured local workload outcomes, including limitations.
5. A deployment plan naming the precise files/configuration/services that would change and the operator-secret migration. Inspect current service instructions instead of copying obsolete deployment paths.
6. A rollback plan tied to a known previous revision/configuration, including feature-disable steps and preservation of world/database progress. Do not roll back persistent game progress as a substitute for reverting application code.
7. A staged launch plan with explicit entry/exit criteria, conservative capacity, monitoring, and stop conditions. Start with the minimum useful public capabilities and retain a private emergency-disable path.
8. A short list of unresolved live checks, what evidence is needed, and which require authorization.

Update inaccurate README deployment/security statements as needed. Keep confirmed failures, static findings, design suggestions, and unverified deployment assumptions clearly distinguishable.

Finish with a concise summary and a link to the readiness document. If deployment approval is still needed, ask only after the candidate changes, validation evidence, deployment steps, and rollback steps are concrete and reviewable. Do not deploy automatically from this validation prompt.
