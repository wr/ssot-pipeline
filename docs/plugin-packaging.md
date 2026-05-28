# Packaging pipeline behavior as a Claude Code plugin

**Status:** investigation (W-158). This doc proposes a direction and ships a working proof-of-concept (`pr-review` extracted into a plugin skill). It does **not** migrate the live workflows — those keep running unchanged until we deliberately cut over.

## TL;DR / recommendation

- **It's feasible.** The installed `claude` (v2.1.153) has a `--plugin-dir <path>` flag that loads a plugin from a local directory in a non-interactive CI run. That's the load path — no interactive `/plugin install`, no extra service. Verified, not inferred (and the POC's two manifests pass `claude plugin validate`).
- **The win is real but narrow:** prompts become *versioned, diffable artifacts* instead of text buried inside 400-line workflow YAML. That's the headline reason to do this. Everything else (hooks replacing verification bash, config injection) is a bonus that depends on this landing first.
- **Recommended order:** Phase 1 = move prompt *bodies* into plugin skills, one workflow at a time, leaving all the bash plumbing alone. Phase 2 = a `SessionStart` hook that injects pipeline config. Phase 3 (only once 1–2 are stable) = a `Stop` hook + Worker `/verify` endpoint to collapse the per-workflow verification bash. Rationale below.
- **The catch worth understanding:** a plugin skill is a *static* markdown file. It can't do GitHub Actions `${{ }}` interpolation. So the per-run values our prompts inject today (issue ID, PR number, trace, state names) need a new delivery path. Three options, covered below — Phase 1 uses the lowest-friction one.

---

## 1. Where prompts live today

Every step of the loop is a fresh `claude -p` invocation run by `anthropics/claude-code-action@v1`. The instructions for each step are an inline `prompt:` block inside the workflow YAML. Inventory:

| Workflow | Prompt job | ~lines | Interpolated config / per-run values |
|---|---|---|---|
| `linear-pickup.yml` | post a plan, → Plan Review | ~44 | `plan_marker`, `plan_review_state`, `ISSUE`, `TRACE` |
| `linear-implement.yml` | implement approved plan, open PR | ~34 | `plan_marker`, `branch_prefix`, `in_review_state`, `ISSUE`, `TRACE`, `approval_comment_id` |
| `linear-replan.yml` | revise plan after feedback | ~44 | `plan_marker`, `plan_review_state`, `in_progress_state`, `ISSUE`, `COMMENT_ID`, `TRACE` |
| `pr-review.yml` | review PR, post verdict | ~51 | `review_bot_login`, `PR`, `TRACE`, PR title |
| `pr-fix.yml` | address blocking findings | ~53 | `ISSUE`, `PR`, `REPO`, `TRACE`, `REVIEWER`, head ref |

~226 prompt lines total, welded into YAML. Each prompt already separates **stable instructions** (top, marked "cacheable") from a **per-request context tail** (bottom, marked "variable") — see the comment at the top of every prompt block. That existing split is exactly the seam a plugin migration cuts along.

Config values reach the prompts via `fetch-pipeline-config` (curls the Worker `GET /config`, which serves `config/pipeline.json`) → `steps.cfg.outputs.*` → `${{ }}` interpolation. The Linear MCP server is written to `/tmp/mcp.json` by `write-mcp-config`; the GitHub MCP server is injected by `claude-code-action` itself via OIDC.

## 2. What a plugin gives us

A **plugin** bundles skills, slash commands, subagents, hooks, and MCP server defs into one versioned unit (`.claude-plugin/plugin.json` manifest). A **marketplace** (`.claude-plugin/marketplace.json`) is just an index that lists plugins; it can live in the same repo and point at a plugin in a subdirectory.

The payoff, in priority order:

1. **Versioned, diffable prompts.** "We changed the review rubric" becomes a clean diff to `skills/pr-review/SKILL.md` with its own history — not a hunk buried in `pr-review.yml` next to bash. This aligns with the repo's whole config-as-code philosophy (see [architecture.md](./architecture.md#1-config-as-code)).
2. **Composability for target repos.** A target repo could load the plugin and add/override a skill without forking our workflow YAML.
3. **One home for "what this agent does AND what it may touch."** Skill frontmatter carries `description`, `allowed-tools`, `model`, `disable-model-invocation` — today those are scattered across the prompt body and `claude_args`.
4. **Thinner workflows.** Each workflow shrinks toward "load plugin, invoke skill, pass per-run context."

## 3. Feasibility: how a plugin loads in CI

This is the question that gates everything. Findings (confirmed against `claude --help` on v2.1.153 unless noted):

| Mechanism | Works non-interactively? | Notes |
|---|---|---|
| `--plugin-dir <path>` (claude_args) | ✅ **yes** | Loads a plugin from a local dir or `.zip`, this session only. Repeatable. **This is the CI path.** |
| `--plugin-url <url>` | ✅ yes | Fetches a `.zip` at startup. Useful if the plugin lives in another repo. |
| `enabledPlugins` + `extraKnownMarketplaces` in settings.json | ⚠️ partial | Registers a marketplace and enables a plugin, but does **not** auto-install from a manifest in non-interactive mode. Brittle for CI. |
| `/plugin install` (interactive) | ❌ no | Requires the interactive `/` menu. Not usable in CI. |
| `claude-code-action` `plugin_marketplaces` input | ⚠️ Git URL only | Accepts Git URLs, not local paths (blocked by input validation — [action issue #664](https://github.com/anthropics/claude-code-action/issues/664)). So for a *same-repo* plugin, use `--plugin-dir` via `claude_args`, not this input. |

**Conclusion:** since we keep the plugin in this repo (Wells's call), the workflow checks out the repo (it already does) and passes `--plugin-dir ./plugins/ssot-agents` in `claude_args`. The `marketplace.json` is then mainly for *human* discovery / interactive use; CI doesn't read it. That's fine — it costs one small file and makes the plugin installable by hand too.

> **Caveat:** `--plugin-dir` is confirmed present in the installed binary, and the POC manifests pass `claude plugin validate`. What's **not** yet proven is a full `claude-code-action` CI job that loads the skill via `--plugin-dir` and invokes it end-to-end against a real PR. That live run is the remaining proof before migrating any production workflow.

## 4. The central design problem: static skills can't interpolate

A `SKILL.md` is static markdown committed to the repo. It cannot evaluate `${{ steps.cfg.outputs.review_bot_login }}` or `${{ env.PR }}`. So the per-run values the prompts inject today need a new delivery path. Options:

| Option | How | Best for | Phase |
|---|---|---|---|
| **(a) Skill arguments** | Invoke `/pr-review 123 abc12345 wr-claude-reviewer[bot]`; skill body uses `$1`, `$2`, `$ARGUMENTS` | Per-run scalars (PR #, trace, issue ID) | 1 |
| **(b) Thin prompt tail** | Keep the small "variable context" block in the workflow's `-p` prompt; that prompt just says "follow the `/pr-review` skill" for the stable rubric | Lowest migration friction; full coexistence | 1 |
| **(c) `SessionStart` hook** | A hook curls `GET /config` and returns `additionalContext` with state names / markers, so config stops being interpolated into prompts at all | Config shared across all skills | 2 |

**Phase 1 recommendation:** use (b) as the default — the stable rubric moves into the skill, the tiny per-run tail stays in the workflow prompt — and (a) where a skill takes a clean set of scalar args (like `pr-review`). Defer (c) to Phase 2 because it's where the `SessionStart` hook earns its keep.

## 5. What moves, what stays

| Concern | Today | After Phase 1 |
|---|---|---|
| Stable instructions (rubric, steps, security preamble) | inline in YAML | **plugin skill body** (versioned) |
| Per-run context (issue, PR, trace) | `${{ }}` in prompt tail | skill args / thin prompt tail |
| Pipeline config (state names, markers) | `fetch-pipeline-config` → `${{ }}` | unchanged in P1; `SessionStart` hook in P2 |
| Tool allow/deny policy | `claude_args` | skill frontmatter `allowed-tools` (allowlist); **keep the granular safety blocklist in `claude_args` for now**¹ |
| Linear MCP server | `/tmp/mcp.json` via `write-mcp-config` | could move to plugin `.mcp.json` (P2); token injection stays a workflow concern |
| GitHub MCP server | injected by `claude-code-action` (OIDC) | unchanged |
| Verification (`if: always()` bash) | per-workflow bash | unchanged in P1; `Stop` hook + Worker `/verify` in P3 |

¹ Skill frontmatter `allowed-tools` accepts a tool list, but it's **unconfirmed** whether it supports the granular `Bash(git push*)` deny-pattern syntax the workflows rely on for safety. Until verified, keep `--disallowedTools` in `claude_args` (belt-and-suspenders) and use frontmatter only for the positive allowlist.

## 6. Proof-of-concept (shipped in this PR)

Extracts the **`pr-review`** prompt — the most self-contained one — into a real plugin skill, with a same-repo marketplace manifest:

```
.claude-plugin/
  marketplace.json                     # marketplace index → ./plugins/ssot-agents
plugins/
  ssot-agents/
    .claude-plugin/
      plugin.json                      # plugin manifest
    skills/
      pr-review/
        SKILL.md                       # the extracted stable rubric
```

What it proves:
- A valid marketplace → local-plugin → skill chain in this repo (both manifests pass `claude plugin validate`).
- The stable `pr-review` rubric reads cleanly as a skill, parameterized by three args (`$1` PR number, `$2` trace, `$3` review-bot login) — demonstrating injection option (a).
- Frontmatter carries `description`, `allowed-tools`, and `disable-model-invocation: true` (the skill is meant to be invoked explicitly by the workflow, not auto-triggered).

What it deliberately does **not** do:
- It does **not** touch `pr-review.yml`. The live workflow keeps its inline prompt. Cutover is a separate, opt-in change.
- It is inert for normal use: a `marketplace.json` in the repo isn't auto-registered, and a plugin under `plugins/` (not `.claude/skills/`) isn't auto-loaded — so this PR can't disturb the running pipeline or anyone's local Claude session.

How a *future* thin `pr-review` workflow would invoke it (illustrative — not added here):

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    prompt: "/pr-review ${{ env.PR }} ${{ env.TRACE }} ${{ steps.cfg.outputs.review_bot_login }}"
    claude_args: |
      --plugin-dir ./plugins/ssot-agents
      --model ${{ steps.effort.outputs.model }}
      --max-turns ${{ steps.effort.outputs.max_turns }}
      --disallowedTools "Write" "Edit" ...   # safety blocklist stays here
      --json-schema '{...}'
```

## 7. Recommended phasing

**Phase 1 — prompts into skills (low risk, do first).**
Migrate prompt bodies into plugin skills, one workflow at a time, loaded via `--plugin-dir`. Per-run context via skill args / thin prompt tail (options a/b). All bash — config fetch, MCP write, verification — stays exactly as-is. Each workflow is migrated and validated independently; if a skill misbehaves, revert that one workflow's prompt. Delivers the headline win immediately. Start with `pr-review` (this POC), then `linear-pickup`, etc.

**Phase 2 — config injection via `SessionStart` hook (medium risk).**
Add a `SessionStart` hook to the plugin that curls `GET /config` and emits `additionalContext` with state names, markers, branch prefix. Removes config interpolation from prompts. Optionally move the Linear MCP server def into the plugin's `.mcp.json` (token still injected via env at runtime).

**Phase 3 — verification via `Stop` hook + Worker `/verify` (defer until 1–2 are stable).**
Add a `/verify` endpoint to the Worker and a `Stop` hook that calls it, collapsing the ~50 lines of `if: always()` verification bash per workflow into one shared place. Deferred last because it reshapes the **safety net** ([architecture.md §3](./architecture.md#3-mandatory-verification--stuck-state)): today the verify step also decides auto-replan-vs-Stuck and dispatches `linear-replan`. A hook would have to either replicate that orchestration or hand back a decision the workflow acts on. Don't touch this until versioned prompts have proven the plugin mechanism is reliable.

**Why this order:** `--plugin-dir` is verified-solid, so Phase 1 is the safe foundation. Hooks are documented and available, but Phase 3 in particular trades a battle-tested inline safety net for a newer mechanism — it should go last, behind the most evidence.

## 8. Risks / open questions

- **End-to-end CI run unproven.** `--plugin-dir` exists on the binary and the manifests pass `claude plugin validate`, but no full `claude-code-action` job has loaded the skill this way + invoked it against a real PR. Prove that before migrating any live workflow.
- **Frontmatter tool-deny granularity (footnote 1).** Confirm whether `allowed-tools`/`disallowed-tools` frontmatter supports `Bash(pattern*)` deny syntax. If not, the safety blocklist stays in `claude_args` indefinitely — which is fine.
- **Two `claude` versions.** Skills/hook contracts can shift between Claude Code releases. The runner's `claude` version (via `claude-code-action`) may lag the local one (v2.1.153). Pin or check the action's bundled version before relying on `--plugin-dir`.
- **Marketplace publicity.** The plugin lives in this (public) repo per decision. The prompts contain no secrets, but they do reveal the loop's exact operating instructions — acceptable, just noted.
- **Maintenance surface.** A `marketplace.json` + `plugin.json` are two more files to keep in sync with reality (e.g., bump plugin `version` on prompt changes; the `templates/ssot.yml` version contract still governs target-repo cutover).
- **Coexistence window.** During migration some workflows use skills and some use inline prompts. That's fine — they're independent — but the prompt-structure comment ("stable first, variable last") should stay accurate in both.

## 9. References

- [architecture.md](./architecture.md) — current three-pillar design (config-as-code, trace IDs, verification+Stuck)
- Current inline prompts: `.github/workflows/{linear-pickup,linear-implement,linear-replan,pr-review,pr-fix}.yml`
- Config flow: `.github/actions/fetch-pipeline-config/`, `.github/actions/write-mcp-config/`, `config/pipeline.json`, Worker `GET /config` (`worker/src/index.ts`)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins) · [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) · [skills](https://code.claude.com/docs/en/skills) · [hooks](https://code.claude.com/docs/en/hooks)
- [claude-code-action issue #664](https://github.com/anthropics/claude-code-action/issues/664) — local marketplace path support

<!-- smoke test: verifying plugin-based pr-review runs end-to-end; PR will be closed -->
