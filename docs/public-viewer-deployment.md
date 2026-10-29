# Public viewer deployment — 2026-10-29

Deployed `87ec52c7e3c58c2b9e98ff4ece2ae0164873d8d9` to Maia's user
`blockhead.service`, following the user's explicit instruction to commit, push
and deploy. The runtime remains `/home/corey/.local/share/blockhead-runtime`;
configuration, SQLite and logs remain in the shared source working directory.
The later receipt commit changes documentation only.

The public viewer and basic status Q&A are enabled. Gestures remain disabled.
Model-backed public answers are now disabled: the actual Aegis process has
`ENFORCEMENT_MODE=monitor` and `REDACT_PROMPTS_IN_LOGS=false`. A benign model
question worked before this finding, but availability does not prove enforcement.
The final public question returned `answerKind: rules`. Aegis and its credentials
were not changed. Re-enabling model answers requires enforcement, retention and
cancellation validation.

## Validation and deployment corrections

Both Zeus and Maia passed 1,006 tests. TypeScript checks passed, and Maia completed
a clean locked install with native modules and the renderer postinstall patch.
The production audit policy passed with the documented UUID exception: twelve
moderate affected packages, zero high or critical advisories.

The initial deployment of `d0516bf` failed the live 3D smoke check: a populated
world's synchronous entity snapshot filled the packet queue before network I/O
could drain it. The application was rolled back and its public listener closed.
Commit `729d15d` paces that snapshot in batches, waits for delivery, bounds waiting
and cancels on disconnect. New regression tests deliver 600 entities and geometry
over both WebSocket and polling. The byte and packet limits remain enforced.
The corrected release was independently staged and tested on Maia before rollout.
Commit `87ec52c` applies the rules-only Q&A configuration.

Final live checks established:

- Exactly one actual bot process, connected at health 20; user service active
  with zero automatic restarts and no warning/error records in the sampled final
  systemd invocation.
- Private dashboard/shell, health, public shell/assets and public state respond.
  Missing/bad operator credentials return 401; Origin/Fetch Metadata requests
  return 403; authenticated local diagnostic GET returns 200. The new credential
  is outside Git, in an owner-only directory with file mode 0600, loaded through
  the operator systemd drop-in.
- Public command, map and diagnostic routes return 404 even with credentials.
  No operator command or gesture was invoked as a probe.
- A WebSocket through the existing HTTPS hostname received version and geometry
  with block-entity metadata absent. This check ran from Zeus, not an independent
  off-tailnet client. After closing it, seats and queued chunk work returned to
  zero, with no slow-consumer disconnects. Public model queue counts were zero.
- A final benign public question returned a rules-based answer with HTTP 200.
  Existing routes and listener bindings were preserved. Only the existing
  redacted port 3003 route has Funnel enabled; private Serve routes are unchanged.
- Minecraft, llama-server and Aegis retain their original service PIDs. No
  Minecraft/model/Aegis/journald restart or network-policy change occurred.

The [machine-readable receipt](investigations/public-viewer-deployment-2026-10-29.json)
records hashes, process IDs, resource counts and test results without tokens,
question/answer text, world coordinates or owner command context. Its deployment
observations supplement the earlier local manifests; they do not rewrite them.

## Recovery and persistent state

Before application changes, the actual clean runtime was verified against its
Git revision and archived. Previous dependencies were retained by renaming their
directory. Unit/drop-ins and configuration were captured privately. Each stopped
bot interval received a SQLite backup via the backup API; integrity checks passed.
No older database or Minecraft world was restored during the rollback or rollout.
The first rollback successfully exercised application restoration while preserving
current progress; this is not a disaster-recovery rehearsal for the world.

Full application rollback is recorded under:
`/home/corey/.local/share/blockhead-backups/public-viewer-d0516bf-20261029T212432Z/`.
The final configuration and latest SQLite backup are under:
`/home/corey/.local/share/blockhead-backups/public-viewer-rules-only-20261029/`.
Run the captured procedure on Maia if application rollback is needed:

```sh
python3 /home/corey/.local/share/blockhead-backups/public-viewer-d0516bf-20261029T212432Z/rollback.py
```

It stops only Blockhead, restores application code/dependencies, disables the
public listener and interactions in the source configuration, preserves current
database/world progress and the protected credential, reloads the user manager
and starts the bot. Older code must remain unpublished. The backup record and
receipt identify the archive and database hashes.

## Remaining launch gates

This repairs an existing deployment; it does not certify a broader public launch.
Owner-only tailnet ACLs and forwarding-address trust are still unverified.
Minecraft is in offline mode and binds all interfaces; allowlisting is enabled,
but firewall isolation could not be read without sudo. No firewall was changed.
The existing application log was about 593 MB with mode 0644, with no verified
rotation. Bounded retention and an isolated paired SQLite/world restore rehearsal
remain outstanding. Model answers and gestures stay disabled pending their
respective independent safety requirements in the
[launch assessment](public-viewer-launch-readiness.md).
