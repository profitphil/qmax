#!/usr/bin/env bash
# Signs the list of fingerprints (SHA256SUMS) that the site publishes next to the agent downloads, with the maintainer's own minisign key, so anyone holding the public key can check that the
# list (and so the MCP server and the SDK it lists) came from the key's owner and was not changed, even if the web server itself were tampered with.
#
# One-time setup, on your own computer (the secret key must never be on the server):
#   brew install minisign
#   minisign -G            # makes ~/.minisign/minisign.key (asks for a password) and minisign.pub; keep the secret key and its password safe
#   publish the public key (one line starting "RW") somewhere that is not this website: the GitHub README, your profile
#
# Each release: run after `npm run agents:build` (deploy.sh does it when MINISIGN_KEY is set):
#   MINISIGN_KEY=~/.minisign/minisign.key ./scripts/sign-release.sh
set -euo pipefail
KEY="${MINISIGN_KEY:?Set MINISIGN_KEY to the path of your minisign secret key, e.g. MINISIGN_KEY=~/.minisign/minisign.key}"
command -v minisign >/dev/null || { echo "minisign is not installed (brew install minisign)." >&2; exit 1; }
cd "$(dirname "$0")/.."
SUMS=web/public/agents/SHA256SUMS
[ -s "$SUMS" ] || { echo "$SUMS is missing: run npm run agents:build first." >&2; exit 1; }
minisign -S -s "$KEY" -m "$SUMS" -x "$SUMS.minisig" -t "QMax agent downloads, $(date -u +%Y-%m-%d)"
echo "Signed: $SUMS.minisig. Anyone can check it with:  minisign -V -P <your public key> -m SHA256SUMS -x SHA256SUMS.minisig"
