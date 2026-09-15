# Deploy Blockhead on Maia

This runbook keeps Blockhead independent of an SSH session, terminal, or tmux.

- **Zeus** is the development workstation.
- **Maia** runs Blockhead and the local `llama.cpp` server.
- **Eros** runs the Minecraft server.

The service is deliberately not containerized. systemd owns the Blockhead
process and reconnects it after an unexpected process failure.

## Prerequisites

On Maia, provide:

- Node.js 20 or newer and npm.
- A stable checkout path, used below as `/srv/blockhead` (choose another
  absolute path if preferred).
- A service account that owns or can write the checkout's `data/` and `logs/`
  directories. The example unit uses `blockhead`; change `User=` and `Group=`
  if using another account.
- A configured `config/minecraft.yaml`, including the Eros address and the
  local LLM URL. The application loads this file relative to its working
  directory.
- A running llama.cpp server on Maia, normally at `127.0.0.1:8080`, and a
  reachable Minecraft server on Eros.

The repository's production command is `npm start`, which runs `tsx
src/index.ts`. There is no separate build step.

## Install or update the checkout

Choose a path that will not change between updates, then install dependencies
as the service account:

```bash
sudo install -d -o blockhead -g blockhead /srv/blockhead
sudo -u blockhead git clone <repository-url> /srv/blockhead
cd /srv/blockhead
sudo -u blockhead npm ci
sudo -u blockhead mkdir -p data logs
```

If the checkout already exists, update it and reinstall only when the lockfile
changes:

```bash
cd /srv/blockhead
sudo -u blockhead git pull --ff-only
sudo -u blockhead npm ci
```

Edit `/srv/blockhead/config/minecraft.yaml` and verify its `server`, `home`,
`agent.owner`, and `llm.base_url` values before starting the service.

## Deploy from Zeus with the script

Once the checkout and systemd unit are installed on Maia, run the deployment
from the repository checkout on Zeus:

```bash
./scripts/deploy-maia
```

The script connects to Maia over SSH, refuses a dirty remote working tree,
updates the configured branch with `git pull --ff-only`, runs `npm ci`,
`npm run typecheck`, and `npm test`, then restarts the service and prints its
status. It stops immediately on failure, so a failed install, typecheck, or
test does not restart the working service. It never discards local changes.

Defaults can be overridden with environment variables near the invocation:

```bash
SSH_HOST=maia REMOTE_REPO=/srv/blockhead SERVICE_NAME=blockhead \\
  DEPLOY_BRANCH=main ./scripts/deploy-maia
```

The defaults are `maia`, `/srv/blockhead`, `blockhead`, and `main`,
respectively. If the checkout is dirty or the branch cannot be advanced
fast-forward-only, fix that condition on Maia and rerun the script; it will
not reset, clean, or overwrite the checkout.

To follow Blockhead logs remotely while deploying:

```bash
ssh maia 'journalctl -u blockhead -f'
```

Use `sudo` inside the command if Maia's journal permissions require it.

## Find npm and install the unit

Run this as the same account that will run Blockhead:

```bash
sudo -u blockhead sh -lc 'command -v npm'
```

Copy the printed absolute path. Do not assume it is `/usr/bin/npm`: npm may be
installed by nvm, fnm, Volta, or another Node version manager. systemd does not
load an interactive shell profile, so a version-manager installation must be
usable from a non-interactive service environment; otherwise install Node/npm
system-wide or use an absolute path that is available to the service account.

Copy the example unit, then replace these placeholders in the copy:

- `User=` and `Group=` with the service account.
- `WorkingDirectory=` with the checkout root, for example `/srv/blockhead`.
- `ExecStart=` with the absolute npm path followed by `start`, for example
  `/usr/local/bin/npm start`.

```bash
sudo cp deploy/blockhead.service.example /etc/systemd/system/blockhead.service
sudoedit /etc/systemd/system/blockhead.service
sudo systemd-analyze verify /etc/systemd/system/blockhead.service
sudo systemctl daemon-reload
sudo systemctl enable blockhead.service
sudo systemctl start blockhead.service
```

`WorkingDirectory` is important: `config/minecraft.yaml`,
`data/blockhead.db`, `logs/blockhead.log`, and
`logs/blockhead-debug.jsonl` are resolved from it. The service does not change
those application paths or introduce a second configuration mechanism.

The example waits for `network-online.target`. This only orders startup after
network initialization; Blockhead itself also retries an initially unavailable
Eros connection with backoff. Keep the llama.cpp server as a separate process
or service and make sure its URL matches the YAML configuration.

## Operate the service

Use these commands on Maia:

```bash
sudo systemctl start blockhead.service
sudo systemctl stop blockhead.service
sudo systemctl restart blockhead.service
sudo systemctl status blockhead.service
sudo systemctl is-active blockhead.service
sudo systemctl is-enabled blockhead.service
```

Follow the service journal:

```bash
sudo journalctl -u blockhead.service -f
sudo journalctl -u blockhead.service -n 200 --no-pager
```

Blockhead also writes application files under the checkout:

```bash
less /srv/blockhead/logs/blockhead.log
less /srv/blockhead/logs/blockhead-debug.jsonl
```

To stop it intentionally, use `systemctl stop`, not `kill -9`. Blockhead
handles SIGTERM/SIGINT as a clean shutdown and exits with status 0. The unit's
`Restart=on-failure` therefore does not start it again after an intentional
stop. If Blockhead has already spawned in Minecraft and then disconnects
unexpectedly, it exits status 1; systemd starts a fresh process after five
seconds. This is the expected recovery path for an unexpected Minecraft
connection loss.

Because systemd is the parent process, Blockhead continues running after SSH
disconnect, terminal logout, or tmux closure. No tmux session is required.

## Troubleshooting

- **`status=203/EXEC` or npm not found:** rerun `command -v npm` as the service
  account and put that absolute path in `ExecStart`. Check that its Node/npm
  installation does not depend on an interactive shell profile.
- **Config or SQLite errors:** check `WorkingDirectory`, confirm the checkout
  contains `config/minecraft.yaml`, and ensure the service account can write
  `data/` and `logs/`.
- **Unit starts but no Minecraft connection:** inspect `journalctl` for the
  `spawned` or retry messages, verify DNS/routing to Eros, and check the
  `server.host` and `server.port` values in the YAML. Initial connection
  failures are retried in-process, so systemd may correctly show the unit as
  active while it waits for Eros.
- **LLM decisions fail:** confirm the llama.cpp server is running on Maia and
  that `llm.base_url` points to it. The Blockhead unit does not start or
  supervise llama.cpp.
- **Unit changes are ignored:** run `sudo systemctl daemon-reload` after
  editing the installed unit, then use `restart`.
- **Repeated abnormal restarts:** inspect the journal and the two application
  log files before changing the restart policy. A configuration exception will
  also be an on-failure exit and should be fixed rather than hidden.
