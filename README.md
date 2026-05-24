# ssot-pipeline

Drives an autonomous coding loop: Linear issues in `Todo (AI)` → Claude plans → you 👍 the plan → Claude implements → PR opens → Claude reviews → you approve → ship. Plus auto-review on every PR in target repos.

State lives in Linear and GitHub. Nothing to host long-term except a free Cloudflare Worker.

## What's in the box

- **`.github/workflows/`** — four reusable workflows (`linear-pickup`, `linear-implement`, `pr-review`, `pr-merge`). Target repos consume them via `uses:`.
- **`worker/`** — Cloudflare Worker that receives Linear webhooks and fires GitHub `repository_dispatch` events into the right target repo.
- **`templates/ssot.yml`** — the ~20-line stub a target repo drops in to wire itself up.
- **`bin/init-target-repo.sh`** — one-command setup for a new target repo.
- **`docs/`** — identity setup walkthroughs (Linear OAuth app, GitHub Apps).

## Quick setup (first-time, for the maintainer)

1. Create the `claude` Linear OAuth app — see [`docs/linear-app-setup.md`](./docs/linear-app-setup.md)
2. Install the `claude[bot]` GitHub App — see [`docs/github-app-setup.md`](./docs/github-app-setup.md)
3. Deploy the Worker — `cd worker && wrangler deploy`
4. Register the Linear webhook → your Worker URL
5. Run `./bin/init-target-repo.sh <repo-path> <linear-project-id>` for each project you want to wire up

## How a single issue flows through the loop

```
Todo (AI) ──webhook──▶ Plan Review ──👍 reaction──▶ In Progress ──implement──▶ In Review ──approve──▶ Done
                       (claude posts                  (claude branches,           (claude-code-action
                        plan comment)                  commits, opens PR)          auto-reviews the PR)
```

Each step is a fresh headless `claude -p` invocation. No session resume, no in-process pause. If a webhook is re-fired, the workflows are idempotent.

## Troubleshooting

- **Worker logs:** `wrangler tail` from `worker/`
- **Workflow logs:** `gh run view <run-id> --log` — Claude's transcript is in the stream-json output
- **Linear webhook deliveries:** Linear → Settings → API → Webhooks → click your webhook → Deliveries tab
- **Stuck issue:** check its state vs. the [state machine](#how-a-single-issue-flows-through-the-loop). Move to the previous state to re-trigger.
