# Blockhead on Maia

This is the current Maia layout. There are two Blockhead paths, but only one
running service:

```text
/mnt/Repos/Games/Blockhead                 source checkout + live state
  config/minecraft.yaml                    configuration
  data/blockhead.db                        SQLite state
  logs/                                     application logs

/home/corey/.local/share/blockhead-runtime  local runtime copy
  src/                                      code executed by the service
  node_modules/                             runtime dependencies

systemd --user: blockhead.service           keeps the bot running
```

The source checkout is NFS-mounted on Maia. The runtime copy is local to Maia
so the bot does not execute code or dependencies directly from NFS. The
service's working directory remains the source checkout, so relative paths for
configuration, SQLite, and logs resolve there.

The Minecraft Java server also runs on Maia, from `~/mc-server`, as the user
service `minecraft-server.service` (unit source: `deploy/minecraft-server.service`).
It runs inside tmux on its own socket, so the console is
`tmux -L mc attach -t java-server`. Because the unit restarts the server, stop
or restart it with `systemctl --user`, not a console `stop`. The bot connects
over `127.0.0.1:25565`, and the drop-in `deploy/blockhead-after-minecraft.conf`
starts the bot after the server. The local `llama.cpp` server runs on Maia at
`127.0.0.1:8080` as the user service `llama-server.service` (unit source:
`deploy/llama-server.service`): a prebuilt CUDA 12.8 llama.cpp release in
`~/.local/share/llama/bin` serving `/mnt/Models/Qwen/Qwen3.5-9B-Q5_K_M.gguf`
fully on the GTX 1070 Ti.

## Check the live installation

Run these on Maia:

```bash
systemctl --user status blockhead.service
systemctl --user cat blockhead.service
readlink -f /mnt/Repos/Games/Blockhead
ls -ld /home/corey/.local/share/blockhead-runtime
```

The service should show a drop-in at:

```text
~/.config/systemd/user/blockhead.service.d/runtime.conf
```

That drop-in sets:

```ini
WorkingDirectory=/mnt/Repos/Games/Blockhead
ExecStart=%h/.local/share/blockhead-runtime/node_modules/.bin/tsx %h/.local/share/blockhead-runtime/src/index.ts
```

Do not use `/srv/blockhead`, a system-level `blockhead.service`, tmux, or
`nohup`. Those belong to older deployment attempts and are not the active
installation.

## Update the bot

Update the source checkout first, then copy the code to the local runtime and
restart the user service. Do this from Maia so the source and runtime paths are
unambiguous:

```bash
cd /mnt/Repos/Games/Blockhead
git pull --ff-only
npm ci
npm run typecheck
npm test

rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  --exclude logs \
  /mnt/Repos/Games/Blockhead/ \
  /home/corey/.local/share/blockhead-runtime/

cd /home/corey/.local/share/blockhead-runtime
npm ci
systemctl --user daemon-reload
systemctl --user restart blockhead.service
systemctl --user status --no-pager blockhead.service
```

`data/` and `logs/` are deliberately excluded from the runtime sync. They
belong to the source checkout because that is the service working directory.
Never run a second Blockhead process from the source checkout.

For a quick status check after an update:

```bash
systemctl --user is-active blockhead.service
journalctl --user -u blockhead.service -n 100 --no-pager
tail -n 100 /mnt/Repos/Games/Blockhead/logs/blockhead.log
```

The service is user-owned, so use `systemctl --user` and
`journalctl --user`; do not add `sudo`.

## Stop or restart

```bash
systemctl --user stop blockhead.service
systemctl --user start blockhead.service
systemctl --user restart blockhead.service
```

The unit is enabled for the user session and restarts after a process failure.
Stopping it intentionally is safe; do not use `kill -9` or start a replacement
with `nohup`.

Maia's user manager sets `DefaultTimeoutStopSec=10s`, so systemd SIGKILLs the
bot 10 seconds after SIGTERM. Blockhead's shutdown fits inside that: it aborts
the active task (saved as paused, resumed on the next start), disconnects the
bot, closes the HTTP/WebSocket servers, checkpoints and closes SQLite, and
flushes the logs. Every step is time-bounded, and a hard exit fires after 8
seconds (`SHUTDOWN_HARD_TIMEOUT_MS` in `src/index.ts`). Keep that below the stop
timeout. A normal stop logs `shutdown requested` and `shutdown complete;
exiting` and takes well under a second:

```bash
journalctl --user -u blockhead.service -n 30 --no-pager | grep -E "shutdown|Stopped|timeout"
```

A `blockhead: shutdown ... forcing exit` line on stderr means a step overran
its bound; the task is still resumable, but look at what it was doing.

## Troubleshooting

- **Service is inactive:** run `systemctl --user status blockhead.service` and
  inspect `journalctl --user -u blockhead.service`.
- **Wrong code is running:** compare the runtime copy with the source checkout,
  then repeat the `rsync` and `npm ci` steps above.
- **Config, database, or log errors:** verify that the service working directory
  is `/mnt/Repos/Games/Blockhead` and that `config/minecraft.yaml`, `data/`, and
  `logs/` exist there.
- **No Minecraft connection:** check `systemctl --user status minecraft-server`
  and the host and port in `config/minecraft.yaml`.
- **LLM failures:** verify that Maia's `llama.cpp` server is running and that
  `llm.base_url` points to it.
