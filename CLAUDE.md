# ssot-pipeline

Autonomous Linear ↔ Claude Code ↔ GitHub loop. This is the **meta-repo** — it ships the reusable GitHub Actions workflows and Cloudflare Worker that drive the loop. Target project repos consume the workflows via `uses:` and route their Linear webhooks to the Worker.

See `README.md` for the user-facing intro and setup. See `docs/architecture.md` for the design notes.

## Source of truth
- GitHub: github.com/wr/ssot-pipeline
- Linear project: SSOT Pipeline (id: f9eb7447-31fb-4e02-b46b-7d147f2d0f55, team: Personal)
- Branch prefix: wells/
- PR mode: ready

## Working in this repo

- All three reusable workflows in `.github/workflows/` use `workflow_call`. Don't add `on:` triggers that fire them in this repo unless they're for dogfooding the loop here. Target repos call them.
- The Worker (`worker/`) is a pure router — no state, no DB. State always lives in Linear and GitHub.
- When changing the contract between Worker and workflows (event shape, client_payload), update both sides in the same PR and bump the version in `templates/ssot.yml` so target repos know to re-run `init-target-repo.sh`.
- Don't commit secrets. The Worker reads them via `wrangler secret`; workflows read them via `${{ secrets.* }}`.

## Identities
- `@claude` in Linear = the Linear OAuth app (actor=app). Token = `LINEAR_APP_TOKEN`.
- `claude[bot]` in GitHub = the GitHub App installed via `claude-code-action`'s `/install-github-app`. Plus a second `claude-dispatch` GitHub App used by the Worker for `repository_dispatch` calls.
- `@wells` = the human. Approval gates (👍 reaction in Linear, PR approval in GitHub) only count when authored by this user ID.
