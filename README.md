# ssot-pipeline

Drives an autonomous coding loop: Linear issues in `Todo (AI)` → Claude plans → you 👍 the plan → Claude implements → PR opens → Claude reviews → (auto-fix if changes requested) → you approve → ship. Plus auto-review on every PR in target repos.

State lives in Linear and GitHub. Nothing to host long-term except a free Cloudflare Worker.

## What's in the box

- **`config/pipeline.json`** — single source of truth for all magic strings (plan marker, MCP URL, state names, approval rules, project→repo routing). Change here, redeploy Worker, all consumers pick it up.
- **`.github/workflows/`** — five reusable workflows (`linear-pickup`, `linear-implement`, `linear-replan`, `pr-review`, `pr-fix`). Target repos consume them via `uses:`. Auto-close on PR merge is handled by Linear's native GitHub integration (PR body uses `Closes W-XX`).
- **`worker/`** — Cloudflare Worker that receives Linear webhooks, generates trace IDs, fires GitHub `repository_dispatch` events. Also serves `GET /config` so workflows can read the shared config at run time.
- **`templates/ssot.yml`** — the ~20-line stub a target repo drops in to wire itself up.
- **`bin/init-target-repo.sh`** — one-command setup for a new target repo.
- **`docs/`** — identity setup walkthroughs (Linear OAuth app, GitHub Apps) and architecture notes.

## Quick setup (first-time, for the maintainer)

1. Create the `claude` Linear OAuth app — see [`docs/linear-app-setup.md`](./docs/linear-app-setup.md)
2. Install the `claude[bot]` GitHub App + create the `wr-claude-reviewer` GitHub App — see [`docs/github-app-setup.md`](./docs/github-app-setup.md). The reviewer App is a separate identity so it can APPROVE / REQUEST_CHANGES on PRs authored by `claude[bot]` (GitHub blocks PR authors from reviewing their own PR).
3. First-time Worker deploy — `cd worker && npx wrangler deploy`. After that, the `deploy-worker` GitHub Action redeploys automatically on every merge that touches `config/pipeline.json` or `worker/**` (needs repo secret `CLOUDFLARE_API_TOKEN`).
4. Register the Linear webhook → your Worker URL
5. Run `./bin/init-target-repo.sh <repo-path> <linear-project-url-or-id>` for each project you want to wire up

## Adding a new target repo

Per-repo, setup is one command:

```
./bin/init-target-repo.sh <repo-path> <linear-project-url-or-id>
```

The Linear arg accepts a full project URL (`https://linear.app/<ws>/project/<slug>`), a bare URL slug (`<slug>`), or the UUID — copy whichever is easiest from the Linear UI.

Prereqs: `gh` CLI authenticated, `jq` installed, the `wr-claude-reviewer` GitHub App installed on the target repo, and four secrets resolvable via env var, macOS Keychain, or interactive prompt: `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_APP_TOKEN`, `CLAUDE_REVIEWER_APP_ID`, `CLAUDE_REVIEWER_APP_KEY`. To skip prompts every run, seed Keychain once:

```
security add-generic-password -s ssot-pipeline -a LINEAR_APP_TOKEN -w '<token>'
security add-generic-password -s ssot-pipeline -a CLAUDE_CODE_OAUTH_TOKEN -w '<token>'
security add-generic-password -s ssot-pipeline -a CLAUDE_REVIEWER_APP_ID -w '<app-id>'
security add-generic-password -s ssot-pipeline -a CLAUDE_REVIEWER_APP_KEY \
  -w "$(cat /path/to/wr-claude-reviewer.private-key.pem)"
```

(Add `-U` to overwrite if an entry already exists. Multi-line values like the PEM are stored as binary — `load_secret` transparently hex-decodes on read.) The script reads in order: env → Keychain → prompt.

If the target dir isn't a git repo (or has no GitHub remote), the script prompts to `git init` + `gh repo create` (private by default) and pushes the current dir contents as the first commit before wiring up. Once the target has a remote, both repos must be on their default branch with clean working trees in sync with origin — the script aborts otherwise rather than risk clobbering local work.

The script does everything end-to-end:
1. If the target isn't a GitHub-tracked repo yet, prompts for visibility (private/public/abort) and runs `git init` + initial commit + `gh repo create --push`.
2. Installs `templates/ssot.yml` → `<repo>/.github/workflows/ssot.yml` (wires up `linear-pickup`, `linear-implement`, `pr-review`)
3. Appends a `## Source of truth` block to `<repo>/CLAUDE.md` (creates the file if missing)
4. Sets repo secrets `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_APP_TOKEN`, `CLAUDE_REVIEWER_APP_ID`, `CLAUDE_REVIEWER_APP_KEY`
5. Commits + pushes the target repo's stub + CLAUDE.md changes
6. `jq`-edits this repo's `config/pipeline.json` to add the `project_to_repo` mapping, commits, and pushes to `main` — the `deploy-worker` Action then redeploys the Worker automatically

Re-runs are idempotent: each step skips itself if its effect is already in place.

To test: create a Linear issue in the new project and move it to `Todo (AI)`. Watch the trace ID propagate through `wrangler tail`, `gh run view --log` on the target repo, and the plan comment that appears in Linear.

(One thing the script doesn't touch: the workspace-level Linear webhook scope. Default = all projects in the workspace, so usually nothing to do; only matters if you've explicitly narrowed the webhook.)

## How a single issue flows through the loop

```
Todo (AI) ──webhook──▶ Planning ──plan posted──▶ Plan Review ──👍──▶ In Progress ──PR opens──▶ In Review ──merge──▶ Done
                       (early flip,              (claude posts        (early flip,             (Linear native
                        visible feedback)         plan comment)        then implements)         closes via Closes W-XX)
```

Each step is a fresh headless `claude -p` invocation. No session resume, no in-process pause. If a webhook is re-fired, the workflows are idempotent.

The `Planning` and `In Progress` flips happen at the very start of `linear-pickup` / `linear-implement` (before invoking Claude) so you see visible motion within seconds of moving an issue to `Todo (AI)` or 👍-ing a plan.

## Review & Fix Loop

When `pr-review` posts a `REQUEST_CHANGES` review on a PR, `pr-fix` fires automatically: it checks out the PR branch, reads the inline `blocking` findings, dispatches Claude to fix them, commits, and pushes. The new commits trigger `pr-review` again via `synchronize`, closing the loop.

```
In Review ──REQUEST_CHANGES──▶ In Progress ──fix pushed──▶ In Review ──re-review──▶ APPROVE
            (claude[bot]                    (claude[bot]                            (or another
             review)                         commit)                                 fix cycle)
```

Capped at `pr_fix_max_attempts` (default 2) from `config/pipeline.json`. On the (N+1)th REQUEST_CHANGES, the workflow posts a stuck comment, flips Linear to `Stuck`, and exits — human intervention required.

By default only reviews by `wr-claude-reviewer[bot]` or `wr` trigger the fix; edit `fix_reviewer_logins` in `config/pipeline.json` to widen.

Why a separate `wr-claude-reviewer[bot]` instead of having `claude[bot]` review its own PR? GitHub hardcodes "pull request authors can't approve their own pull request" — so the `claude[bot]` App that opened the PR can only file `COMMENTED` reviews, never `APPROVE` or `REQUEST_CHANGES`. The reviewer App is a distinct identity that GitHub allows to approve/reject those PRs. See [`docs/github-app-setup.md`](./docs/github-app-setup.md) for setup.

## Trace IDs

Every Linear webhook event gets an 8-character trace ID generated by the Worker. It rides through every layer:

- Worker logs (`trace=XXXXXXXX received Issue.update for W-NN`)
- `repository_dispatch.client_payload.trace_id`
- The first step of every workflow job echoes `🔗 trace=XXXXXXXX`
- Every Linear comment posted by the loop ends with `_(trace: XXXXXXXX)_`

To debug a sad run: copy the trace ID from any one place, then grep for it in `wrangler tail` output, `gh run view <id> --log`, and Linear comments. It'll appear in all three.

## Stuck state

If a workflow's verification step can't confirm the expected outcome, the issue moves to the **Stuck** state in Linear and a diagnostic comment is posted. This is the loop's "I need help" signal — fix whatever's broken, then move the issue back to `Todo (AI)` to retry.

Requires a `Stuck` workflow state (type: Started) in your team. Create it in Linear team settings if it's missing — the workflow warns but doesn't crash if absent.

## Troubleshooting

- **Worker logs:** `wrangler tail` from `worker/`
- **Workflow logs:** `gh run view <run-id> --log` — Claude's transcript is in the stream-json output
- **Linear webhook deliveries:** Linear → Settings → API → Webhooks → click your webhook → Deliveries tab
- **Stuck issue:** read the diagnostic comment for the trace ID + reason. After fixing, move the issue back to `Todo (AI)`.
- **Changing a magic string:** edit `config/pipeline.json`, commit, merge to main. The `deploy-worker` Action redeploys the Worker on merge, and the next workflow run picks up the new value from `GET /config`. For ad-hoc redeploys: `cd worker && npx wrangler deploy` (or use the manual run button on the deploy-worker workflow).
- **Editing reusable workflows from the loop itself:** `claude-code-action` mints its own GitHub App installation token via OIDC; that token needs `workflows: write` scope to push changes under `.github/workflows/*`. `linear-implement.yml` already passes `additional_permissions: workflows: write` to the action — if you fork or copy this setup, keep that input.
