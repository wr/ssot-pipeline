# Security runbook

This document is the source of truth for **who can act as whom** in the loop
and **how to rotate the long-lived credentials** that grant those identities.
If a token leaks, jump straight to [Incident response](#incident-response).

## Identities

The loop touches three external systems (Linear, GitHub, Cloudflare). Every
write to those systems happens under one of four identities:

| Identity                       | Where it acts                            | Backing credential                                  | What it can do                                                                 |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@claude` (Linear OAuth app)   | Linear (comments, reactions, state, attachments) | `LINEAR_APP_TOKEN` (OAuth token with `actor=app`)   | Read/write any issue + comment in the workspace this app is installed in       |
| `claude[bot]` (GitHub App)     | GitHub (commits, PRs, comments on target repos) | Installed via `claude-code-action`'s `/install-github-app` — token minted per-run via OIDC | Push to branches, open/update PRs in target repos                              |
| `<your-handle>-claude-reviewer[bot]` (GitHub App) | GitHub (PR reviews — APPROVE / REQUEST_CHANGES) | `CLAUDE_REVIEWER_APP_ID` + `CLAUDE_REVIEWER_APP_KEY` (private key PEM) on each target repo | File reviews on PRs in installed repos (must be a separate App because GitHub blocks PR authors from approving their own PRs) |
| `claude-dispatch` (GitHub PAT) | GitHub (`repository_dispatch` from Worker → target repos) | `GITHUB_DISPATCH_TOKEN` (fine-grained PAT) in Cloudflare Worker | Fire workflows in selected target repos (Actions: write, Contents: read)       |
| `@wells` (human)               | GitHub (the sign-off gate) + Linear (optional in-session approval) | Personal account — not a shared credential          | Sole sign-off is the **GitHub PR merge** under `main` branch protection (PR + 1 approving review required, no force-push/deletion); nothing auto-merges and fork PRs don't receive the reviewer-App secrets. The in-session reply-approval is an *optional* gate, off by default (`enforce_approved_users: false`) — when enabled, the Worker checks the session creator against `approved_user_ids` in `config/pipeline.json` |

The Worker itself runs on Cloudflare Workers and authenticates to Linear by
verifying inbound webhook HMACs (`LINEAR_WEBHOOK_SECRET`) and to GitHub by
sending the dispatch PAT. It holds no Linear user identity of its own.

## Secrets inventory

Five long-lived secrets keep the loop running. Each is stored in exactly one
place; nothing is duplicated.

| Secret                       | Stored in                              | Used by                          | Grants                                                            |
| ---------------------------- | -------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `LINEAR_WEBHOOK_SECRET`      | Cloudflare Worker (`wrangler secret`)  | Worker (HMAC verification of inbound webhooks) | Ability to forge a webhook delivery that the Worker treats as authentic |
| `LINEAR_APP_TOKEN`           | Cloudflare Worker (`wrangler secret`) **and** every target repo (`gh secret set`) | Worker + every reusable workflow that talks to Linear | Full read/write on the Linear workspace as `@claude`              |
| `GITHUB_DISPATCH_TOKEN`      | Cloudflare Worker (`wrangler secret`)  | Worker (`repository_dispatch` API) | Trigger workflows + read contents on every selected target repo  |
| `CLAUDE_CODE_OAUTH_TOKEN`    | Each target repo (`gh secret set`)     | `claude-code-action` inside reusable workflows | Anthropic API usage on the maintainer's Claude Max account        |
| `CLAUDE_REVIEWER_APP_ID` + `CLAUDE_REVIEWER_APP_KEY` | Each target repo (`gh secret set`) | `pr-review.yml` (mints installation token) | File APPROVE / REQUEST_CHANGES reviews as `<your-handle>-claude-reviewer[bot]` |
| `CLOUDFLARE_API_TOKEN`       | This repo (`gh secret set`, repo `wr/ssot-pipeline`) | `deploy-worker.yml`              | Deploy the Worker on merge to `main`                              |

`config/pipeline.json` is **not** a secret — it holds non-sensitive
identifiers (approved user IDs, state names, project→repo mapping). The
Worker serves it publicly at `GET /config`.

## Rotation procedure

**Default cadence: every 90 days.** Calendar reminder in the maintainer's
personal calendar; rotation is also part of the [incident response](#incident-response).

The rotation pattern for every secret is the same: mint a new credential
first, write it everywhere it's stored, then revoke the old one. Do **not**
revoke first — that creates a window where the loop is broken.

### `LINEAR_APP_TOKEN` (Linear OAuth app)

Stored in: Cloudflare Worker + every target repo.

```bash
# 1. Mint a fresh actor=app token (interactive — opens browser).
./bin/get-linear-token
# Copy the printed token; the helper verifies viewer.name == "claude" before printing.

# 2. Update the Worker secret.
cd worker && wrangler secret put LINEAR_APP_TOKEN
# Paste the new token at the prompt.

# 3. Update every target repo secret. Loop over project_to_repo:
jq -r '.project_to_repo | to_entries[] | .value' config/pipeline.json | \
  while read repo; do
    echo "$NEW_TOKEN" | gh secret set LINEAR_APP_TOKEN --repo "$repo"
  done

# 4. Revoke the old token: Linear → Settings → API → OAuth Applications →
#    `claude` → revoke the previous authorization grant.
```

### `GITHUB_DISPATCH_TOKEN` (fine-grained PAT)

Stored in: Cloudflare Worker only.

```bash
# 1. Mint a new fine-grained PAT at
#    https://github.com/settings/personal-access-tokens/new
#    Settings to copy from the previous token:
#      - Repository access: Only select repositories → all current target repos
#      - Repository permissions: Actions = Read and write, Contents = Read
#      - Expiration: 90 days

# 2. Push it to the Worker.
cd worker && wrangler secret put GITHUB_DISPATCH_TOKEN

# 3. Revoke the previous token at
#    https://github.com/settings/personal-access-tokens (find the old one, delete).
```

### `LINEAR_WEBHOOK_SECRET` (HMAC signing key)

Stored in: Cloudflare Worker only. Rotated by Linear's webhook UI.

```bash
# 1. In Linear → Settings → API → Webhooks → your webhook → "Regenerate signing secret".
#    Copy the new value immediately (it's only shown once).

# 2. Push it to the Worker BEFORE confirming the rotation in Linear's UI —
#    otherwise inbound deliveries will fail HMAC verification.
cd worker && wrangler secret put LINEAR_WEBHOOK_SECRET

# 3. In Linear's webhook UI, hit "Resend" on the most recent delivery and
#    confirm `wrangler tail` shows a 200 with `trace=...`.
```

### `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic Claude Max)

Stored in: every target repo.

```bash
# 1. From any Claude Code session in the target repo:
/install-github-app
# This re-runs the OAuth flow and overwrites the repo secret automatically.

# 2. Repeat for every target repo (per `config/pipeline.json` → project_to_repo).

# 3. Revoke previous tokens at https://console.anthropic.com (Settings → OAuth tokens).
```

### `CLAUDE_REVIEWER_APP_ID` + `CLAUDE_REVIEWER_APP_KEY` (reviewer GitHub App)

Stored in: every target repo.

`CLAUDE_REVIEWER_APP_ID` is not a secret in the strict sense (it's the App
ID, visible to anyone with the App installed) but it's stored alongside the
key for convenience. The thing that grants power is the **private key**.

```bash
# 1. GitHub → Settings → Developer settings → GitHub Apps →
#    <your-handle>-claude-reviewer → Private keys → Generate a private key.
#    Downloads a fresh .pem. Keep the old one for now.

# 2. Update the macOS Keychain seed (init-target-repo.sh reads from here):
security add-generic-password -U -s ssot-pipeline -a CLAUDE_REVIEWER_APP_KEY \
  -w "$(cat /path/to/<your-handle>-claude-reviewer.NEW.private-key.pem)"

# 3. Push the new key to every target repo:
jq -r '.project_to_repo | to_entries[] | .value' config/pipeline.json | \
  while read repo; do
    gh secret set CLAUDE_REVIEWER_APP_KEY --repo "$repo" \
      < /path/to/<your-handle>-claude-reviewer.NEW.private-key.pem
  done

# 4. Delete the OLD key in the GitHub App settings.
```

### `CLOUDFLARE_API_TOKEN`

Stored in: this repo (`wr/ssot-pipeline`) only. Drives `deploy-worker.yml`.

```bash
# 1. Cloudflare dashboard → My Profile → API Tokens → Create Token →
#    "Edit Cloudflare Workers" template, scoped to the ssot-pipeline Worker.
#    Expiration: 90 days.

# 2. Push it to this repo:
gh secret set CLOUDFLARE_API_TOKEN --repo wr/ssot-pipeline

# 3. Revoke the previous token in the Cloudflare dashboard.

# 4. Sanity check: trigger a no-op deploy.
gh workflow run deploy-worker.yml --repo wr/ssot-pipeline
```

## Incident response

If you suspect a secret has leaked (committed to a repo, posted in a
comment, exfiltrated, etc.):

1. **Revoke first.** Speed beats cleanliness. For each compromised secret:
   - `LINEAR_APP_TOKEN`: Linear → Settings → API → OAuth Applications → `claude` → revoke.
   - `GITHUB_DISPATCH_TOKEN`: https://github.com/settings/personal-access-tokens → delete the token.
   - `LINEAR_WEBHOOK_SECRET`: Linear webhook UI → Regenerate signing secret.
   - `CLAUDE_CODE_OAUTH_TOKEN`: https://console.anthropic.com → Settings → OAuth tokens → revoke.
   - `CLAUDE_REVIEWER_APP_KEY`: App settings → Private keys → delete the leaked one.
   - `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → API Tokens → roll/revoke.
2. **Rotate.** Follow the per-secret procedure above to mint and install
   replacements. The loop is broken until step 2 completes for the affected
   secret — that's the price of revoking first.
3. **Audit.** Look for unexpected activity during the window the credential
   was exposed:
   - **Worker logs:** `cd worker && wrangler tail --format=pretty --since=24h` —
     grep for unexpected trace IDs, repo dispatches, or webhooks from unknown
     source IPs.
   - **GitHub Actions runs:** `gh run list --repo <target> --limit 100` and
     inspect runs you didn't initiate; pay attention to `repository_dispatch`
     events firing with unfamiliar `client_payload.trace_id`s.
   - **Linear activity:** check the audit log (workspace Settings → Security
     → Audit log) for OAuth-app actions outside the normal loop pattern
     (e.g., comments on issues the loop should never have touched).
   - **Cloudflare:** check Worker invocation graphs in the dashboard for
     volume spikes during the exposure window.
4. **Document.** Write a brief incident note in this repo
   (`docs/incidents/YYYY-MM-DD-short-slug.md`) capturing: what leaked, how
   it leaked, what was rotated, what the audit showed. Even a one-paragraph
   note compounds; "we rotated everything and nothing weird showed up" is a
   useful artifact.

## Operator checklist

- [ ] Branch protection on `main` is the sole sign-off gate: PR required + at
      least 1 approving review, no force-push, no deletion. Nothing auto-merges,
      so the human merge is what ships work.
- [ ] Every 90 days: rotate all six secrets above.
- [ ] After every personnel change (new collaborator, departure): re-audit
      `approved_user_ids` in `config/pipeline.json` (only enforced when
      `enforce_approved_users: true` — off by default).
- [ ] Never paste a secret into a Linear comment or PR description — the
      loop echoes both back to Claude as context.
