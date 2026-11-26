#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
[[ -s .deploy.vars ]] || { echo "missing agent/.deploy.vars (copy .deploy.vars.example)" >&2; exit 1; }
export CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' .deploy.vars)"
npx wrangler deploy
bun -e '
const vars = Object.fromEntries(
  (await Bun.file(".deploy.vars").text()).split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l) && !l.startsWith("CLOUDFLARE_"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
await Bun.write(".secrets.tmp.json", JSON.stringify(vars));
'
trap 'rm -f .secrets.tmp.json' EXIT
npx wrangler secret bulk .secrets.tmp.json
