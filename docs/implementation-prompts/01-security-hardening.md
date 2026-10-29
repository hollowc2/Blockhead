# Implement Blockhead public viewer security hardening

You are working in the Blockhead repository. Implement the security fixes below, with meaningful regression tests, and carry the local work through validation. This is an implementation task, not another review or a plan-only task.

## Objective and scope

Make the public viewer resilient to malformed requests, connection-limit bypasses, metadata disclosure, and abandoned model work. Protect local operator commands from browser-origin requests and unauthorized callers. Review current dependency exposure and document the actual trust boundaries.

Read applicable repository instructions, `README.md`, `docs/deployment-maia.md`, `docs/public-model-questions-2026-10-24.md`, and the relevant source/tests first. Inspect the current working tree and preserve unrelated edits. Work locally; do not start `src/index.ts`, connect a bot to the live Minecraft server, change live configuration, restart services, change network exposure, or enable gestures. Use fake bots, mock inference, temporary databases, and isolated ephemeral listeners for testing.

Preserve these boundaries:

- Public requests cannot reach owner commands, private snapshots, task/job controls, build previews, maps, operator configuration, or diagnostic protocol observations.
- Public questions receive only allowlisted public facts. They have no tools, scheduler mutation access, Minecraft chat access, or private model context.
- Public model questions continue to use the configured firewall path. Failures must not trigger a direct-to-model bypass.
- Public gestures retain all existing deterministic admission, threat, freshness, cancellation, quarantine, and world-action ownership checks.
- Do not weaken CSP or trust client-supplied proxy headers to make tests pass.

Implement the following in small coherent changes. Do not silently drop a requirement because an adjacent fix is difficult.

## 1. Reject malformed HTTP and WebSocket targets without crashing

Starting points: `src/dashboard/viewer-shell.ts`, `src/dashboard/viewer-server.ts`, `src/dashboard/server.ts`, and their tests.

The public upgrade handler currently constructs `new URL(request.url, base)` outside a protective boundary. The review reproduced an uncaught `ERR_INVALID_URL` with a malformed upgrade target. HTTP request handlers and other upgrade handlers should be checked for equivalent exception paths and rejected promises.

Requirements:

- Validate and parse request targets safely before routing or tunneling them. Reject malformed or unsupported targets with a bounded response or socket close.
- Decide explicitly which request-target forms this reverse-proxy topology accepts. Do not let alternate URL forms change route interpretation or select an arbitrary upstream.
- Ensure request-handler promises have an error boundary and no response is written twice or after destruction.
- Keep upstream targets fixed to the intended loopback services; retain path allowlisting and header filtering.
- Cover both public and private handlers where they share the same unsafe parsing pattern.

Acceptance evidence: use an isolated child process or equivalent test that proves malformed upgrade requests do not terminate the process, a valid request still succeeds afterward, and malformed input never reaches an upstream service. Do not add a global exception handler that merely swallows application failures.

## 2. Enforce connection capacity across the complete session lifecycle

Starting points: `src/dashboard/viewer-server.ts`, `src/dashboard/viewer-shell.ts`, `src/dashboard/http-guard.ts`, `src/dashboard/prismarine-adapter.ts`, and tests.

The review configured one public connection and two total connections, opened four Engine.IO polling handshakes before joining the Socket.IO namespace, and then admitted all four. Admission checked current connected sockets; it did not reserve pending capacity. Shell WebSocket tunnel counts also do not account for polling sessions.

Requirements:

- Account for pending handshakes and established sessions with a clear lifecycle. Enforce public and total limits atomically, and recheck at the point expensive bot subscriptions are attached.
- Cover polling-only clients, direct WebSocket clients, polling-to-WebSocket upgrades, failed handshakes, idle pending sessions, disconnects, reconnects, and shutdown.
- A transport upgrade must not create a second seat for the same session. Session close and failed admission must release capacity exactly once.
- Apply per-address limits to polling as well as WebSocket use. Canonicalize addresses consistently, including IPv4-mapped IPv6 and IPv6 grouping, using only the trusted proxy topology. Never trust public headers as an identity credential.
- Preserve reserved capacity for private viewers. Public traffic must not consume private seats through an admission race.
- Bound pending handshake lifetime and resource use. Avoid unbounded Maps, timers, event listeners, deferred chunk work, and outbound buffers.
- Disconnect or otherwise bound slow consumers. Review chunk work for deduplication and cancellation so already-closed viewers do not retain expensive queued work.
- Keep refusal responses small and free of internal information. Provide a stable, safe capacity reason that the later viewer prompt can display.

Acceptance evidence: concurrent staged polling handshakes cannot exceed configured caps; normal mixed transport traffic works; an upgrade counts once; aborted/expired sessions release seats; repeated connect/disconnect cycles do not grow bot listeners or counters; slow clients cannot create unlimited outbound buffering. Test global saturation with multiple address identities rather than assuming a single-IP limit proves the global cap.

## 3. Authenticate and protect local operator mutations

Starting points: `src/status/server.ts`, `src/status/public-controls.test.ts`, `src/status/status.test.ts`, `src/index.ts`, local tooling that calls `/command` or `/public-interactions`, and operator documentation.

The review sent a plain-text `/command` POST with an attacker Origin and `Sec-Fetch-Site: cross-site`; it invoked a fake owner command and returned 200. This proves missing application checks. It does not prove a particular browser can reach the deployed endpoint.

Requirements:

- Reject browser-origin requests to operator mutation routes. Apply a consistent policy to Origin and Fetch Metadata headers; reject unexpected origins, including `Origin: null`.
- Require an operator bearer credential for privileged commands and configuration changes. Fail closed when the credential is not configured; keep read-only health checks available as appropriate.
- Source the credential from a secret mechanism suitable for the existing environment, such as an environment variable or an explicitly protected local secret file. Do not commit credentials, put them in URLs, embed them in public assets, expose them in snapshots, or log them.
- Validate authentication before reading or acting on the body. Bound body bytes and reading time; enforce a documented content type.
- Keep operator mutations restricted to the intended loopback binding. A configuration change to a non-loopback bind must not accidentally enable unauthenticated operator access.
- Locate and update relevant local callers and documentation so operators can migrate intentionally. Use fake credentials in tests and examples. Do not install a live credential or change a live service environment during this task.
- The public listener must continue returning denial for all operator routes regardless of forwarded headers or supplied credentials.

Acceptance evidence: absent, incorrect, malformed, and cross-site credentials/requests are refused without invoking the hook; an authorized local request succeeds; malformed or slow bodies are bounded; the public proxy cannot reach operator routes. Explicitly describe any operational migration required before deployment.

## 4. Remove private metadata from public world serialization

Starting points: `publicViewerTransform` and chunk emission in `src/dashboard/viewer-server.ts`, plus the installed prismarine chunk/world-view APIs.

The public transform shifts outer chunk coordinates but passes through the serialized chunk. The installed chunk serializer includes `blockEntities`; synthetic sign text and embedded coordinates survived the review's public transform unchanged.

Requirements:

- Define the minimum chunk data needed for public rendering and project to that shape. Strip block-entity NBT and other unnecessary metadata before sending it publicly.
- Do not assume metadata is safe because the visible UI does not render it. Network payloads are the boundary.
- Fail closed if public sanitization fails or a serializer shape is unsupported; do not fall back to the original chunk.
- Preserve correct block geometry, lighting, biome rendering, and dropped-item/gear projections. Keep private rendering behavior working.
- Avoid repeatedly parsing or serializing identical chunks for every public viewer when a safe bounded cache or shared projection is appropriate. Invalidate any cache correctly on world updates and bot-session changes.
- Review the other public events for equivalent nested metadata and unknown-field pass-through. Prefer an explicit allowlist where practical.

Acceptance evidence: use the real installed serializer for the configured Minecraft version, including realistic block entities with sign text, custom fields, and embedded coordinates. Assert those fields never appear in the public wire payload, private payloads behave as intended, and rendering-required fields survive. Do not claim actual live signs or coordinates were exposed without live evidence.

## 5. Cancel abandoned model work and protect owner responsiveness

Starting points: `src/llm/client.ts`, `src/dashboard/public-interactions.ts`, `src/dashboard/public-model-chat.ts`, `src/index.ts`, and related tests.

All LlamaClient instances share a process-wide serial queue. `untilAborted` stops waiting for a result but does not remove or cancel the model work. The review reproduced three abandoned public questions running before a later owner request while public diagnostics reported zero requests in flight.

Requirements:

- Propagate an AbortSignal and deadline through public request handling, model-answer generation, queue admission, model discovery, retries, and inference transport.
- Queue waiting must count against the public request's total deadline. Work that expires or is abandoned while waiting must never start inference later.
- Cancelling a queued entry must preserve serialization of its predecessors and successors. Do not accidentally release the running model's ownership early.
- Bound outstanding public model work, including work whose HTTP client has disconnected. Reflect queued and running work accurately in private diagnostics.
- Give owner and autonomous bot decisions priority over queued public questions. Retain an explicit fairness policy so public questions can still make progress during normal use.
- Do not introduce concurrent inference against the shared backend as a shortcut. If an active public request is cancelled, abort its transport; document any uncertainty about whether the external backend actually stops computation.
- Preserve rules-based fallback and firewall refusals, but distinguish cancellation/timeout from a successful model answer in logging and diagnostics.
- Maintain compatibility for existing owner/private callers, or migrate every affected call site deliberately.

Acceptance evidence: abandoned, expired, disabled, and shutdown-cancelled questions cannot later execute; queued private work takes priority; serialization survives cancellation races and inference failure; queue sizes remain bounded; firewall failures never bypass the firewall; normal answers and rules fallback still work. Use controllable fake fetch promises rather than long real sleeps.

## 6. Dependency maintenance and accurate security documentation

Run a current production dependency audit. The October 28 baseline reported 15 affected production packages: two high and 13 moderate, including body-parser and Zod advisories. Treat that as dated evidence, not a fixed expected result.

- Inspect the installed versions, lockfile, advisory text, runtime imports, and actual public routes before deciding reachability.
- Apply compatible fixes where available. If a major migration is necessary, evaluate its impact and implement it only with adequate call-site and test coverage; document any remaining advisory with evidence and a concrete follow-up.
- Do not run `npm audit fix --force` blindly, downgrade Mineflayer to silence findings, or suppress advisories without analysis.
- Keep dependency patches reproducible through the existing install/patch mechanism. Do not rely on hand edits to node_modules.
- Update README statements that call every browser interface read-only. Document public versus private capabilities, secret requirements, model moderation limits, and the expected proxy/bind topology.
- Add or update appropriate automated checks for typechecking, tests, dependency review, and public-boundary regressions. Do not add a workflow that repeatedly fails on acknowledged unreachable advisories without a documented handling policy.

## Completion and validation

Run focused security regressions, `npm run typecheck`, `npm test`, and `git diff --check`. Broaden tests when dependency changes or failures justify it. The earlier baseline passed 980 tests; do not assume that number remains current.

Deliver the implemented changes and a concise report containing:

1. Each finding addressed, with source references and relevant regression evidence.
2. Exact checks run and their results, including current dependency findings and reachability assessment.
3. Remaining deployment assumptions: proxy normalization, trusted client-address behavior, Funnel routing, operator-secret migration, Minecraft authentication/network isolation, and external firewall/backend behavior.
4. Any issue that remains open, with severity, reason, and a specific next step.

Do not describe the public launch as approved or the deployed system as fixed based only on local tests. Do not deploy as part of this prompt.
