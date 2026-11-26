#!/bin/zsh
set -euo pipefail
HERE="${0:A:h}"
CONF="${TALK_PI_CONFIG:-$HOME/.config/talk-pi}"
[[ -s "$CONF/bridge.env" ]] || { echo "missing $CONF/bridge.env (copy bridge/bridge.env.example)" >&2; exit 1; }
LABEL="$(sed -n 's/^BRIDGE_LABEL=//p' "$CONF/bridge.env")"
LABEL="${LABEL:-talk-pi-bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$CONF/agent-messenger" "$HOME/Library/Logs"
chmod 700 "$CONF" "$CONF/agent-messenger"
chmod +x "$HERE/run.sh" "$HERE/login.sh"
(cd "$HERE/.." && "$HOME/.bun/bin/bun" install --frozen-lockfile)

sed -e "s#__RUN__#$HERE/run.sh#" -e "s#__CONF__#$CONF#g" -e "s#__LABEL__#$LABEL#g" -e "s#__HOME__#$HOME#g" "$HERE/bridge.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state =|path ='
