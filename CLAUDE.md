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
- **The AI CEO (`ai-ceo.yml`) is the one intentionally `on:`-triggered orchestration workflow** — it operates *on the product* (dogfooding), is meta-repo only, and stays dormant until `ceo.enabled` in `config/pipeline.json` is true. Its behavior lives in the `ai-ceo` plugin skill + the `ceo` config block (skills/config over YAML, per the house rules). Full autonomy is the design but `auto_merge`/`approve_plans` ship `false` so authority ramps in stages. See `docs/ai-ceo.md`. The human is **chairman of the board** — the CEO runs day-to-day, escalates big calls.
- The Worker (`worker/`) is a pure router — no state, no DB. State always lives in Linear and GitHub.
- **Magic strings live in `config/pipeline.json`** — plan marker, MCP URL, state names, approval rules, project→repo routing. The Worker imports it at build time and serves it at `GET /config`; workflows curl that endpoint and inject values into prompts. Don't duplicate config values into workflow YAML or Worker code — read from here.
- **Trace IDs are mandatory** — every Worker-initiated webhook gets an 8-char trace ID. Propagate it through `client_payload.trace_id`, echo in workflows, embed in Linear comments. Makes cross-system debugging tractable.
- **Every workflow ends with a verification step** — assert the expected outcome happened (state transition, comment posted, PR opened). If not, post a diagnostic Linear comment and flip the issue to `Stuck`. No silent successes.
- When changing the contract between Worker and workflows (event shape, client_payload), update both sides in the same PR and bump the version in `templates/ssot.yml` so target repos know to re-run `init-target-repo.sh`.
- **The loop can't push `.github/workflows/*` changes.** `claude-code-action` pushes with the Claude App's OIDC-minted token, and Anthropic withholds the `workflow` scope from it by design — so a `linear-implement` run that edits a workflow file can't push and would otherwise false-Stuck. Prefer landing behavior in **plugin skills / composite actions (`.github/actions/*`) / `config/pipeline.json`**, which have no such gate. Genuine workflow-file edits are handed off: the implement skill detects the diff, skips the push, and posts a ready-to-apply patch for a human to land (a human/admin push, since these also can't be bot-reviewed — `pr-review` skips workflow-modifying PRs). See W-276 / W-218.
- Don't commit secrets. Only true secrets (Linear webhook signing secret, Linear app token, GitHub dispatch PAT) are `wrangler secret put`s. Non-secret identifiers like user IDs and project→repo mappings live in `config/pipeline.json`.

## Identities
- `@claude` in Linear = the Linear OAuth app (actor=app). Token = `LINEAR_APP_TOKEN`.
- `claude[bot]` in GitHub = the GitHub App installed via `claude-code-action`'s `/install-github-app`. Plus a second `claude-dispatch` GitHub App used by the Worker for `repository_dispatch` calls.
- `@wells` = the human. The sign-off gate is the **GitHub PR merge** under `main` branch protection (nothing auto-merges). In-session reply-approval is an optional, off-by-default gate — only enforced when `enforce_approved_users: true`, which checks the session creator against `approved_user_ids` in `config/pipeline.json`.
