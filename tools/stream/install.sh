#!/usr/bin/env bash
# Installs the streamer into a runtime directory separate from the bot.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=$HOME/.local/share/cobblebob-stream
mkdir -p "$dest" "$HOME/.config/cobblebob-stream" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/cobblebob-stream"
install -m 644 "$here/stream.mjs" "$here/package.json" "$dest/"
(cd "$dest" && npm install --no-audit --no-fund --omit=dev)
npx -y playwright@1.56.1 install chromium-headless-shell
install -m 644 "$here/cobblebob-stream.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
echo "Put the stream key in ~/.config/cobblebob-stream/stream.key (chmod 600), then:"
echo "  systemctl --user enable --now cobblebob-stream.service"
