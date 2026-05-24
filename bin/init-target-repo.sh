#!/usr/bin/env bash
# Wire a target repo into ssot-pipeline.
#
# Usage:
#   ./bin/init-target-repo.sh <repo-path> <linear-project-id>
#
# What it does (fully automatic — pushes direct to main on both sides):
#   1. Pre-flight: both repos must be on their default branch with clean
#      working trees and in sync with origin. Aborts otherwise.
#   2. Installs templates/ssot.yml into <repo>/.github/workflows/ssot.yml
#   3. Adds a `## Source of truth` block to <repo>/CLAUDE.md (creates if missing)
#   4. Sets repo secrets CLAUDE_CODE_OAUTH_TOKEN + LINEAR_APP_TOKEN
#   5. Commits + pushes the target repo's stub + CLAUDE.md changes
#   6. Adds the project_to_repo mapping in this repo's config/pipeline.json,
#      commits, and pushes to main (which triggers deploy-worker to redeploy
#      the Worker automatically)
#
# Re-runs are idempotent: each step skips itself if its effect is already
# in place.
#
# Prerequisites:
#   - gh CLI authenticated
#   - jq installed
#   - CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and LINEAR_APP_TOKEN
#     exported (or you'll be prompted)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -ne 2 ]; then
  echo "Usage: $0 <repo-path> <linear-project-id>" >&2
  exit 1
fi

TARGET_REPO_PATH="$(cd "$1" && pwd)"
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
TARGET_DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
echo "→ Target repo: $REPO_FULL (default branch: $TARGET_DEFAULT_BRANCH)"

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
  echo "Error: could not resolve Linear project $LINEAR_PROJECT_ID — check the UUID and your token" >&2
  exit 1
fi
echo "→ Linear project: $PROJECT_NAME ($LINEAR_PROJECT_ID)"

# --- Pre-flight: target repo must be clean and on default branch ---
TARGET_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$TARGET_BRANCH" != "$TARGET_DEFAULT_BRANCH" ]; then
  echo "Error: $TARGET_REPO_PATH is on '$TARGET_BRANCH', expected '$TARGET_DEFAULT_BRANCH'. Switch first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain .github/workflows/ssot.yml CLAUDE.md 2>/dev/null)" ]; then
  echo "Error: $TARGET_REPO_PATH has uncommitted changes to .github/workflows/ssot.yml or CLAUDE.md. Commit or stash first." >&2
  exit 1
fi
git fetch origin "$TARGET_DEFAULT_BRANCH" --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$TARGET_DEFAULT_BRANCH")" ]; then
  echo "Error: $TARGET_REPO_PATH is not in sync with origin/$TARGET_DEFAULT_BRANCH. Pull first." >&2
  exit 1
fi

# --- Pre-flight: ssot-pipeline repo must be clean and on main ---
(
  cd "$REPO_ROOT"
  SSOT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [ "$SSOT_BRANCH" != "main" ]; then
    echo "Error: $REPO_ROOT is on '$SSOT_BRANCH', expected 'main'." >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain config/pipeline.json)" ]; then
    echo "Error: $REPO_ROOT has uncommitted changes to config/pipeline.json. Commit or stash first." >&2
    exit 1
  fi
  git fetch origin main --quiet
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "Error: $REPO_ROOT is not in sync with origin/main. Pull first." >&2
    exit 1
  fi
)

# --- Pre-flight: project_to_repo mapping must be absent or already correct ---
EXISTING_REPO=$(jq -r --arg id "$LINEAR_PROJECT_ID" '.project_to_repo[$id] // empty' "$REPO_ROOT/config/pipeline.json")
if [ -n "$EXISTING_REPO" ] && [ "$EXISTING_REPO" != "$REPO_FULL" ]; then
  echo "Error: $REPO_ROOT/config/pipeline.json already maps $LINEAR_PROJECT_ID → $EXISTING_REPO (you asked for $REPO_FULL)." >&2
  exit 1
fi

# --- Set repo secrets (idempotent; no commit involved) ---
set_secret() {
  local name="$1"
  if gh secret list --repo "$REPO_FULL" --json name --jq '.[].name' 2>/dev/null | grep -qx "$name"; then
    echo "→ Secret $name already set on $REPO_FULL (skipping — delete first to rotate)"
    return
  fi
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

set_secret CLAUDE_CODE_OAUTH_TOKEN
set_secret LINEAR_APP_TOKEN

# --- Install stub workflow in target repo ---
mkdir -p .github/workflows
cp "$REPO_ROOT/templates/ssot.yml" .github/workflows/ssot.yml
echo "→ Installed .github/workflows/ssot.yml"

# --- Update CLAUDE.md in target repo ---
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
  echo "→ CLAUDE.md already has Source of truth block (leaving as-is)"
fi

# --- Commit + push target repo (if there's anything to commit) ---
if [ -n "$(git status --porcelain .github/workflows/ssot.yml CLAUDE.md 2>/dev/null)" ]; then
  git add .github/workflows/ssot.yml CLAUDE.md
  git commit -m "Wire up ssot-pipeline loop

Adds .github/workflows/ssot.yml stub that consumes the three reusable
workflows (linear-pickup, linear-implement, pr-review) from wr/ssot-pipeline.
Adds Source of truth block to CLAUDE.md mapping this repo to Linear
project $PROJECT_NAME ($LINEAR_PROJECT_ID).

Generated by ssot-pipeline/bin/init-target-repo.sh."
  git push origin "$TARGET_DEFAULT_BRANCH"
  echo "→ Pushed ssot wire-up to $REPO_FULL ($TARGET_DEFAULT_BRANCH)"
else
  echo "→ Target repo already wired up — no commit needed"
fi

# --- Edit + push ssot-pipeline config (if mapping not already there) ---
if [ -z "$EXISTING_REPO" ]; then
  (
    cd "$REPO_ROOT"
    TMPFILE=$(mktemp)
    jq --indent 2 \
      --arg id "$LINEAR_PROJECT_ID" \
      --arg repo "$REPO_FULL" \
      '.project_to_repo[$id] = $repo' \
      config/pipeline.json > "$TMPFILE"
    mv "$TMPFILE" config/pipeline.json
    git add config/pipeline.json
    git commit -m "Add $REPO_FULL to project_to_repo

Maps Linear project $PROJECT_NAME ($LINEAR_PROJECT_ID) to $REPO_FULL so
the Worker dispatches Linear webhooks for issues in this project to the
right GitHub repo.

The deploy-worker Action will pick this up on push and redeploy the
Worker automatically.

Generated by bin/init-target-repo.sh."
    git push origin main
    echo "→ Pushed project_to_repo mapping to wr/ssot-pipeline (deploy-worker will auto-redeploy)"
  )
else
  echo "→ project_to_repo mapping already present in $REPO_ROOT/config/pipeline.json — no commit needed"
fi

# --- Summary ---
cat <<EOF

✅ $REPO_FULL is wired into the ssot-pipeline loop.

Done:
  • Installed .github/workflows/ssot.yml in $REPO_FULL
  • Added Source of truth block to $REPO_FULL/CLAUDE.md
  • Set repo secrets: CLAUDE_CODE_OAUTH_TOKEN, LINEAR_APP_TOKEN
  • Pushed to $REPO_FULL ($TARGET_DEFAULT_BRANCH)
  • Pushed project_to_repo mapping to wr/ssot-pipeline (main) — deploy-worker is redeploying now

Heads up:
  • Confirm the workspace-level Linear webhook (Settings → API → Webhooks)
    covers this project. Default scope is the whole workspace, so this
    usually just works.

Test it: create a Linear issue in "$PROJECT_NAME" and move it to Todo (AI).
Watch the trace ID propagate through: \`wrangler tail\`, the resulting
\`gh run view --log\` on $REPO_FULL, and the plan comment that appears in Linear.
EOF
