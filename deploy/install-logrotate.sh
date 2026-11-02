#!/usr/bin/env bash
# Run on maia: installs hourly log rotation for the bot's file logs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install -D -m 644 "$here/blockhead-logrotate.conf" "$HOME/.config/blockhead/logrotate.conf"
install -D -m 644 "$here/blockhead-logrotate.service" "$HOME/.config/systemd/user/blockhead-logrotate.service"
install -D -m 644 "$here/blockhead-logrotate.timer" "$HOME/.config/systemd/user/blockhead-logrotate.timer"
mkdir -p "$HOME/.local/state"
logrotate --debug --state "$HOME/.local/state/blockhead-logrotate.status" "$HOME/.config/blockhead/logrotate.conf" 2>&1 | grep -iE "error|considering|rotating|needs" || true
systemctl --user daemon-reload
systemctl --user enable --now blockhead-logrotate.timer
