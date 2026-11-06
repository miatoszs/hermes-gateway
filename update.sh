#!/usr/bin/env bash
# Updates Hermes Gateway from git and restarts its service when something changed.
#
#   ./update.sh                  # update now
#   ./update.sh --after-hermes   # used by deploy/hermes-gateway-update.path: acts once per finished `hermes update`
#
# Env: HGW_SERVICE (systemd unit to restart, default hermes-gateway), HERMES_HOME (default ~/.hermes).
# Your .env, squad.json and data/ are untracked by git, so an update never touches them.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
SERVICE="${HGW_SERVICE:-hermes-gateway}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

# Run git as the checkout's owner (the path unit runs this as root; the tree may belong to another user).
owner=$(stat -c %U .git)
if [[ $EUID -eq 0 && "$owner" != root ]]; then git() { runuser -u "$owner" -- git "$@"; }; fi

if [[ "${1:-}" == "--after-hermes" ]]; then
  receipt="$HERMES_HOME/logs/update_receipts/latest.json"
  [[ -f "$receipt" ]] || exit 0
  id=$(node -e 'const r = require(process.argv[1]); if (r.finished_at) console.log(r.update_id || r.finished_at)' "$receipt" 2>/dev/null || true)
  [[ -n "$id" ]] || exit 0                                    # hermes update still running: we run again when it finishes
  [[ "$(cat data/.last-hermes-update 2>/dev/null || true)" == "$id" ]] && exit 0
  mkdir -p data && echo "$id" > data/.last-hermes-update
  echo "hermes update $id finished, checking for a Hermes Gateway update"
fi

before=$(git rev-parse HEAD)
git pull --ff-only --quiet
after=$(git rev-parse HEAD)
if [[ "$before" == "$after" ]]; then
  echo "Hermes Gateway is up to date ($(git log -1 --format=%h))"
  exit 0
fi
echo "Hermes Gateway updated: $(git log --format='%h %s' "$before..$after" | head -5)"
if command -v systemctl >/dev/null && systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
  systemctl restart "$SERVICE" && echo "restarted $SERVICE"
else
  echo "Restart the dashboard (npm start) to use the new version."
fi
