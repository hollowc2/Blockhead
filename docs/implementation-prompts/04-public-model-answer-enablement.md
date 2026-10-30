# Make public model answers safe to enable through Aegis

You are working on Blockhead and its existing Aegis integration. Implement and
validate the missing enforcement, privacy and cancellation guarantees, and
prepare a concrete rollout that can restore model-backed public Q&A. Complete
the authorized implementation and isolated verification; do not stop at a review
or a proposed plan. Keep model answers disabled until the enablement criteria
below are supported by evidence.

## Scope and authorization

This prompt authorizes local source changes, regression tests, isolated fixtures,
read-only investigation using available authorized access, and preparation of
deployment artifacts. It does not itself authorize a new live Aegis deployment,
service-environment change, prompt/log deletion, backend restart, network change,
or enabling public model answers. Apply any explicit authorization already given
for those specific actions; do not ask again for an action already covered.
The earlier Blockhead rollout is not blanket authorization to reconfigure Aegis.
Finish concrete implementation, tests, exact deltas and rollback instructions
before requesting any additional authorization that is actually needed.

Read applicable repository/server instructions, inspect the working tree, and
preserve unrelated edits. Do not run `src/index.ts`, connect a second bot, or send
attack/load tests to the production public endpoint. The NFS checkout's
`config/minecraft.yaml` is **live configuration**, even when edited from Zeus.
Use fixture configuration and proposed patches; leave live flags unchanged
during preparation. Do not print secrets or dump service/process environments.

## 1. Establish the current baseline

Read these documents, treating historical assertions as dated observations:

- `docs/public-viewer-deployment.md` and its linked deployment receipt.
- `docs/public-viewer-launch-readiness.md` and `docs/public-viewer-security.md`.
- `docs/public-model-questions-2026-10-24.md`.
- `docs/deployment-maia.md` for service identity; use the newer deployment
  receipt's staged installation/backup process instead of blindly invoking the
  older broad sync or convenience deploy script.

At the October 29 deployment, runtime `87ec52c` had public viewing and basic Q&A
enabled, with `model_questions.enabled: false` and `actions_enabled: false`.
Aegis on loopback port 8000 was healthy with its classifier loaded, but the actual
process had `ENFORCEMENT_MODE=monitor` and `REDACT_PROMPTS_IN_LOGS=false`. A benign
model answer worked before model Q&A was disabled. Neither that answer nor a
healthy classifier proves enforcement. In that Aegis revision, monitor mode
forwarded flagged input while output guards still applied. Recheck current code
and effective settings; do not assume those details remain unchanged.

Trace the current Blockhead path through `src/index.ts`,
`src/dashboard/public-interactions.ts`, `public-model-chat.ts`, `public-chat.ts`,
`src/llm/client.ts`, `request-queue.ts`, configuration and associated tests.
Identify Aegis's actual source repository/revision, runtime, service unit and
configuration precedence from available evidence. Its observed runtime was
`/home/corey/.local/share/aegis-runtime` under Maia's user `aegis.service`.
Do not guess its development checkout or edit the installed runtime as source.
Work in an authorized source workspace. If source access is missing, complete
the independent Blockhead work and prepare a version-specific Aegis patch where
possible; identify the exact remaining dependency instead of inventing an API.

Record source/lock identities and only allowlisted non-secret effective settings.
Never print an environment file, token, model prompt, canary or request body to
establish identity. Distinguish observed facts, source conclusions and unknowns.

## 2. Enforce the actual public firewall path

Implement the minimum changes needed in the appropriate source repositories:

- Flagged visitor input must be refused before any backend inference request
  starts. Preserve output inspection/redaction/blocking as appropriate. Classifier
  failure, unavailable policy, unsupported schema or guard timeout must not turn
  into unfiltered forwarding for public Q&A.
- Verify the effective scan-role policy against Blockhead's real message shape:
  one visitor user message plus a system message built only from public facts.
  Visitors cannot select roles, tools, models, endpoints or firewall policy.
- Establish a private, versioned readiness/capability check, or another concrete
  trustworthy mechanism, that distinguishes enforced protection from monitor
  mode, an unloaded classifier, an incompatible firewall or direct llama.cpp.
  A generic HTTP 200 or a different URL string is insufficient. Inspect existing
  capabilities before adding an endpoint; expose no management authority or
  sensitive settings publicly. Define startup, stale-readiness and mid-session
  enforcement-loss behavior, with bounded probes and fail-closed fallback.
- Review direct-backend aliases, redirects, model discovery, retries and failure
  paths. Public requests must stay on the intended firewall path. They must never
  retry directly against `llm.base_url`, including when Aegis refuses or is down.
  Reject or safely constrain upstream redirects that escape that boundary.
- A verified firewall block produces the existing refusal classification.
  Infrastructure failures may produce a rules-based answer. Keep model, rules,
  refusal, timeout and cancellation outcomes honest in responses/diagnostics;
  never present a canceled answer as successful inference.

Owner chat and autonomous decisions retain their existing direct model path.
Public messages remain tool-free, absent from Bob's memory/task inputs, and
limited to `publicFacts()`. Do not route owner traffic through the public guard
or relax the public data allowlist to improve answers. Moderation remains an
additional defense, not proof that all prompt injection is solved.

## 3. Stop retaining unnecessary visitor text

Trace prompt/response handling through Blockhead debug/error logging, Aegis
application/access logs, audit database, exceptions, backend logging and proposed
monitoring. Verify what `REDACT_PROMPTS_IN_LOGS` actually protects: its name alone
does not establish that answers, error bodies, canaries and downstream logs are
also covered.

Prepare a minimal privacy-preserving configuration and code changes where
needed. Routine records should contain generated correlation IDs, fixed outcome
codes, guard stage, counts and durations, with bounded cardinality and retention.
Do not retain raw visitor questions/answers, addresses or private bot context.
Keep enough fixed-outcome evidence to investigate refusals and cancellation.

Use synthetic canaries in isolated tests to prove sensitive strings are absent
from every covered sink, including failure paths. Document any sink you could
not inspect. Existing production logs are a separate retention/remediation issue:
do not delete them, install a collector, or restart journald to complete this
task. Propose exact permissions/rotation changes when required and preserve
unrelated Aegis consumers' contracts.

## 4. Prove cancellation reaches the inference backend

Preserve and extend the current bounded queue rather than restoring obsolete
FIFO/no-waiter behavior from older planning notes. The current implementation
serializes inference, permits at most one outstanding public job, prioritizes
private jobs and gives a waiting public job a turn after three private jobs.
Inspect its actual limits and existing tests before changing policy.

Trace one request through browser/HTTP disconnect, interaction deadline or
disable/shutdown, Blockhead queue/model discovery/fetch, Aegis guard/proxy
transport, and backend generation. Implement missing cancellation propagation:

- A canceled/expired queued public request never starts inference later.
- A canceled active request closes the downstream/upstream work as supported by
  the installed versions. An HTTP client's timeout is not a backend stop receipt.
- Keep model ownership until transport/work settlement. Do not admit concurrent
  backend work just because a wrapper promise stopped waiting. Define a bounded,
  conservative failure state if backend settlement cannot be established.
- Bound all admission, classification, discovery, response reading and proxy
  work within the end-to-end deadline. Retain streaming body limits and no public
  retries; avoid accumulating model work hidden from private diagnostics.
- Owner/autonomous work remains responsive under a bounded public workload;
  measure the delay instead of claiming zero interference.

Use an isolated real Aegis/backend stack or an approved staging equivalent to
correlate cancellation with backend request completion/slot release and a
subsequent private request. Run GPU-heavy tests only in an appropriate isolated
or explicitly approved environment. Mock-fetch tests alone cannot prove real
backend cancellation. If that proof is unavailable or the backend keeps running,
keep model Q&A disabled and deliver the implemented fixes plus the exact remaining
backend limitation. Do not silently provision a second inference service.

## 5. Regression and acceptance matrix

Build meaningful deterministic tests with a counting fake backend and controlled
classifier/proxy failures, plus bounded integration tests where available:

- Benign question receives a model answer through an enforced firewall.
- A known guard-positive synthetic input is blocked; backend invocation count is
  zero. Separately exercise output blocking/redaction with synthetic canaries.
  State the limited coverage of these cases; do not claim universal moderation.
- Monitor mode, missing classifier, incompatible readiness, enforcement loss,
  redirects and direct-backend aliases cannot silently enable public inference.
- Classifier/proxy/model discovery failures, malformed/oversized responses and
  timeouts preserve refusal/rules fallback without private endpoint leakage.
- Abort while queued, classifying, connecting and generating; disable and
  shutdown; cancellation/settlement races; repeated reconnects and bounded
  concurrent attempts. Prove accurate counters and no leaked work/listeners.
- A private request retains the documented priority/fairness behavior under
  mocked slow public work; real-backend observations quantify remaining delay.
- Request content cannot create tools/actions, owner commands, persisted tasks,
  private context or HTML execution in the public page. Existing viewer security
  and authentication regressions remain green.
- Synthetic private strings do not appear in tested logs/audit/debug sinks.

Run focused tests in both changed repositories, relevant full suites,
`npm run typecheck`, `npm test`, `git diff --check`, and the applicable production
dependency audit policy. Record exact commands, revisions, workload, durations,
results and limitations. The previous 1,006 passing tests are historical evidence,
not the expected test count after this work.

## 6. Deliver a reviewable enablement package

Write `docs/public-model-answer-enablement.md` and a sanitized evidence file under
`docs/investigations/`. Include:

1. Implemented changes and relevant source references in Blockhead and Aegis,
   effective-policy verification, logging coverage and cancellation evidence.
2. An explicit decision: ready for a bounded authorized enablement trial, or
   still disabled with precise failing/missing evidence. Separate local, staging
   and live observations. Fix stale documentation without rewriting old receipts.
3. Exact candidate configuration/unit changes for `ENFORCEMENT_MODE=enforce`,
   verified text-redaction/retention settings and Blockhead's model flag. Name
   every service requiring restart; preserve secret files and other overrides.
4. Staged deployment with immutable revisions/hashes, native/dependency checks,
   private backups and rollback records before changes. Validate Aegis privately
   before enabling Blockhead model Q&A. Restart only services explicitly covered
   by the eventual authorization; leave Minecraft, network exposure and gestures
   unchanged. Confirm one bot and retained owner/autonomous behavior.
5. A bounded supervised trial with benign Q&A, outcome classification, backend
   settlement and rollback/stop conditions. Any guard/cancellation probes on a
   live endpoint must be explicitly included in that trial's authorization.
6. A fast disable path returning to basic Q&A and a precise application/config
   rollback that preserves current SQLite/world progress and protected secrets.
   Avoid rolling Aegis back to monitor mode while public model answers remain on.

Finish with links to the candidate/evidence and a concise result. If further
authorization is needed, ask only for the exact prepared live actions. Do not
claim public model answers enabled unless the authorized rollout and post-change
checks actually occurred. Do not implement the gesture prompt concurrently.
