#!/bin/bash
# One-time setup for stream alerts to Telegram (run on Maia, interactively):
#   bash /mnt/Repos/Games/Blockhead/tools/stream/telegram-setup.sh
# Asks for the bot token (from @BotFather, never echoed or logged), waits for you to send the
# bot a message, takes that private chat's ID, writes ~/.config/cobblebob-stream/telegram.env
# (0600) and sends a test alert through alert-telegram.mjs.
set -euo pipefail

conf=${STREAM_TELEGRAM_CONFIG:-$HOME/.config/cobblebob-stream/telegram.env}
here=$(cd "$(dirname "$0")" && pwd)
umask 077
mkdir -p "$(dirname "$conf")"

read -rsp "Bot token from @BotFather: " token; echo
[[ $token =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo "That doesn't look like a bot token." >&2; exit 1; }

api() { curl -fsS --max-time 35 "https://api.telegram.org/bot${token}/$1" 2>/dev/null; }
name=$(api getMe | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["username"])') \
  || { echo "Telegram rejected the token (getMe failed)." >&2; exit 1; }
echo "Bot: @$name"
echo "Now open Telegram, start a private chat with @$name and send it any message (e.g. /start)."

chat=""
for _ in 1 2 3 4 5 6 7 8; do   # up to ~4 minutes of long polls
  chat=$(api "getUpdates?timeout=30&allowed_updates=%5B%22message%22%5D" | python3 -c '
import json, sys
for u in reversed(json.load(sys.stdin).get("result", [])):
    c = (u.get("message") or {}).get("chat") or {}
    if c.get("type") == "private":
        print(c["id"]); break
') || true
  [ -n "$chat" ] && break
  echo "…waiting for your message"
done
[ -n "$chat" ] || { echo "No private message reached the bot; run this again." >&2; exit 1; }

printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' "$token" "$chat" > "$conf"
chmod 600 "$conf"
echo "Saved $conf (chat $chat)."
STREAM_TELEGRAM_CONFIG=$conf node "$here/alert-telegram.mjs" --test && echo "Test alert sent - check Telegram."
