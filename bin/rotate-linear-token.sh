#!/usr/bin/env bash
# Rotate LINEAR_APP_TOKEN across every place it has to live:
#   1. macOS Keychain (service=ssot-pipeline, account=LINEAR_APP_TOKEN) — local
#      fallback for bin/init-target-repo.sh.
#   2. GitHub Actions secret on this repo (the meta-repo) AND every target
#      repo in config/pipeline.json -> project_to_repo.
#   3. Cloudflare Worker secret (wrangler secret put).
#
# Verifies the token authenticates as the expected actor=app user *before*
# persisting anywhere. Idempotent — safe to re-run.
#
# Usage:
#   bin/rotate-linear-token.sh <new-token>
#   bin/rotate-linear-token.sh -                     # read from stdin
#   pbpaste | bin/rotate-linear-token.sh -
#   LINEAR_APP_TOKEN=<new-token> bin/rotate-linear-token.sh
#
# Get a new token: see docs/linear-app-setup.md (`bin/get-linear-token`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$REPO_ROOT/config/pipeline.json"

if [ ! -f "$CONFIG" ]; then
  echo "✗ $CONFIG not found — run from inside the ssot-pipeline checkout." >&2
  exit 1
fi

# --- Resolve new token from arg | stdin | env ------------------------------

NEW_TOKEN="${1:-${LINEAR_APP_TOKEN:-}}"
if [ "${NEW_TOKEN:-}" = "-" ]; then
  NEW_TOKEN="$(cat)"
fi
NEW_TOKEN="${NEW_TOKEN%%$'\n'}"   # strip trailing newline if pasted via heredoc

if [ -z "$NEW_TOKEN" ]; then
  cat >&2 <<EOF
Usage: $0 <new-token>
       $0 -                  (read from stdin)
       pbpaste | $0 -
       LINEAR_APP_TOKEN=<new-token> $0

Get a new token first via bin/get-linear-token (see docs/linear-app-setup.md).
EOF
  exit 1
fi

# --- Verify against Linear before persisting -------------------------------
# This is the load-bearing guard: a bad token rotated to all four sinks
# means re-doing the whole dance manually. Catch it here.

echo "→ Verifying token with Linear…"
RESP=$(curl -fsS -X POST https://api.linear.app/graphql \
  -H "Authorization: $NEW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name } }"}' 2>&1) || {
  echo "  ✗ Linear API call failed:" >&2
  echo "$RESP" >&2
  exit 1
}

VIEWER_NAME=$(echo "$RESP" | jq -r '.data.viewer.name // ""')
if [ -z "$VIEWER_NAME" ] || [ "$VIEWER_NAME" = "null" ]; then
  echo "  ✗ Token did not authenticate. Raw response:" >&2
  echo "$RESP" | jq . >&2
  exit 1
fi
echo "  ✓ Authenticates as: $VIEWER_NAME"

if [ "$VIEWER_NAME" != "claude" ]; then
  echo "  ⚠  Expected viewer.name=claude (actor=app); got '$VIEWER_NAME'." >&2
  echo "      This token may be a personal API key, not an actor=app token." >&2
  echo "      Continue anyway? (y/N) " >&2
  read -r ans
  case "$ans" in y|Y) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# --- Resolve target repos --------------------------------------------------
# Always include this repo (the meta-repo runs the reusable workflows on its
# own dogfooded ssot.yml too). config/pipeline.json's project_to_repo covers
# the rest; dedupe in case the meta-repo is also listed there.

META_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
if [ -z "$META_REPO" ]; then
  echo "✗ Couldn't detect meta-repo via 'gh repo view'. Run 'gh auth login'." >&2
  exit 1
fi

CONFIGURED_REPOS=$(jq -r '.project_to_repo | to_entries | map(.value) | unique | .[]' "$CONFIG")
REPOS=$(printf "%s\n%s\n" "$META_REPO" "$CONFIGURED_REPOS" | awk 'NF && !seen[$0]++')

echo ""
echo "Will update LINEAR_APP_TOKEN in:"
echo "  • macOS Keychain (service=ssot-pipeline)"
printf '  • GitHub secret on:\n'
echo "$REPOS" | sed 's/^/      - /'
echo "  • Cloudflare Worker (wrangler secret put)"
echo ""

# --- 1. macOS Keychain -----------------------------------------------------

if [ "$(uname)" = "Darwin" ] && command -v security >/dev/null 2>&1; then
  echo "→ Updating macOS Keychain…"
  security add-generic-password -U -s ssot-pipeline -a LINEAR_APP_TOKEN -w "$NEW_TOKEN"
  echo "  ✓ Keychain: ssot-pipeline / LINEAR_APP_TOKEN"
else
  echo "→ Skipping Keychain (not macOS or 'security' not available)"
fi

# --- 2. GitHub Actions secrets --------------------------------------------

echo "→ Setting GitHub Actions secret LINEAR_APP_TOKEN…"
for REPO in $REPOS; do
  if gh secret set LINEAR_APP_TOKEN --repo "$REPO" --body "$NEW_TOKEN" >/dev/null 2>&1; then
    echo "  ✓ $REPO"
  else
    echo "  ✗ $REPO — gh secret set failed (do you have admin access?)" >&2
    exit 1
  fi
done

# --- 3. Cloudflare Worker --------------------------------------------------

echo "→ Setting Cloudflare Worker secret (wrangler)…"
(
  cd "$REPO_ROOT/worker"
  echo "$NEW_TOKEN" | npx --yes wrangler secret put LINEAR_APP_TOKEN
)
echo "  ✓ Worker LINEAR_APP_TOKEN"

echo ""
echo "🎉 Done. Token rotated everywhere; authenticates as: $VIEWER_NAME"
