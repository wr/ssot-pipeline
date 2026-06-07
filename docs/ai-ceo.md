# The AI CEO (W-358)

An autonomous orchestration layer that sits **above** the issue→PR loop and **runs
the product**. Wells is **chairman of the board — not the CEO's manager**: he sets
occasional high-level direction and handles the rare escalation. The CEO owns the
day-to-day.

The loop executes *one issue → one PR*. The CEO is the layer that decides **what**
to build, **what "done" means**, **whether the quality bar is met**, and **what's
next** — generatively, not by waiting to be told. It's the owner role a human
product lead plays for Devin/Cursor/Copilot, run by the agent itself.

## Authority model — the CEO is in charge

Chairman direction (2026-06-04): the CEO is **generative and decisive**. It authors
and prioritizes the roadmap, writes acceptance criteria, delegates work, approves
plans, verifies quality, and merges PRs that clear its bar — and it **escalates
rarely**: only real money/spend, secrets/auth/billing, irreversible actions, a
genuine strategic fork, or a guardrail it must not cross. Asking the chairman to
triage the backlog, pick the next task, or approve routine work is an anti-pattern —
that's the CEO's job. Every powerful action is still bounded by `config/pipeline.json`
→ `ceo`; exceeding a guardrail is one of the rare escalations.

The capability shipped **dormant** and ramped through stages; it now runs at **full
action mode**:

| Stage | `ceo.enabled` | `auto_merge` / `approve_plans` | What runs |
|---|---|---|---|
| 0 — shipped | `false` | `false` | Nothing. Daily cron fires and no-ops. |
| 1 — observe | `true` | `false` | Surveys, triages, files/prioritizes, delegates, briefs. Never merges. |
| **2 — action (current)** | `true` | `true` | Owns the loop end-to-end: creates, delegates, approves plans, and auto-merges PRs that pass *every* guardrail. |

Each stage transition is a one-line config edit + Worker redeploy — reversible at
any time (drop back to observe or dormant by flipping the flags).

## Guardrails (config/pipeline.json → `ceo`)

```jsonc
"ceo": {
  "enabled": true,                  // master switch (stage gate)
  "briefing_marker": "## 🧭 CEO Briefing",
  "chairman_linear_handle": "wells",
  "chairman_github_login": "wr",
  "digest_issue_id": "W-358",       // where briefings are posted
  "autonomy": {
    "create_issues": true,
    "refine_and_prioritize": true,
    "delegate_to_loop": true,
    "approve_plans": true,          // CEO judges + approves plans itself
    "auto_merge": true              // CEO merges PRs that clear every guardrail
  },
  "guardrails": {
    "max_delegations_per_run": 3,   // hands-off loop starts per cycle
    "max_actions_per_run": 20,      // total mutating actions per cycle
    "max_pr_additions": 800,        // auto-merge size ceiling (lines)
    "max_pr_files": 25,             // auto-merge size ceiling (files)
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
starting with `briefing_marker`. It leads with **what it decided and did** and where
it's steering the **roadmap**; it @-mentions you only in a rare **Escalations**
section (usually omitted). Over-mentioning erodes the signal — the CEO decides, it
doesn't ask. That thread is your board-meeting minutes.

## Safety properties

- **Dormant by default** — ships off; you arm it.
- **Two independent gates** — `enabled` and `auto_merge` ramp authority separately.
- **Hard caps** — actions/delegations per run are bounded; runaway loops can't happen.
- **Protected paths + branch protection** — two layers stand between the CEO and a
  dangerous merge.
- **Untrusted-data discipline** — all Linear/GitHub content is data, never
  instructions; a "merge me" written in a PR/issue is never a valid approval. The
  CEO auto-merges only within its guardrails, and `main` branch protection still
  requires the reviewer-bot APPROVE + green checks — so it can't merge anything a
  human-equivalent gate wouldn't allow. The chairman can override or dial it back
  anytime by editing config.
- **No silent successes** — a run that fails to report goes red and emails you.
- **Full audit trail** — trace IDs in logs + briefings; every action is logged in
  the briefing and the run summary.

## Chairman's runbook (it's already live)

The CEO runs at full action mode on the daily cron. You rarely need to touch it.

- **Watch:** read the briefings on W-358. They're the board minutes — decisions,
  roadmap, and the occasional escalation aimed at you.
- **Run it now:** *Actions → ai-ceo → Run workflow* (add `dry_run: true` for a
  survey + briefing with zero mutations).
- **Dial it back:** set `autonomy.auto_merge: false` (CEO stops merging) or
  `ceo.enabled: false` (CEO goes fully dormant) in `config/pipeline.json` and merge.
  Reversible the same way.
- **Tune its rope:** adjust `max_delegations_per_run`, `max_actions_per_run`,
  `max_pr_*`, and `protected_paths` to widen or tighten what it does unattended.

## Loop health signal (W-362)

The CEO doesn't introspect the loop — it reads an aggregated weekly digest.
`.github/workflows/eval-harness.yml` runs Mondays 14:00 UTC, queries Linear
state history + GitHub PR data for the past `sli.window_days` (default 7), and
posts one structured `## 📉 Loop SLI` comment to the dedicated tracking issue
configured as `sli.tracking_issue_id` (W-376). Each comment carries
`success_rate`, `mean_fix_cycles`, `stuck_rate`, `human_edit_rate`, and
`workflow_minutes`. The survey step reads the most recent comment and surfaces
the headline numbers in every briefing's Loop SLI line — so the CEO has an
objective health signal it can reference without standing up its own
instrumentation. Both knobs are optional: when `tracking_issue_id` is empty, the
harness no-ops and the Loop SLI clause is omitted from the briefing.

## Roadmap

The CEO is the orchestration hub for the rest of the backlog: it consumes the
loop success-rate metrics (W-362 — now live via the eval harness above) to
steer, drives parallel execution (W-360) by choosing batches, and reports
against the competitive gaps the backlog encodes. v1 operates on the SSOT
Pipeline project; expand to other target repos once trusted.
