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

Minecraft runs on Eros. The local `llama.cpp` server runs on Maia, normally at
`127.0.0.1:8080`.

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

## Troubleshooting

- **Service is inactive:** run `systemctl --user status blockhead.service` and
  inspect `journalctl --user -u blockhead.service`.
- **Wrong code is running:** compare the runtime copy with the source checkout,
  then repeat the `rsync` and `npm ci` steps above.
- **Config, database, or log errors:** verify that the service working directory
  is `/mnt/Repos/Games/Blockhead` and that `config/minecraft.yaml`, `data/`, and
  `logs/` exist there.
- **No Minecraft connection:** check the Eros host and port in
  `config/minecraft.yaml`.
- **LLM failures:** verify that Maia's `llama.cpp` server is running and that
  `llm.base_url` points to it.
