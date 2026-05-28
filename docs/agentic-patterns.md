# Agentic coding patterns — proposals for ssot-pipeline

A structured review of patterns from the broader agentic-coding ecosystem, evaluated against the current ssot-pipeline architecture (stateless Worker + ephemeral GitHub Actions + state in Linear/GitHub). Each section identifies a concrete gap and proposes a change pinned to a specific file, prompt section, or config key.

The architectural baseline this document compares against is summarized in [architecture.md](./architecture.md): every step is a fresh Claude invocation triggered by a webhook, no agent process is long-lived, and the only durable state across steps is what was written into Linear or GitHub.

---

## 1. Living plan documents

**Problem.** A plan posted as a static comment loses fidelity the moment implementation starts. Operators watching the issue can see *that* work is happening (via the `⚙️ Implementing` comment) but not *which* part of the plan is currently in flight, which sub-tasks have landed, and which are still pending. Long-running implementations look opaque.

**Current gap.** `linear-implement.yml` posts a single status comment at job start (`linear-implement.yml:117`) and otherwise stays silent until the PR is opened. The plan's `## Files to change` checklist is markdown but is never re-rendered with checkboxes ticked — the issue body and the plan comment are write-once.

**Proposed change.** After each meaningful milestone (branch created, edits complete, tests pass, PR opened), have the implement step re-render the plan comment with `- [x]` boxes ticked for completed items. Two options:

1. *In-place edit* of the original plan comment via `mcp__linear__save_comment` with the existing comment `id`. Lowest noise, preserves the approval reaction.
2. *Threaded reply* posting a fresh checklist snapshot under the plan thread. Higher noise but preserves history.

Implementation hook: a new `update_plan_progress` helper invoked from the implement prompt (steps 4, 6, 7 in the implement instructions) and from a final `if: always()` step in `linear-implement.yml`. Parse the plan comment body, regex-replace `- [ ] <item>` → `- [x] <item>` for items the model marks complete.

**Complexity.** M — requires plan-comment parsing and an additional MCP write per milestone. The model needs an explicit "which checklist items did you finish in this step?" prompt to drive it reliably.

**Impact.** High for operator trust on multi-file changes; medium otherwise.

---

## 2. Richer context handoff between steps

**Problem.** Each workflow step is a cold Claude invocation. The only data passed forward is the issue ID, the trace ID, and (for `linear-implement`) an optional approval comment ID. Useful accumulated context — prior failure shapes, the exact plan that was approved, conventions the model has already learned for this repo — must be re-derived from Linear comments on every run, wasting tokens and risking drift.

**Current gap.** `client_payload` in `linear-implement.yml:48-49` carries only `issue_id` and `trace_id`. `linear-replan` (dispatched from `linear-implement.yml:413`) carries a `prior_failure` shape and `attempt` counter — proof that the wire format already supports richer handoff, but no other workflow uses it.

**Proposed change.** Expand `client_payload` to a small, well-typed envelope:

```jsonc
{
  "issue_id": "W-NN",
  "trace_id": "xxxxxxxx",
  "approval_comment_id": "...",
  "plan_comment_id": "...",          // new: lets implement skip the "find latest plan" scan
  "attempt": 1,                       // new: implement-side replan attempt counter
  "prior_failures": ["test_failed"],  // new: shapes from previous attempts
  "conventions_digest_sha": "..."     // new: see pattern 5
}
```

Source these in the Worker (`worker/src/`) when it dispatches `linear-implement` and `linear-pickup`. Update `templates/ssot.yml` to forward all fields, bump its version so target repos re-run `init-target-repo.sh`. Workflows that don't need a field just ignore it.

**Complexity.** M — wire-format change spans Worker, three workflows, and the template stub. Mitigated by keeping new fields optional with explicit fallbacks.

**Impact.** Compounding — every other pattern in this document benefits from a richer envelope, especially patterns 4 and 5.

---

## 3. Granular progress comments

**Problem.** The current implement run posts one comment at start and one at finish. Between those, a job that takes 10+ minutes is silent. If something stalls — Linear API rate-limit, gh push retry loop, Claude stuck in an edit cycle — there is no visible signal short of opening the Actions log.

**Current gap.** `linear-implement.yml:117` posts the single in-flight comment. No subsequent status updates until the verification step.

**Proposed change.** Add structured milestone posts as *threaded replies* under the initial `⚙️ Implementing` comment (using `parentId` on `save_comment` to avoid cluttering the top-level discussion):

| Milestone | Comment body |
|---|---|
| Branch pushed | `🌿 branch wells/w-XX-slug pushed _(trace: ...)_` |
| Edits complete | `✏️ edits applied to N files _(trace: ...)_` |
| Tests passed (if a test step is added) | `✅ tests pass _(trace: ...)_` |
| PR opened | (current "Ready for review" comment) |

A new `post_milestone` shell helper in `linear-implement.yml` that wraps the existing `curl` to the Linear MCP, called between the implementation steps in the implement prompt.

**Complexity.** S — pure additive change to one workflow file; no schema or template changes.

**Impact.** Medium — significantly improves diagnosability of stalls, makes the loop feel less opaque to humans tailing Linear.

---

## 4. Pre-commit self-check

**Problem.** The current implement prompt asks the model to make changes, commit, and push without any explicit self-review pass. Common failure modes — committing only a subset of the planned files, forgetting to update a referenced workflow, leaving in a debug `console.log`, missing the `Closes W-XX` trailer — all are detectable by re-reading the diff against the plan before pushing, but the prompt never asks the model to do so.

**Current gap.** The implement prompt (the instruction block dispatched via `linear-implement.yml`) jumps directly from step 3 (`Implement per the plan`) to step 4 (`Create a branch`) to step 5 (`Commit`). No verification step against the plan or the diff.

**Proposed change.** Insert a self-check step between implementation and commit. Concretely, add to the implement instruction block:

> **3a. Self-check before committing:** Run `git diff` (and `git status` for untracked files). Confirm that (a) every item in the plan's `## Files to change` checklist has a corresponding hunk in the diff or an explicit reason for omission noted in the commit body; (b) no obvious debug output, commented-out blocks, or unrelated edits leaked in; (c) the `Verification` criteria in the plan are met by the diff. If anything is off, fix it before step 4.

Optionally codify the self-check as a separate Claude invocation (a `pre-commit-check` sub-prompt) that receives just the diff and the plan, returning a `proceed | fix-and-retry | abort` verdict. Sub-prompt cost is bounded; the leverage is high on multi-file PRs.

**Complexity.** S for the inline prompt addition; M if implemented as a separate Claude invocation with its own verification step.

**Impact.** High — directly attacks the most common class of `pr-review` `REQUEST_CHANGES` triggers (incomplete diffs, leftover debug), which would shorten the average `pr-review` ↔ `pr-fix` loop.

---

## 5. Accumulated conventions file

**Problem.** Each Claude invocation starts cold. Gotchas the loop has already discovered in this repo — "the test runner needs `WORKER_ENV=test`", "always use literal newlines in MCP arguments", "the `Stuck` state requires type `Started`" — are either re-discovered every run, or live only in `CLAUDE.md` (which a human had to remember to update).

**Current gap.** `CLAUDE.md` is the only persistent prompt-side context across runs, and it is human-maintained. There is no machine-appendable scratch pad for the loop to record learnings on its own.

**Proposed change.** Introduce `docs/agentic-conventions.md` — a structured, append-only digest the loop reads at the start of `linear-implement` and `linear-replan`, and can append to from the verification step when a failure shape is novel. Structure each entry as:

```markdown
### <YYYY-MM-DD> — <short title>
**Observed in:** <issue id / PR #>
**Lesson:** <one paragraph>
**Codified as:** <link to file changed, or "prompt-only">
```

Read path: the implement prompt pulls the file from `main` (so amendments from in-flight PRs don't pollute it) and prepends a summary to its working context. Optional `conventions_digest_sha` in `client_payload` (see pattern 2) lets a re-dispatched implement skip re-fetching when nothing changed.

Write path: only the verification step writes to the file, and only when the failure shape it observed is *not* already represented in the digest (keyword overlap check is sufficient). Append, commit on a separate branch, open a PR tagged `conventions`. The PR is reviewable by a human before the lesson becomes binding.

**Complexity.** L — touches read-side prompts, write-side verification step, a new PR flow, and needs deduplication logic to avoid the file growing without bound. Consider capping at the last N entries and rotating older ones into `docs/agentic-conventions-archive/`.

**Impact.** Compounding — the loop should get measurably better over time at the repos it touches most. Highest payoff in repos with many small issues.

---

## 6. Failure-shape taxonomy

**Problem.** `linear-implement.yml:413` already passes a `prior_failure` shape to `linear-replan`, but the shape is a free-form string. As the loop accumulates failure modes, free-form prevents clustering ("the model has hit this same DB-migration class of failure 4 times — escalate to a human") and prevents per-shape playbooks ("for shape `flaky-test`, retry rather than replan").

**Current gap.** No central enum or schema for failure shapes. Anything the verification step writes is opaque to downstream consumers.

**Proposed change.** Add `failure_shapes` to `config/pipeline.json`:

```jsonc
"failure_shapes": {
  "test_failed":        { "action": "replan", "max_attempts": 2 },
  "lint_failed":        { "action": "auto_fix", "max_attempts": 1 },
  "merge_conflict":     { "action": "escalate" },
  "push_rejected":      { "action": "retry", "max_attempts": 3 },
  "verification_miss":  { "action": "escalate" }
}
```

The verification step in each workflow tags its diagnostic comment with a shape from this set; the dispatcher (Worker or workflow) picks the next action from the table instead of always replanning. Unknown shapes default to `escalate` (flip to `Stuck`).

**Complexity.** M — config schema change, plus dispatch-logic updates in `linear-implement.yml` and the Worker's dispatch path.

**Impact.** Medium short-term, high long-term as the loop runs against more repos and accumulates a failure corpus.

---

## Cross-cutting notes

- **Stateless Worker remains intact.** Every pattern above keeps state in Linear, GitHub, or `config/pipeline.json` — none introduce a Worker-side store. Patterns 2 and 5 explicitly piggyback on the existing `client_payload` and file-in-repo mechanisms.
- **Trace IDs continue to work.** Each new comment, milestone, or appended conventions entry should embed the current trace, preserving the cross-system grep contract documented in [architecture.md](./architecture.md#2-trace-ids).
- **Verification + Stuck state continues to be the safety net.** None of these patterns should remove or weaken the `if: always()` verification step; pattern 6 in particular formalizes what that step writes.

## Suggested rollout order

1. Pattern 3 (granular progress) — pure S, no schema risk, immediate operator-experience win.
2. Pattern 4 (self-check) — S as inline prompt addition; defer the separate-Claude-invocation variant until pattern 2 lands.
3. Pattern 1 (living plan) — M, but builds confidence in MCP comment edits that pattern 5 also relies on.
4. Pattern 2 (richer envelope) — M, unblocks patterns 5 and 6.
5. Pattern 6 (failure-shape taxonomy) — needs pattern 2 in place.
6. Pattern 5 (conventions file) — L, deferred until earlier patterns demonstrate the loop is stable enough to benefit from accumulated learning rather than be confused by it.
