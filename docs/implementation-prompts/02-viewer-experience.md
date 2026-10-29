# Implement Blockhead public viewer experience improvements

You are working in the Blockhead repository. Implement a polished public spectator experience on top of the completed security hardening work. This is a local implementation task: make the changes, validate them, and report the outcome.

## Preparation and boundaries

Read applicable repository instructions and the completed security work before editing. Inspect current viewer behavior and tests so you extend existing features instead of duplicating them. Important files include:

- `src/dashboard/public/viewer-shell.html`
- `src/dashboard/public/viewer-shell.js`
- `src/dashboard/public/viewer-shell.css`
- `src/dashboard/viewer-shell.ts`
- `src/dashboard/viewer-server.ts`
- `src/dashboard/public-interactions.ts`
- `src/dashboard/public-state.ts`
- `src/dashboard/public-model-chat.ts`
- `scripts/patch-prismarine-viewer.mjs`
- Relevant viewer, public-state, interaction, patch, and shell tests.

Preserve unrelated edits and the existing visual language. Keep public and private behavior distinct. Never expose owner controls, coordinates, player identities, raw errors, operator credentials, model prompts, or internal diagnostic data to make the public experience more informative. Keep public interactions optional and gestures disabled according to the existing configuration. Do not enable live features or deploy.

## 1. Show the actual visitor connection state

The shell currently derives viewer availability mainly from the server's viewer status. A running server does not prove that this browser has a working socket or rendered world.

Implement a clear visitor-facing lifecycle covering loading, connecting, connected, reconnecting, capacity reached, temporarily unavailable, offline bot, and unsupported/failed WebGL. Distinguish state/API availability from 3D transport availability.

Requirements:

- Wire the actual iframe renderer/socket lifecycle back to the shell through a narrow integration that survives the existing dependency-patching workflow.
- If using postMessage, validate both origin and source and validate the message schema. Do not accept arbitrary status, commands, or HTML from unrelated windows.
- Show a useful recovery action appropriate to the cause: retry with bounded backoff, reopen 3D, or switch to the lightweight view. Avoid an infinite rapid reconnect loop when capacity is full.
- Clear stale connection state on frame reload, disconnect, bot-session replacement, and navigation.
- Treat partial failure honestly: a working status feed with a failed 3D view should remain useful and should not say Bob is offline.
- Avoid exposing internal upstream addresses or raw error details in public copy.

Acceptance: test the state transitions with a controllable fake transport/iframe. Verify capacity denial, reconnection, first world readiness, WebGL failure, stale messages from a replaced frame, and successful recovery. Do not equate socket connection alone with completed scene loading.

## 2. Make public Q&A a usable conversation

The public interface currently replaces a single reply element. Add a compact per-tab history of submitted questions and answers, suggested questions, clear pending feedback, and honest fallback messaging.

Requirements:

- Retain a small bounded history in the current tab; provide a clear-history control. Do not add a shared public chat feed or a server-side question archive.
- Render visitor text and model answers strictly as text. Do not interpret HTML, Markdown links, or model-provided actions.
- Preserve typed text after refusal, transient failure, or a shared cooldown. Clear it only after the chosen successful submission behavior; do not lose text during polling or reconnects.
- Add a few useful suggested questions drawn from the actual public facts, such as health, time, and current general activity. Respect the same validation and cooldowns as typed questions.
- Distinguish a model answer, a basic status fallback, and a refusal through a small safe response classification if needed. Explain fallback as basic status being available while Bob cannot answer freely; never expose internal firewall reasons, model configuration, or prompts.
- Keep an honest pending state and bounded wait. Do not invent queue positions or completion estimates that the server cannot support.
- Avoid duplicate submissions while a question is pending. Do not automatically retry an already-submitted action or question after an ambiguous network failure.
- Announce new results accessibly without rereading the entire transcript every second. Preserve keyboard focus and avoid opening a mobile keyboard after a suggested-question tap unnecessarily.

Acceptance: answer history is bounded; user/model HTML stays inert; keyboard submission works; slow/aborted requests settle correctly; input survives failures; fallback and refusal wording match actual server outcomes. Confirm the public model still has no tool access and only receives public facts.

## 3. Make busy states and cooldowns consistent

The current availability response can say another viewer is being answered while the Ask button remains enabled. Reconcile feature enablement, immediate admission, connection state, pending work, and per-visitor/shared cooldowns.

Requirements:

- Disable controls whenever the server explicitly reports they cannot currently be admitted; distinguish disabled-by-operator, busy, offline, cooling down, and full capacity in plain language.
- Make reasons programmatically associated with their controls. A disabled button alone must not be the only explanation.
- Use server-provided retry timing. Account for request latency and updated state without repeatedly extending a countdown incorrectly.
- Keep per-visitor limits separate from shared limits, and keep hello-specific cooldowns from disabling unrelated gestures.
- Continue enforcing every limit server-side. Browser state is advisory and must not become an authorization boundary.
- A gesture timeout or uncertain acknowledgement must say delivery was not confirmed. Do not automatically replay it or label it successful.
- Explain that physical gestures are available only when Bob is idle and safe, without publishing detailed threat/admission diagnostics.

Acceptance: test combined busy/cooldown/offline states, feature toggling during a request, conflicting poll/response timing, hello-only limits, and retry-after recovery. Ensure the UI does not encourage a submission the current state already identifies as unavailable.

## 4. Make limited viewer capacity fair and understandable

Build on the corrected session accounting from the security prompt. The checked-in public-viewer capacity was six; do not increase it merely to hide admission problems.

Requirements:

- Display a friendly full-capacity state while retaining useful status/story content.
- Use bounded retries with jitter and a manual retry option. Do not create multiple hidden sessions or repeatedly reserialize the world while a visitor waits.
- Provide an explicit pause/release-3D control so visitors can free their seat while retaining the status feed.
- Define and document idle/background-tab seat behavior. Release seats after an appropriate grace period and reconnect on return with clear feedback. Do not eject an actively watching visitor solely because they have not clicked recently.
- Ensure the configured public seat cap and private reserved capacity remain enforced under simultaneous retries and reconnects.
- If you implement a waiting queue, bound its size and lifetime, issue opaque entries, and only show a position or estimate if it is accurate. A bounded retry design is acceptable when a real queue would add unnecessary complexity.

Acceptance: simulate multiple viewers, an abandoned tab, reconnect bursts, and seat release/reacquisition. Verify private capacity remains available and a waiting viewer cannot monopolize pending reservations.

## 5. Add lightweight viewing and improve first use on mobile

Requirements:

- Offer a lightweight mode with public status, health/hunger, story, and Q&A without creating a 3D viewer session. Ensure an iframe is not invisibly loading and consuming a seat behind the text view.
- Remember the visitor's chosen mode safely using bounded local preference data, with storage failures handled. Do not persist conversation text or identity by default.
- Pause rendering and unnecessary polling in background tabs where feasible, while respecting the seat policy above. Resume with a fresh snapshot and an honest connection state.
- Provide concise first-use help explaining what Bob is, what the public controls can do, and why he may refuse or be busy. Make help dismissible and reopenable.
- Make touch controls and camera instructions usable on narrow screens; desktop mouse-only hints are insufficient.
- Keep focus visible, labels meaningful, touch targets usable, layouts free of horizontal overflow, and reduced-motion preferences respected.
- Preserve the existing private owner's maps, jobs, previews, commands, and camera controls.

Acceptance: inspect desktop and narrow/mobile layouts, keyboard operation, reduced motion, storage-disabled behavior, WebGL unavailable behavior, and hidden-tab recovery. Confirm lightweight mode really avoids a viewer seat and 3D workload.

## Validation and completion

Use the available browser workflow to visually inspect the actual local UI if available. Use isolated fixture data and fake services; do not start a second production bot or send test actions into the live world. If browser tooling cannot run, report that limitation precisely and complete the local checks that are available.

Add meaningful behavioral tests for the new state transitions and server contracts; do not write tests that merely search for strings in implementation files. Run focused tests, `npm run typecheck`, `npm test`, and `git diff --check`. Verify the dependency patch remains idempotent and survives the supported clean-install workflow when patch code changes.

Update the README/operator documentation for new viewer states, lightweight mode, and seat behavior. Deliver a concise account of implemented behavior, validation, visual checks, and any remaining limitation. Do not claim public launch readiness or deploy as part of this prompt.
