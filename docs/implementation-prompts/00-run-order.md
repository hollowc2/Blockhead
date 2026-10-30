# Blockhead public viewer: implementation prompt order

These files are executable work instructions for an agent working in this repository. They describe work to do; they do not claim the fixes have already been implemented.

Run these prompts in order, preferably as separate implementation/review steps:

1. `01-security-hardening.md` — fix the verified security and resource-isolation gaps, review dependency exposure, and add regression coverage.
2. `02-viewer-experience.md` — improve connection feedback, public Q&A, busy states, fair viewer access, mobile usability, and lightweight viewing.
3. `03-public-launch-validation.md` — validate the combined implementation and produce an evidence-based launch decision and deployment plan.

Read the applicable repository instructions at the start of each step. Preserve unrelated changes. Use the current code as the source of truth; line numbers and dependency findings from the October 28 review can become stale.

The prompts authorize local implementation and isolated validation. They do not authorize live deployments, service restarts, changes to Funnel/Tailscale/firewalls, installing collectors on a server, or enabling public gestures. Prepare concrete deployment changes and checks locally before requesting any additional authorization that is actually required. Do not ask for approval for ordinary local edits or tests covered by the task.

Do not run multiple prompts concurrently against shared files. In particular, security and viewer work both affect the viewer shell, public interactions, and tests. Complete and validate security work before building the viewer changes on top of it.

At the end of each prompt, report the changes, tests actually run, remaining uncertainties, and any blocker. Distinguish local proof from observations of deployed behavior.

## Separate follow-up prompts after the October 29 rollout

These are additional work instructions, outside the original 01 → 03 sequence.
Run them only when separately invoked. Writing these prompts did not execute
them or authorize new live changes.

4. [04-public-model-answer-enablement.md](04-public-model-answer-enablement.md) —
   implement and verify Aegis enforcement, visitor-text privacy and backend
   cancellation, then prepare a bounded public model-Q&A enablement.
5. [05-public-gesture-validation.md](05-public-gesture-validation.md) — qualify
   admission/cancellation and independent Minecraft effect observation, then
   prepare a supervised gesture trial with actions disabled afterward.

Execute these follow-ups sequentially when both are requested: they share public
interaction code, configuration and deployment documentation. Each prompt is
self-contained and can also be invoked independently.
