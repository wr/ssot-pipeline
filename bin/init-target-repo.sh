#!/usr/bin/env bash
# Wire a target repo into ssot-pipeline.
#
# Usage:
#   ./bin/init-target-repo.sh <repo-path> <linear-project-id>
#
# What it does:
#   1. Copies templates/ssot.yml into <repo>/.github/workflows/ssot.yml
#   2. Adds a `## Source of truth` block to <repo>/CLAUDE.md (creates it if missing)
#   3. Sets repo secrets ANTHROPIC_API_KEY + LINEAR_APP_TOKEN (reads from env or prompts)
#   4. Prints the mapping line to add to the Worker's LINEAR_PROJECT_TO_REPO
#
# Prerequisites:
#   - gh CLI authenticated
#   - jq installed
#   - ANTHROPIC_API_KEY and LINEAR_APP_TOKEN exported (or you'll be prompted)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -ne 2 ]; then
  echo "Usage: $0 <repo-path> <linear-project-id>" >&2
  exit 1
fi

TARGET_REPO_PATH="$1"
LINEAR_PROJECT_ID="$2"

if [ ! -d "$TARGET_REPO_PATH" ]; then
  echo "Error: $TARGET_REPO_PATH is not a directory" >&2
  exit 1
fi

cd "$TARGET_REPO_PATH"

# --- Resolve target repo owner/name ---
if ! REPO_FULL=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null); then
  echo "Error: $TARGET_REPO_PATH is not a GitHub-tracked repo (or gh isn't authed)" >&2
  exit 1
fi
echo "→ Target repo: $REPO_FULL"

# --- Resolve Linear project name ---
LINEAR_QUERY=$(cat <<EOF
{"query":"query(\$id: String!) { project(id: \$id) { id name } }","variables":{"id":"$LINEAR_PROJECT_ID"}}
EOF
)
if [ -z "${LINEAR_APP_TOKEN:-}" ]; then
  echo -n "LINEAR_APP_TOKEN (for validation): "
  read -rs LINEAR_APP_TOKEN
  echo
fi
PROJECT_NAME=$(curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$LINEAR_QUERY" | jq -r '.data.project.name // empty')

if [ -z "$PROJECT_NAME" ]; then
  echo "Error: could not resolve Linear project $LINEAR_PROJECT_ID" >&2
  exit 1
fi
echo "→ Linear project: $PROJECT_NAME ($LINEAR_PROJECT_ID)"

# --- Install stub workflow ---
mkdir -p .github/workflows
cp "$REPO_ROOT/templates/ssot.yml" .github/workflows/ssot.yml
echo "→ Installed .github/workflows/ssot.yml"

# --- Update CLAUDE.md ---
SSOT_BLOCK=$(cat <<EOF

## Source of truth
- GitHub: github.com/$REPO_FULL
- Linear project: $PROJECT_NAME (id: $LINEAR_PROJECT_ID, team: Personal)
- Branch prefix: wells/
- PR mode: ready
EOF
)

if [ ! -f CLAUDE.md ]; then
  cat > CLAUDE.md <<EOF
# $(basename "$REPO_FULL")
$SSOT_BLOCK
EOF
  echo "→ Created CLAUDE.md"
elif ! grep -q "^## Source of truth" CLAUDE.md; then
  printf "%s\n" "$SSOT_BLOCK" >> CLAUDE.md
  echo "→ Appended Source of truth block to CLAUDE.md"
else
  echo "→ CLAUDE.md already has Source of truth block (leaving as-is — edit by hand if needed)"
fi

# --- Set repo secrets ---
set_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    echo -n "$name: "
    read -rs value
    echo
  fi
  if [ -z "$value" ]; then
    echo "  (skipped — empty value)"
    return
  fi
  printf "%s" "$value" | gh secret set "$name" --repo "$REPO_FULL"
  echo "→ Set secret $name on $REPO_FULL"
}

set_secret ANTHROPIC_API_KEY
set_secret LINEAR_APP_TOKEN

# --- Print Worker update instructions ---
cat <<EOF

✅ Target repo $REPO_FULL is wired up.

Next steps (manual, one-time per project):

1. Add this mapping to the Worker's LINEAR_PROJECT_TO_REPO secret:

   "$LINEAR_PROJECT_ID": "$REPO_FULL"

   To update:
     cd $REPO_ROOT/worker
     wrangler secret put LINEAR_PROJECT_TO_REPO
     # paste the full updated JSON when prompted

2. In Linear, scope the OAuth app webhook to include this project (Settings → API → OAuth Applications → claude → Webhooks).

3. Commit and push the new workflow stub + CLAUDE.md changes in $TARGET_REPO_PATH.

4. Test by creating a Linear issue in "$PROJECT_NAME" and moving it to Todo (AI).
EOF
