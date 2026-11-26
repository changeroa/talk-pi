#!/bin/zsh
set -euo pipefail
export AGENT_MESSENGER_CONFIG_DIR="${TALK_PI_CONFIG:-$HOME/.config/talk-pi}/agent-messenger"
mkdir -p "$AGENT_MESSENGER_CONFIG_DIR"
chmod 700 "$AGENT_MESSENGER_CONFIG_DIR"
cd "${0:A:h}/.."
exec "$HOME/.bun/bin/bun" node_modules/agent-messenger/src/platforms/kakaotalk/cli.ts auth "${@:-login}"
