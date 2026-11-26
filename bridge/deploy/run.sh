#!/bin/zsh
set -euo pipefail
CONF="${TALK_PI_CONFIG:-$HOME/.config/talk-pi}"
set -a
source "$CONF/bridge.env"
set +a
export AGENT_MESSENGER_CONFIG_DIR="$CONF/agent-messenger"
cd "${0:A:h}/.."
exec "$HOME/.bun/bin/bun" src/main.ts
