# Quickstart

Fork → running loop in ~5 minutes. One guided command per phase, idempotent so partial runs resume cleanly.

If you'd rather see every step explicitly (or you're debugging a stuck install), the long-form walkthrough is in [`docs/fork-setup.md`](./fork-setup.md). The wizard below covers the same ground.

## 1. Fork and clone

```bash
gh repo fork wr/ssot-pipeline --clone --remote
cd ssot-pipeline
```

## 2. Run the wizard

```bash
./bin/setup
```

What it does, in order:

1. **Prereqs check** — `gh`, `jq`, `node`, `python3`, `git`. Bails with install hints if anything's missing.
2. **Detect your fork** — uses `gh repo view` to read your fork's `owner/name`.
3. **Configure `config/pipeline.json`** — interactively sets `branch_prefix`, `review_bot_login`, `fix_reviewer_logins`, and clears `project_to_repo` (it gets populated per-project by `bin/init-target-repo.sh`).
4. **Configure `worker/wrangler.toml`** — sets the Worker `name`, which becomes its public subdomain.
5. **Deploy the Worker** — runs `npx wrangler deploy` from `worker/`, captures the live URL, stores it in your macOS Keychain under `SSOT_WORKER_URL`.
6. **Create the reviewer GitHub App** — uses the [GitHub App Manifest API](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) to create the App in one redirect (no manual permissions UI). Captures App ID + PEM into Keychain. Prompts you to install it on the target repos that need it.
7. **Linear OAuth token** — prompts you to run `bin/get-linear-token` in a side terminal (it opens its own browser callback) and paste the result. Verifies the token authenticates as `@claude` (actor=app).
8. **Worker secrets** — pushes `LINEAR_APP_TOKEN`, `GITHUB_DISPATCH_TOKEN`, `LINEAR_WEBHOOK_SECRET` to the Worker via `wrangler secret put`.
9. **GitHub Actions config on your fork** — sets `SSOT_WORKER_URL` as a repo variable.
10. **First target repo** — optional: invokes `./bin/init-target-repo.sh` for the first project you want to wire up.

### Secrets never land in repo files

The wizard writes secrets only to three places: macOS Keychain (local reuse), Worker secrets via `wrangler secret put`, and GitHub Actions secrets via `gh secret set`. The git tree is never touched with token material.

### Re-running is safe

Every phase checks for the "already done" signal first — existing Keychain entries, an already-deployed Worker URL that responds to `/config`, a `pipeline.json` that's already been customized. Phases that are done print `✓ already done` and move on, so you can re-run after fixing any phase that errored.

### Skipping phases

- `--skip-worker` — don't deploy the Worker or push Worker secrets (use when you don't have a Cloudflare account configured yet)
- `--skip-apps` — don't create the reviewer App (use when you want to set it up manually via the GitHub UI)

## 3. Confirm the install

```bash
./bin/doctor
```

Runs every check the loop relies on: prereqs, Keychain entries, Linear token authentication, Worker reachability (`/config` returns a config blob), GitHub Actions variable + secrets on the fork and on each configured target repo. Colour-coded pass/fail summary; exits non-zero if anything's broken so you can chain it into CI or pre-commit.

Common doctor failures and the one-line fix each one suggests:

- `LINEAR_APP_TOKEN didn't authenticate` → `bin/get-linear-token`
- `/config unreachable` → `cd worker && npx wrangler deploy`
- `SSOT_WORKER_URL variable missing on <repo>` → `gh variable set SSOT_WORKER_URL --repo <repo> --body '<url>/config'`
- `<repo> / secret <NAME> missing` → `./bin/init-target-repo.sh <repo-path> <linear-project-url-or-id>`

## 4. Register the Linear webhook

The one step the wizard can't automate (Linear has no API for webhook registration). In Linear: Settings → API → your `@claude` app → **Webhook URL** → paste `<your-worker-url>/linear`. Enable **only** the **Agent session events** category. Copy the signing secret and stash it via `wrangler secret put LINEAR_WEBHOOK_SECRET` (or re-run `./bin/setup` and let phase 8 prompt you).

Full Linear app walkthrough: [`docs/linear-app-setup.md`](./linear-app-setup.md).

## 5. Wire up a target repo (or several)

```bash
./bin/init-target-repo.sh /path/to/target-repo <linear-project-url-or-id>
```

Idempotent; one command per project. The wizard offers to run this on its last phase if you want to do everything in one shot.

## 6. Test the loop

Create a Linear issue in your project and delegate it to `@claude`. Watch the trace ID flow through:

- `cd worker && npx wrangler tail` — Worker receives the `AgentSessionEvent` and fires `repository_dispatch`
- `gh run view --log` on the target repo — `linear-pickup` runs, Claude posts a plan
- The Linear issue — plan appears in the agent session, state flips to `Plan Review`

Reply **approve** in the session, and the implement cycle begins.
