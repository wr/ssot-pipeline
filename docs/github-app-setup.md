# GitHub auth setup

Three pieces of auth needed:

1. **Claude → Anthropic** auth, used inside workflows. Easiest: an `ANTHROPIC_API_KEY` stored as a repo secret.
2. **Worker → GitHub** auth, used by the Cloudflare Worker to fire `repository_dispatch` events. For v0: a fine-grained PAT. For v1 (cleaner identity): a custom GitHub App named `claude`.
3. **Reviewer-bot → GitHub** auth, used by `pr-review.yml` to file APPROVE / REQUEST_CHANGES reviews. Needs to be a *different* App than the one that opens PRs (`claude[bot]`), because GitHub blocks PR authors from reviewing their own PRs. See section 4.

## 1. Anthropic auth (one secret per target repo)

**Recommended: Claude Max via `/install-github-app`** — uses your Max subscription, no per-token billing. From any Claude Code session in the target repo, type:

```
/install-github-app
```

Walks you through installing Anthropic's GitHub App and sets `CLAUDE_CODE_OAUTH_TOKEN` as a repo secret automatically. Trade-off: Max session/rate limits apply to autonomous runs.

**Alternative: API key** — no rate limits, but metered cost. Swap `claude_code_oauth_token` → `anthropic_api_key` in the workflows and set:
```bash
gh secret set ANTHROPIC_API_KEY --repo wr/<target-repo>
```

Note: Anthropic's GitHub App is separate from the custom `claude` App in section 3 below. Anthropic's App only handles Anthropic auth; it doesn't change which user appears as the commit author.

## 2. Worker → GitHub auth (v0: fine-grained PAT)

The Worker fires `repository_dispatch` events. Cheapest path: a fine-grained personal access token.

1. Go to https://github.com/settings/personal-access-tokens/new
2. Settings:
   - **Token name:** `ssot-pipeline-worker-dispatch`
   - **Expiration:** 1 year (set a calendar reminder to rotate)
   - **Repository access:** Only select repositories → pick every target repo you'll wire up
   - **Repository permissions:** Actions → **Read and write**, Contents → **Read** (for `repository_dispatch` to fire workflows)
3. Generate. Copy the token.
4. Save to the Worker:
   ```bash
   cd worker
   wrangler secret put GITHUB_DISPATCH_TOKEN
   # paste the token
   ```

## 3. Custom `claude` GitHub App (v1 — for native bot identity)

> **Status: not implemented in v0.** v0 commits/PRs appear as `github-actions[bot]`. This section describes the v1 path for true `claude[bot]` identity.

When you're ready to upgrade:

1. Create a new GitHub App at https://github.com/settings/apps/new
   - **Name:** `claude` (must be globally unique on GitHub — try `claude-wr` if taken)
   - **Homepage URL:** anything (e.g., your repo URL)
   - **Webhook:** uncheck "Active" (we don't use GitHub webhooks)
   - **Permissions** (Repository):
     - Actions: **Read and write**
     - Contents: **Read and write**
     - Issues: **Read and write**
     - Pull requests: **Read and write**
   - **Where can this be installed:** Only on this account
2. After creation: generate a private key, download the `.pem` file
3. Install the App on every target repo (from the App's "Install App" page)
4. Store as secrets on each target repo:
   ```bash
   gh secret set CLAUDE_BOT_APP_ID --repo wr/<target>
   gh secret set CLAUDE_BOT_APP_PRIVATE_KEY --repo wr/<target> < path/to/private-key.pem
   ```
5. Update `templates/ssot.yml` to forward these secrets, and update `linear-implement.yml` to mint a token via `actions/create-github-app-token@v1` and pass it to `claude-code-action` via `github_token:`. The Worker can also switch from PAT to App-installation tokens — same private key.

Track this upgrade as a follow-up Linear issue in the SSOT Pipeline project.

## 4. Reviewer GitHub App (`wr-claude-reviewer`)

**Why a second App?** `linear-implement.yml` opens PRs as `claude[bot]` (Anthropic's GitHub App). When `pr-review.yml` runs as the same identity, GitHub blocks any APPROVE or REQUEST_CHANGES action — "pull request authors can't approve their own pull request" — so claude can only ever leave neutral `COMMENTED` reviews. That also breaks the auto-fix loop (`pr-fix.yml` waits for a `CHANGES_REQUESTED` event that never arrives).

The fix is a second GitHub App, owned by you, used only for review. `pr-review.yml` mints an installation token from it via `actions/create-github-app-token@v1` and passes it as `github_token:` to `claude-code-action`. Reviews then appear as `wr-claude-reviewer[bot]` and APPROVE/REQUEST_CHANGES stick.

### Create the App (one-time)

1. https://github.com/settings/apps/new
   - **Name:** `wr-claude-reviewer` (must be globally unique; substitute your handle if taken)
   - **Homepage URL:** any
   - **Webhook → Active:** unchecked
   - **Repository permissions:**
     - Pull requests: **Read and write** (file reviews)
     - Contents: **Read** (`claude-code-action` reads the diff)
     - Issues: **Read and write** (post review-summary comments)
     - Metadata: **Read** (default)
   - **Where can this be installed:** Only on this account
2. Create → note the **App ID** → "Generate a private key" → save the `.pem` file.
3. Install the App on every target repo (App's "Install App" page).
4. Seed credentials into macOS Keychain so `bin/init-target-repo.sh` picks them up:
   ```bash
   security add-generic-password -U -s ssot-pipeline -a CLAUDE_REVIEWER_APP_ID -w '<app-id>'
   security add-generic-password -U -s ssot-pipeline -a CLAUDE_REVIEWER_APP_KEY \
     -w "$(cat /path/to/wr-claude-reviewer.*.private-key.pem)"
   ```
   The PEM is multi-line; Keychain stores the bytes and `load_secret` hex-decodes on read. To rotate, regenerate the key in the App settings and re-run the seed commands with `-U`.
5. For each target repo, re-run `./bin/init-target-repo.sh` (or set the two secrets directly with `gh secret set CLAUDE_REVIEWER_APP_ID --repo wr/<target>` and the same for the PEM).

### Updating the bot login

If you pick a different App name, also update `review_bot_login` and `fix_reviewer_logins[0]` in `config/pipeline.json`, and the `select(.user.login == "wr-claude-reviewer[bot]")` filters in `.github/workflows/pr-review.yml` (verify step) and `.github/workflows/pr-fix.yml` (cap counter). The login is the App slug with `[bot]` appended.
