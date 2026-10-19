# Private viewer task controls — installed

At `https://maia.tailceb694.ts.net:3001/`, the private viewer gains a separate
“Give a task” form, Go home, Resume build, and Stop buttons, plus Bob's actual
Minecraft replies. Instructions use the configured owner's existing chat
handler, with its deterministic commands, LLM interpretation, scheduler,
preemption and policy checks. HTTP success means delivered, not completed;
the existing task status and new reply area provide execution feedback.
The question box remains read-only and directs orders to the task form.

Port 3001 is Tailscale Serve to loopback 3001. Only 443 has AllowFunnel, to the
public shell at 3003. No routing or network settings change. Public requests
cannot access the command endpoint, and public UI hides all controls. The
private endpoint requires JSON, checks Origin/Fetch metadata, rejects the
public forwarding marker, validates length, and paces sends. Stop bypasses
the one-second command cooldown. An offline bot returns 503.

Validation: full 813-test suite, typecheck, JavaScript syntax check, and
`git diff --check` passed. After the final copy/prompt adjustment, command and
Q&A tests plus typecheck passed again. Isolated Firefox preview verified
form submission, task display, actual reply rendering, input clearing,
desktop and small-screen layouts, and hidden/disabled public controls.
Preview tests use a fake bot and do not command the live bot.

Install only the eleven files in the companion manifest. Before installing,
verify every original runtime hash and every candidate hash; stop on drift.
The ten pre-existing runtime files matched HEAD during preflight. The newly
added module must be absent before installation. Create a unique Maia backup
directory `~/.local/share/blockhead-backups/viewer-control-20261019`, capture
status/service details, archive the ten existing files with relative paths,
and retain the manifest. Wait for a safe task boundary, stop only
`blockhead.service`, take a consistent SQLite backup, install the eleven
reviewed files, verify hashes, and start the one service. Do not deploy the
whole dirty checkout. The earlier doorway repair remains installed.

Corey explicitly approved installation. Live acceptance procedure:
verify one connected bot, health/hunger, no automatic restarts, viewer load,
private invalid-command validation, and public endpoint refusal. Send a
bounded “go home” through the private endpoint to check owner task routing,
then verify user task completion and its Minecraft reply in `/api/state`.

Rollback: stop `blockhead.service`, restore the archived ten files to the
runtime, verify original hashes, and start the service. The unused new module
can remain; the old index does not import it. Do not restore SQLite/world
progress or restart Minecraft/model services.

## Live deployment receipt

Installed all eleven reviewed files on Maia after approval; original and
candidate hashes matched, and a consistent SQLite backup was taken while the
bot was stopped. Runtime/archive/manifest and HTTP acceptance evidence are at
`~/.local/share/blockhead-backups/viewer-control-20261019`.

At 10:18:58 PDT the actual private HTTPS URL returned the new controls,
rejected an empty command with 400, rejected a cross-origin command with 403,
and delivered “go home” with 200. The public listener rejected commands with
404. User task `5e9abbee-4c58-41c0-af4c-c9ea8e72b62a` completed successfully,
and the private dashboard recorded Bob's server-echoed “Heading home.” reply.
Health/hunger were 20/20. Only the bot service was restarted; its automatic
restart count remained zero. The earlier doorway correction remains installed.
