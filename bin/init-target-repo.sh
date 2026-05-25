#!/usr/bin/env bash
# Wire a target repo into ssot-pipeline.
#
# Usage:
#   ./bin/init-target-repo.sh <repo-path> <linear-project-url-or-id>
#
# <linear-project-url-or-id> accepts any of:
#   - Full URL: https://linear.app/<workspace>/project/<slug>[/<tab>]
#   - URL slug: <slug>  (e.g. ssot-pipeline-ded011dc9648)
#   - UUID:     <uuid>  (e.g. f9eb7447-31fb-4e02-b46b-7d147f2d0f55)
#
# What it does (fully automatic — pushes direct to main on both sides):
#   1. If <repo-path> isn't a git repo or has no GitHub remote, offers to
#      `git init` + commit current contents + `gh repo create` (private by
#      default) so a fresh dir can be wired up in one shot.
#   2. Pre-flight: both repos must be on their default branch with clean
#      working trees and in sync with origin. Aborts otherwise.
#   3. Installs templates/ssot.yml into <repo>/.github/workflows/ssot.yml
#   4. Adds a `## Source of truth` block to <repo>/CLAUDE.md (creates if missing)
#   5. Sets repo secrets CLAUDE_CODE_OAUTH_TOKEN + LINEAR_APP_TOKEN +
#      CLAUDE_REVIEWER_APP_ID + CLAUDE_REVIEWER_APP_KEY
#   6. Commits + pushes the target repo's stub + CLAUDE.md changes
#   7. Adds the project_to_repo mapping in this repo's config/pipeline.json,
#      commits, and pushes to main (which triggers deploy-worker to redeploy
#      the Worker automatically)
#
# Re-runs are idempotent: each step skips itself if its effect is already
# in place.
#
# Prerequisites:
#   - gh CLI authenticated
#   - jq installed
#   - CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), LINEAR_APP_TOKEN,
#     CLAUDE_REVIEWER_APP_ID, and CLAUDE_REVIEWER_APP_KEY available via env,
#     macOS Keychain, or interactive prompt.
#     Keychain seed (one-time, recommended):
#       security add-generic-password -s ssot-pipeline -a LINEAR_APP_TOKEN -w '<token>'
#       security add-generic-password -s ssot-pipeline -a CLAUDE_CODE_OAUTH_TOKEN -w '<token>'
#       security add-generic-password -s ssot-pipeline -a CLAUDE_REVIEWER_APP_ID -w '<app-id>'
#       security add-generic-password -s ssot-pipeline -a CLAUDE_REVIEWER_APP_KEY \
#         -w "$(cat /path/to/wr-claude-reviewer.private-key.pem)"
#     (Add `-U` to overwrite an existing entry.)
#   - The `wr-claude-reviewer` GitHub App must be installed on the target repo
#     before the first pr-review run. See docs/github-app-setup.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# load_secret <NAME>
# Resolve a credential by name in order: env var → macOS Keychain → prompt.
# Keychain entries live under service "ssot-pipeline", account = $NAME.
# Seed once: security add-generic-password -s ssot-pipeline -a $NAME -w '<token>'
# (use -U to overwrite an existing entry). Multi-line secrets (e.g. PEM keys)
# also work; pipe through:
#   security add-generic-password -U -s ssot-pipeline -a $NAME \
#     -w "$(cat /path/to/key.pem)"
# `security -w` returns multi-line/binary values as a hex string with no
# separator; we detect that and decode below so callers always get raw bytes.
load_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ] && command -v security >/dev/null 2>&1; then
    value=$(security find-generic-password -w -s ssot-pipeline -a "$name" 2>/dev/null || true)
    [ -n "$value" ] && echo "→ Loaded $name from Keychain" >&2
    # Pure-hex, even-length output is `security`'s rendering of a value
    # containing non-printable bytes (e.g. newlines in a PEM). Decode it.
    # Single-line ASCII passwords never trigger this branch.
    if [ -n "$value" ] && [[ "$value" =~ ^[0-9a-f]+$ ]] && [ $((${#value} % 2)) -eq 0 ] && [ "${#value}" -gt 32 ]; then
      local decoded
      decoded=$(printf '%s' "$value" | xxd -r -p 2>/dev/null || true)
      # Only swap if decoded contains a newline — pure-hex *real* passwords
      # (sha256 hex strings, etc.) would decode to gibberish without one.
      if [ -n "$decoded" ] && [[ "$decoded" == *$'\n'* ]]; then
        value="$decoded"
      fi
    fi
  fi
  if [ -z "$value" ]; then
    echo -n "$name: " >&2
    read -rs value
    echo >&2
  fi
  printf "%s" "$value"
}

if [ $# -ne 2 ]; then
  cat >&2 <<EOF
Usage: $0 <repo-path> <linear-project-url-or-id>

<linear-project-url-or-id> accepts:
  - Full URL: https://linear.app/<ws>/project/<slug>
  - URL slug: <slug>  (e.g. ssot-pipeline-ded011dc9648)
  - UUID:     <uuid>
EOF
  exit 1
fi

TARGET_REPO_PATH="$(cd "$1" && pwd)"
LINEAR_PROJECT_INPUT="$2"

if [ ! -d "$TARGET_REPO_PATH" ]; then
  echo "Error: $TARGET_REPO_PATH is not a directory" >&2
  exit 1
fi

cd "$TARGET_REPO_PATH"

# --- Ensure target is a git repo with a GitHub remote ---
# If the dir is fresh (no git, or git but no GitHub remote), offer to
# `git init` + commit current contents + `gh repo create --push`. This is
# the common "mkdir, drop in some code, wire up the loop" bootstrap path.
ensure_github_repo() {
  if gh repo view --json nameWithOwner >/dev/null 2>&1; then
    return 0  # Already a github-tracked repo
  fi

  local is_git=0
  if git rev-parse --git-dir >/dev/null 2>&1; then
    is_git=1
  fi

  echo
  if [ "$is_git" = "0" ]; then
    echo "$TARGET_REPO_PATH is not a git repository."
  else
    echo "$TARGET_REPO_PATH is a git repo but has no GitHub remote (or gh can't see it)."
  fi
  echo "Create a GitHub repo and push?"
  echo "  [1] Private  (recommended)"
  echo "  [2] Public"
  echo "  [3] Abort"
  echo -n "Choice [1]: "
  read -r choice
  local vis_flag
  case "${choice:-1}" in
    1|"") vis_flag="--private" ;;
    2)    vis_flag="--public"  ;;
    *)    echo "Aborted." >&2; exit 1 ;;
  esac

  local repo_name owner
  repo_name=$(basename "$TARGET_REPO_PATH")
  owner=$(gh api user --jq '.login')

  if [ "$is_git" = "0" ]; then
    git init -b main >/dev/null
    echo "→ git init (branch: main)"
  fi

  # First commit if none exists yet. Commit whatever's in the dir; if empty,
  # seed a minimal README so there's something to push.
  if ! git rev-parse HEAD >/dev/null 2>&1; then
    if [ -z "$(ls -A . 2>/dev/null | grep -v '^\.git$' || true)" ]; then
      printf "# %s\n" "$repo_name" > README.md
      echo "→ Seeded README.md (dir was empty)"
    fi
    git add -A
    git commit -m "Initial commit" >/dev/null
    echo "→ Initial commit ($(git rev-list --count HEAD) file(s))"
  fi

  # gh repo create handles remote wiring + push.
  gh repo create "$owner/$repo_name" "$vis_flag" --source=. --remote=origin --push
  echo "→ Created $owner/$repo_name ($vis_flag) and pushed"
}
ensure_github_repo

# --- Resolve target repo owner/name ---
if ! REPO_FULL=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null); then
  echo "Error: $TARGET_REPO_PATH is still not a GitHub-tracked repo after init step" >&2
  exit 1
fi
TARGET_DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
echo "→ Target repo: $REPO_FULL (default branch: $TARGET_DEFAULT_BRANCH)"

# --- Resolve Linear project from input (UUID, slug, or URL) ---
# Strip URL chrome / trailing path/query/fragment to get a clean lookup token.
LINEAR_LOOKUP=$(echo "$LINEAR_PROJECT_INPUT" | sed -E 's|[?#].*$||')
if [[ "$LINEAR_LOOKUP" =~ ^https?:// ]]; then
  LINEAR_LOOKUP=$(echo "$LINEAR_LOOKUP" | sed -E 's|^https?://linear\.app/[^/]+/project/||; s|/.*$||')
fi

LINEAR_APP_TOKEN=$(load_secret LINEAR_APP_TOKEN)

# Fetch all projects and match by UUID or URL-slug. Personal-team scale fits
# in a single 250-cap page; add pagination later if that ever changes.
PROJECTS_RESP=$(curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{projects(first:250){nodes{id name url}}}"}')

if [ "$(echo "$PROJECTS_RESP" | jq 'has("errors")')" = "true" ]; then
  echo "Error: Linear API returned errors:" >&2
  echo "$PROJECTS_RESP" | jq '.errors' >&2
  exit 1
fi

MATCH=$(echo "$PROJECTS_RESP" | jq -c --arg q "$LINEAR_LOOKUP" \
  '[.data.projects.nodes[] | select(.id == $q or (.url | endswith("/project/" + $q)))][0] // null')
LINEAR_PROJECT_ID=$(echo "$MATCH" | jq -r '.id // empty')
PROJECT_NAME=$(echo "$MATCH" | jq -r '.name // empty')

if [ -z "$LINEAR_PROJECT_ID" ] || [ -z "$PROJECT_NAME" ]; then
  echo "Error: could not resolve Linear project from '$LINEAR_PROJECT_INPUT'" >&2
  echo "       Parsed lookup token: '$LINEAR_LOOKUP'" >&2
  echo "       Accepts UUID, URL slug, or full URL. Verify input + LINEAR_APP_TOKEN scope." >&2
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
  local value
  value=$(load_secret "$name")
  if [ -z "$value" ]; then
    echo "  (skipped — empty value)"
    return
  fi
  printf "%s" "$value" | gh secret set "$name" --repo "$REPO_FULL"
  echo "→ Set secret $name on $REPO_FULL"
}

set_secret CLAUDE_CODE_OAUTH_TOKEN
set_secret LINEAR_APP_TOKEN
set_secret CLAUDE_REVIEWER_APP_ID
set_secret CLAUDE_REVIEWER_APP_KEY

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

Adds .github/workflows/ssot.yml stub that consumes the four reusable
workflows (linear-pickup, linear-implement, linear-replan, pr-review)
from wr/ssot-pipeline. Adds Source of truth block to CLAUDE.md mapping
this repo to Linear project $PROJECT_NAME ($LINEAR_PROJECT_ID).

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
  • Set repo secrets: CLAUDE_CODE_OAUTH_TOKEN, LINEAR_APP_TOKEN, CLAUDE_REVIEWER_APP_ID, CLAUDE_REVIEWER_APP_KEY
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
