#!/usr/bin/env bash
# Turns on the Hermes API server for Hermes profiles so Hermes Gateway can talk to them.
#
#   ./enable-api.sh              # every profile in $HERMES_HOME/profiles
#   ./enable-api.sh alpha beta   # only these profiles
#
# Each profile gets API_SERVER_ENABLED, a free port (starting at BASE_PORT, default 8643)
# and a random API_SERVER_KEY in its own .env. Settings a profile already has are kept,
# and the original .env is backed up once as .env.bak-hgw. Safe to re-run.
set -euo pipefail
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BASE_PORT="${BASE_PORT:-8643}"

if [[ $# -gt 0 ]]; then
  PROFILES=("$@")
else
  PROFILES=()
  for d in "$HERMES_HOME"/profiles/*/; do [[ -d "$d" ]] && PROFILES+=("$(basename "$d")"); done
fi
if [[ ${#PROFILES[@]} -eq 0 ]]; then
  echo "No profiles found in $HERMES_HOME/profiles. Create one with: hermes profile create <name>"; exit 1
fi

# ports already claimed by any profile (or the default profile)
used_ports() {
  grep -h '^API_SERVER_PORT=' "$HERMES_HOME"/.env "$HERMES_HOME"/profiles/*/.env 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' '
}
port_free() {
  ! used_ports | grep -qx "$1" && ! (command -v ss >/dev/null && ss -ltn | awk '{print $4}' | grep -qE "[:.]$1\$")
}
random_key() {
  if command -v openssl >/dev/null; then openssl rand -hex 24; else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

next_port=$BASE_PORT
for p in "${PROFILES[@]}"; do
  dir="$HERMES_HOME/profiles/$p"
  if [[ ! -d "$dir" ]]; then echo "skip $p: $dir does not exist"; continue; fi
  envf="$dir/.env"; touch "$envf"; chmod 600 "$envf"
  [[ -f "$envf.bak-hgw" ]] || cp -p "$envf" "$envf.bak-hgw"
  grep -q '^API_SERVER_ENABLED=' "$envf" || echo "API_SERVER_ENABLED=true" >> "$envf"
  if ! grep -q '^API_SERVER_PORT=' "$envf"; then
    while ! port_free "$next_port"; do next_port=$((next_port + 1)); done
    echo "API_SERVER_PORT=$next_port" >> "$envf"; next_port=$((next_port + 1))
  fi
  grep -q '^API_SERVER_KEY=' "$envf" || echo "API_SERVER_KEY=$(random_key)" >> "$envf"
  echo "  $p → port $(grep '^API_SERVER_PORT=' "$envf" | cut -d= -f2)"
done

echo
echo "Restart each profile's gateway so the API server starts:"
for p in "${PROFILES[@]}"; do
  if systemctl list-unit-files "hermes-gateway-$p.service" >/dev/null 2>&1 && systemctl cat "hermes-gateway-$p.service" >/dev/null 2>&1; then
    echo "  systemctl restart hermes-gateway-$p"
  else
    echo "  hermes -p $p gateway"
  fi
done
echo "Hermes Gateway reads the keys from each profile's .env, so there is nothing to copy."
