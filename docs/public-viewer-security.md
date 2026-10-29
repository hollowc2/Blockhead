# Public viewer security implementation — local evidence

Implemented in run-order step 01. Local testing uses fake bots, temporary
listeners, real installed chunk serializers and mock inference; no live bot,
service, Funnel setting, credentials or gesture flags were changed.

## Changes and regression evidence

- `src/dashboard/http-guard.ts`: strict origin-form targets only, no alternate
  authority, fragments, backslashes, malformed escapes or normalized dot paths.
  Shell, raw viewer and dashboard HTTP/upgrade boundaries reject them safely.
  `request-target.test.ts` launches an isolated child, sends the original invalid
  URL upgrade forms to all listeners, checks healthy responses afterward and
  proves zero upstream requests. HTTP promise failures have local boundaries.
- `viewer-server.ts`: synchronous Engine.IO reservations before asynchronous
  handshake creation. Namespace attachment rechecks the reservation. Polling,
  direct WebSocket and upgrades use the same seat; pending namespace joins
  expire after five seconds. Public maximum stays configured (six in current
  YAML), with four additional total seats for private viewers and three public
  seats per canonical address (/64 for IPv6). Session close, abort, handshake
  failure and shutdown release exactly once. Shell-authored identity and mode
  must match on subsequent transport requests. Forwarded public credentials
  and identities are stripped at the shell; only its trusted identity is added.
  Tests stage six polling handshakes from different identities into two public
  seats, admit a reserved private seat, expire pending sessions, upgrade once,
  and repeat polling reconnect/cleanup cycles. These are local capacity tests,
  not production throughput measurements.
- Chunk jobs are globally paced, deduplicated by session/chunk, capped at 128
  waiting jobs and removed on disconnect. Position work is coalesced; column
  reads have a two-second bound and cancellation. Engine.IO pending packets
  (128 max) and buffered bytes (4 MiB, plus at most one bounded chunk) cause
  disconnection of slow consumers. A polling client that stops fetching is
  covered by a regression that verifies subscription/seat cleanup.
- Public chunks reconstruct through the installed `prismarine-chunk` geometry
  serializers for supported Java versions 1.18–1.21; block-entity NBT is removed,
  top-level fields are allowlisted, and nested sections are reconstructed.
  Unsupported shapes fail closed. Geometry cache has at most 64 columns and
  invalidates on block/chunk changes and server closure; each bot session owns
  its cache. Tests use real 1.21.4 sign NBT with embedded coordinates/custom
  fields and a shell-compatible public/private wire test, checking geometry,
  biomes/lights, cache reuse and invalidation. This is synthetic evidence, not
  evidence that actual live signs were exposed. Other events use explicit
  field projection; unknown public events are dropped. Private NBT is retained.
- `src/status/server.ts`: loopback-only CLI channel, bearer authentication before
  body reads, rejects all Origin/Fetch Metadata headers including Origin null,
  fixed content types, 4096-byte and five-second body bounds. Tests cover bad,
  missing and malformed credentials; origin attacks; slow/large bodies; valid
  CLI use; no-secret denial; non-loopback bind; and public listener denial.
- `src/llm/request-queue.ts` and `client.ts`: process-wide serialized ownership,
  at most 64 queued jobs and one outstanding public job. Public deadlines include
  queue waiting, discovery, retries and inference. Queued cancellation removes
  work without releasing the active predecessor; active cancellation propagates
  to fetch and ownership is held until transport settlement. Owner/autonomous
  work precedes waiting public questions, with one public turn after three
  private turns when both queues remain populated. Private diagnostics include
  queue depths and outstanding model promises even after the HTTP visitor left.
  Disable/shutdown abort questions; physical safety interrupts still cancel
  gestures only. Mock-fetch tests cover expired/abandoned queued work, active
  discovery cancellation, priority and serialization after cancellation.
  Firewall blocks remain refusals; network errors remain basic status fallback.
  Backend computation may continue after its HTTP connection aborts: verify with
  the real firewall/backend before offering model Q&A to a larger audience.

## Dependency review (registry audit during this work)

Initial `npm audit --omit=dev --json`: 15 affected packages (2 high, 13 moderate).
Compatible updates installed body-parser 1.20.9/2.4.0 and qs 6.16.2/6.17.1.
Zod migrated from 3.25.76 to 4.6.7: object input defaults now use `prefault({})`
and records have an explicit string key schema. Full tests cover configuration,
build/tool decisions and strict public inputs after migration. Public routes use
Node HTTP, not Express body-parser, and public bodies are capped before Zod.
The dependency fixes remove exposure rather than relying solely on that route
analysis. Patch script and lockfile remain the reproducible install mechanism.

Final audit at this step: **12 moderate, zero high/critical**; all affected
packages inherit one UUID advisory through `minecraft-protocol` →
`prismarine-auth` → `@azure/msal-node` → uuid 8.3.2 or `yggdrasil` → uuid 10.0.0,
and the Mineflayer plugins depending on those packages. The advisory concerns
v3/v5/v6 with caller-provided undersized output buffers/offsets. Yggdrasil uses
v4 without those arguments; offline bot authentication does not invoke the
Microsoft/Yggdrasil authentication path. Public HTTP/Socket.IO routes do not
accept UUID output buffers or invoke those functions. No public exploit path
was identified. Do not interpret offline authentication as safe against
Minecraft owner-name impersonation.

Remaining issue: moderate upstream dependency maintenance. Do not downgrade
Mineflayer or force an untested UUID major override into auth libraries. Follow
up with upstream compatible auth-library upgrades and test both offline and
Microsoft flows before changing authentication. Review again before launch and
by 2026-11-29. `scripts/audit-production.mjs` admits only this exact moderate
root advisory, prints it explicitly, and fails on any new root advisory or audit
failure. It is a scoped handling policy, not a blanket audit suppression.

Advisory sources: [body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828),
[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[qs](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw),
[UUID](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

## Operator migration (prepare locally; installation requires deployment authorization)

1. Generate a random secret (at least 32 printable characters) on the target;
   install it in an owner-readable (0600) systemd EnvironmentFile outside the
   checkout/runtime sync. Do not echo it or include it in shell command arguments.
2. Add the following to the **user** `blockhead.service` drop-in, preserving the
   existing runtime.conf and service settings:
   `EnvironmentFile=%h/.config/blockhead/operator.env` under `[Service]`.
   The protected file contains `BLOCKHEAD_OPERATOR_TOKEN=<generated secret>`.
3. Install candidate code/dependencies, then reload/restart only that user bot
   service under the reviewed deployment plan. No-secret startup keeps operator
   routes closed; there is no compatibility bypass.
4. Supply the same environment variable privately to operator tooling.
   `python3 scripts/operator-request.py public-interactions --get` reads private
   diagnostics; JSON for a mutation comes from stdin. `/command` is text/plain;
   `/public-interactions` is application/json. Neither permits compression or
   browser requests. `public-actions-observability-preflight.py` now authenticates
   its private diagnostics GET. Historical runbook POSTs without authentication
   are obsolete under this candidate.
5. Prove absent/bad credentials are denied, an authenticated diagnostics GET
   succeeds and public operator routes remain denied. Do not use an owner
   command or enable gestures just to validate credentials.

## Remaining deployment assumptions

Unverified here: Funnel exposes only the redacted listener; edge request-target
normalization/upgrade behavior; rightmost trusted address behavior; owner-only
private tailnet access; Minecraft bind/firewall/offline-name protection; actual
firewall routing, alias separation and backend cancellation; secure secret
installation; consistent world/SQLite backup restoration. A differing model URL
string alone does not establish firewall identity. These require current
read-only deployment evidence or a separately authorized staged trial.

Step 01 completion checks: `npm run typecheck` passed; `npm test` passed
**991/991** (37.1 seconds); focused regressions passed;
`npm run audit:production` passed under the explicit UUID policy;
`git diff --check` passed. Later steps extend this baseline.
