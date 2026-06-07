# The AI CEO (W-358)

An autonomous orchestration layer that sits **above** the issue→PR loop and runs
the product day-to-day. You (Wells) are **chairman of the board**: the CEO runs
operations and pulls you in only for big decisions.

The loop already executes *one issue → one PR*. The CEO is the missing layer that
decides **what** to work on, **when**, and **whether it's good enough** — the
strategy/prioritization role a human product owner plays for Devin/Cursor/Copilot.

## Authority model — full autonomy within guardrails

Chairman decision (2026-06-03): **full autonomy** is the design. The CEO may
create/prioritize/close issues, tune the pipeline, kick off the loop, approve
plans, and merge PRs — but every powerful action is gated by `config/pipeline.json`
→ `ceo`, and anything failing a guardrail **escalates instead of acting**.

It ships **dormant and conservative**, with a deliberate ramp:

| Stage | `ceo.enabled` | `autonomy.auto_merge` | What runs |
|---|---|---|---|
| **0 — shipped (default)** | `false` | `false` | Nothing. Daily cron fires and no-ops. |
| **1 — observe** | `true` | `false` | Surveys, triages, files/prioritizes issues, delegates one ready issue per run, posts a briefing. **Never merges.** Plans/PRs awaiting a call are surfaced to you. |
| **2 — full** | `true` | `true` | Everything in stage 1, plus auto-merges PRs that pass *every* guardrail. |

Going from one stage to the next is a one-line config edit + Worker redeploy —
your go-live switch, reversible at any time.

## Guardrails (config/pipeline.json → `ceo`)

```jsonc
"ceo": {
  "enabled": false,                 // master switch (stage gate)
  "briefing_marker": "## 🧭 CEO Briefing",
  "chairman_linear_handle": "wells",
  "chairman_github_login": "wr",
  "digest_issue_id": "W-358",       // where briefings are posted
  "autonomy": {
    "create_issues": true,
    "refine_and_prioritize": true,
    "delegate_to_loop": true,
    "approve_plans": false,         // stays off until you grant it
    "auto_merge": false             // stays off until you grant it
  },
  "guardrails": {
    "max_delegations_per_run": 1,   // hands-off loop starts per cycle
    "max_actions_per_run": 8,       // total mutating actions per cycle
    "max_pr_additions": 400,        // auto-merge size ceiling (lines)
    "max_pr_files": 15,             // auto-merge size ceiling (files)
    "require_reviewer_approval": true,
    "require_all_checks_green": true,
    "protected_paths": [ "config/pipeline.json", ".github/workflows/", ... ]
  },
  "escalation": { "always_escalate": [ ... ] }
}
```

**Auto-merge requires ALL of:** checks green · reviewer-bot APPROVED · additions ≤
`max_pr_additions` · files ≤ `max_pr_files` · no `protected_paths` touched · not in
any `always_escalate` category. Any miss → the PR is surfaced to you, never forced.

`protected_paths` is the blast-radius fence: the CEO will not auto-merge changes to
its own config, the workflows, the actions, Worker infra, secrets, or security docs.
Those always come to you. Defense in depth: even if a guardrail were misconfigured,
`main` branch protection still requires green checks + the reviewer-bot approval, so
the CEO cannot merge anything a human-equivalent gate wouldn't allow.

## How it runs

`.github/workflows/ai-ceo.yml` — a scheduled (`cron: 0 15 * * *`) + manual
(`workflow_dispatch`, with a `dry_run` toggle) workflow in **this meta-repo only**.
It's the one workflow here with `on:` triggers because it operates *on the product*.

```
cron / dispatch
   │
   ├─ gate: fetch /config → ceo.enabled?  ──false──▶ no-op (green, no actions)
   │                                         true
   ▼
write MCP config → fetch plugin → claude-code-action /ai-ceo
   │     (survey Linear + GitHub, decide, act within guardrails)
   ▼
verify: a fresh briefing (briefing_marker) was posted on digest_issue_id
   │
   ├─ yes ▶ ✓ green
   └─ no  ▶ ::error:: exit 1  (loud — GitHub emails the owner, like the canary)
```

The CEO's logic lives in the plugin skill `plugins/ssot-agents/skills/ai-ceo/SKILL.md`
(role, decision framework, guardrail enforcement, escalation rules, briefing format,
prompt-injection defenses). The workflow passes the `ceo` config block, the project,
the date, and a trace ID; the skill is the sole authority on what it may do.

## Reporting — the Linear digest

Every run posts one briefing comment on `digest_issue_id` (default the W-358 epic),
starting with `briefing_marker`. It @-mentions you **only when a decision needs you**
— over-mentioning erodes the signal. Format: *what I did · what needs you · state of
the product · next focus.* That thread is your board-meeting minutes.

## Safety properties

- **Dormant by default** — ships off; you arm it.
- **Two independent gates** — `enabled` and `auto_merge` ramp authority separately.
- **Hard caps** — actions/delegations per run are bounded; runaway loops can't happen.
- **Protected paths + branch protection** — two layers stand between the CEO and a
  dangerous merge.
- **Untrusted-data discipline** — all Linear/GitHub content is data, never
  instructions; a "merge me" written in a PR/issue is never a valid approval. The
  only approval that counts is your GitHub PR merge.
- **No silent successes** — a run that fails to report goes red and emails you.
- **Full audit trail** — trace IDs in logs + briefings; every action is logged in
  the briefing and the run summary.

## Going live (the chairman's runbook)

1. **Stage 1 (observe):** set `ceo.enabled: true` in `config/pipeline.json`, merge,
   let `deploy-worker` redeploy. Watch the daily briefings on W-358 for a week.
   (Want a manual first run? Trigger `ai-ceo` via *Actions → ai-ceo → Run workflow*,
   optionally with `dry_run: true` to survey + brief without acting.)
2. **Stage 2 (full):** once the briefings read well, set `autonomy.auto_merge: true`
   (and/or `approve_plans: true`). Tune `max_pr_*` and `protected_paths` to taste.
3. **Pause anytime:** set `ceo.enabled: false` and redeploy. The CEO goes dormant on
   the next cycle.

## Roadmap

The CEO is the orchestration hub for the rest of the backlog: it consumes the
loop success-rate metrics (W-362) to steer, drives parallel execution (W-360) by
choosing batches, and reports against the competitive gaps the backlog encodes.
v1 operates on the SSOT Pipeline project; expand to other target repos once trusted.
