# Platform agentic-integration audit (W-220)

A periodic audit of what Linear's and GitHub's agentic/assist surfaces offer vs. what the pipeline uses, so a fork-maintainer knows what shipped, what was deliberately skipped, and what to re-investigate as the platforms evolve.

_Last audited: 2026-05-28._

## TL;DR — what shipped in this pass

| Change | Where | Why |
|---|---|---|
| Widened Linear MCP allowlist for the planner | `linear-pickup.yml` | Give the planner cross-issue/project/doc context (`list_issues`, `get_project`, `list_projects`, `list_documents`, `get_document`) — all read-only, already covered by the app's `read` scope |
| CI MCP tools for the reviewer | `pr-review.yml` + `skills/pr-review` | Let the reviewer read **failing-check logs** (`mcp__github_ci__*`) instead of guessing, and block on red CI |
| `--json-schema` structured output | `linear-implement.yml` + `skills/linear-implement` | implement was the only Claude-invoking workflow not emitting a machine-readable self-report; its verify step now cross-checks it (additive — world-state assertions stay authoritative) |

Deferred to its own issue: **Linear Agent Sessions** migration (W-243). Skipped: **GitHub Copilot delegation**.

---

## Linear

### Agent Sessions (Agent Interaction API) — GA — **deferred (W-243)**

The highest-value *native* integration available. Users delegate or @mention an `actor=app` agent; Linear opens an **agent session** and the agent streams semantic activities (`thought` / `action` / `response` / `elicitation` / `error`) into a first-class "agent is working / waiting / done" UI. Linear manages the session lifecycle (`pending`/`active`/`awaitingInput`/`error`/`complete`/`stale`) automatically.

- Webhook: `AgentSessionEvent` (header `Linear-Event: AgentSessionEvent`). Payload lives under `agentSession` (NOT `data` like data-change webhooks). `action` is `created` or `prompted`. `promptContext` is **structured XML**, not plain text. ~10s activity SLA, ~5s HTTP ack.
- A user *stopping* the agent arrives as a `prompted` event with `agentActivity.signal: "stop"` — not an `action: "stopped"`. Check the signal.
- Post progress back via the `agentActivityCreate` GraphQL mutation.
- Requires a **new `actor=app` OAuth app** with `app:assignable` + `app:mentionable` scopes (workspace-admin install).

**Why deferred, not shipped:** this is a redesign, not a tweak. It replaces the human-readable plan-comment → 👍 approval gate (which @wells owns as UX) with an in-session elicitation round-trip, and needs a new OAuth app + new Worker webhook handlers (different payload shape than the current Issue/Comment/Reaction routing). Captured as **W-243** for a dedicated decision on the UX tradeoff and hybrid-vs-full-migration path.

### MCP tool surface — **partially adopted**

The hosted server (`https://mcp.linear.app/mcp`) exposes far more than the 5 tools the pipeline historically allowed. All the read tools below are covered by the app's existing `read` scope — adopting them is just widening the workflow allowlist, no new auth.

| Tool | Adopted? | Use |
|---|---|---|
| `list_issues` | ✅ pickup | Cross-issue context for the planner |
| `get_project` / `list_projects` | ✅ pickup | Project-level context |
| `list_documents` / `get_document` | ✅ pickup | Pull workspace spec docs into planning |
| `search_documentation` | ❌ | Searches *Linear's product docs*, not the workspace — low value here |
| `get_diff` / `get_diff_threads` / `list_diffs` | ❓ | **Unconfirmed on the hosted server.** Would be useful for a code-review agent if present — verify via a live `tools/list` before relying on them |

> The authoritative tool list for a given account is whatever `tools/list` returns from the live server (run `/mcp` in Claude Code against it). Published catalogs vary (21/25/31 tools) and mix in third-party reimplementations.

---

## GitHub

### Copilot coding agent — GA — **skipped**

Copilot's coding agent can be assigned a GitHub issue and autonomously open a PR. Assignment is a standard `issues` event with `action: assigned` to the bot login `copilot-swe-agent[bot]`; its PR is a standard `pull_request` `opened` (first commit is an empty draft-setup commit). Programmatic assignment exists (GraphQL `replaceActorsForAssignable` / `addAssigneesToAssignable`, or `createIssue`/`updateIssue` with `agentAssignment`; header `GraphQL-Features: issues_copilot_assignment_api_support`).

**Why skipped:** the assignment mutation only works with a **user token (PAT or user-to-server) from a Copilot-licensed seat** — a plain GitHub App / `GITHUB_TOKEN` can't see the bot. Our Worker dispatches under App identities (`claude-dispatch`), so delegation would need new credentials. And it's a *competing* coding agent — low value when the loop already runs Claude end-to-end. Detection of Copilot-opened PRs is trivially possible if we ever want it (standard webhooks), but there's no current use.

### claude-code-action — pinned `@v1` — **features adopted**

`@v1` floats to the latest `v1.0.x`, which is current. Two capabilities worth plumbing through for our dispatch-driven (non-@mention) usage:

- **`--json-schema` → `structured_output`** action output. Already used by pickup and pr-review; now also implement. Lets the mandatory verify steps cross-check a validated self-report against world state instead of parsing prose.
- **`additional_permissions: actions: read`** unlocks the bundled CI MCP server (see below).

Other inputs noted but not adopted: `track_progress` (live tracking comment — our Linear comments already cover progress), `settings`, `allowed_non_write_users`. All CLI options now go through `claude_args` (top-level `allowed_tools`/`model`/`mcp_config` inputs are deprecated) — we already use `claude_args`.

### Bundled CI MCP tools (`mcp__github_ci__*`) — **adopted in pr-review only**

claude-code-action ships small purpose-built MCP servers (not the full `github/github-mcp-server`). The CI server exposes `get_ci_status`, `get_workflow_run_details`, `download_job_log` — exactly what a reviewer needs to read failing-test output.

**Three hard requirements (all confirmed from action source), or the server is _silently omitted_ (no error, tools just don't exist):**

1. **PR context** (`context.isPR` must be true).
2. The job `permissions:` block grants `actions: read`.
3. `additional_permissions: actions: read` is set on the claude step.

The CI tools read via the workflow's auto-minted `GITHUB_TOKEN` (`DEFAULT_WORKFLOW_TOKEN`) — **not** any custom `github_token` you pass. So in `pr-review`, where we override `github_token` with the reviewer App's installation token, that custom token is irrelevant to the CI tools and **no reviewer-App permission change is needed**.

**Why pr-review only, not implement:** `linear-implement` runs on `repository_dispatch`, which is **not** PR context — so the CI server would never load there even though the agent opens a PR mid-run. implement keeps its existing broad `Bash` access (it can `gh pr checks` / `gh run view` if it ever needs CI state). pr-review runs on `pull_request`, so the CI tools load.

> Per-tool names and gating are version-sensitive. If the tools don't appear after wiring, turn on action debug logging and confirm the `github_ci` server registered.

---

## Re-investigate next time

- **Linear `tools/list`** — confirm whether diff/PR-review tools (`get_diff` etc.) have landed on the hosted server; if so, a richer pr-review context becomes possible.
- **Agent Sessions (W-243)** — the strategic direction; revisit when there's appetite for the UX change.
- **claude-code-action** — watch for a `v2` and for new structured-output / progress / permission inputs.
- **Copilot delegation** — only worth revisiting if a use case appears for routing certain issues to Copilot instead of the Claude loop (would still need a Copilot-seat PAT).
