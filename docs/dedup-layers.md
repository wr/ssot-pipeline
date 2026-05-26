# Dedup layers

## Overview

Linear delivers webhooks **at-least-once** (industry norm, same as Stripe/Shopify). A
single user action in Linear can therefore reach the Worker as multiple identical
HTTP POSTs — milliseconds apart on a retry burst, or minutes apart if the first
delivery briefly errored. Without dedup, the loop would double-fire
`linear-pickup` and produce two plan comments, two reaction acks, two
implementation PRs, etc.

The pipeline has **three** layers of dedup that each catch a different failure
mode. They overlap by design — each is the only thing protecting against at
least one class of duplicate. This doc explains what each catches and why we
keep all three.

## Layer 1: HTTP-level dedup (`DedupDO`)

**Where:** `worker/src/dedup-do.ts`; called from `worker/src/index.ts`
(`handleLinearWebhook`, the `env.DEDUP` block right after signature + freshness
verification).

**Mechanism:** Every Linear webhook carries a unique `Linear-Delivery-Id`
header. The Worker routes each ID into its own Durable Object instance
(`idFromName(deliveryId)` — no global bottleneck) and atomically check-and-records
the ID under a **10-minute TTL**. If the ID is already present and unexpired,
the DO returns `seen: true` and the Worker responds `200 { deduped: true }`
without dispatching anything.

**What it catches:** Linear's at-least-once delivery retries. Two identical
deliveries of the *same* webhook (same delivery ID) arriving anywhere from
milliseconds to ~10 minutes apart. This is the most common shape of duplicate
in practice — Linear's webhook layer occasionally re-fires when it doesn't see
a fast enough 200, even when the first delivery succeeded.

**Fail mode:** Open. If the DO call errors, the Worker logs and proceeds —
better one extra plan than zero. Layers 2 and 3 still apply.

## Layer 2: Semantic dedup (`updatedFrom` guard)

**Where:** `worker/src/index.ts`, `isStateTransition()` (~line 78), called from
`handleIssueUpdate()` for both the `Todo (AI)` and `In Progress` branches.

**Mechanism:** Linear's `Issue.update` payload includes an `updatedFrom` object
listing the fields that actually changed in this update. The guard returns
`false` (skip) when the update has no `state`/`stateId` key in `updatedFrom` —
meaning the issue was already in this state and some *other* field (priority,
project, label, description, etc.) changed.

**What it catches:** Legitimately *distinct* webhook deliveries that
nevertheless represent the same logical event. Concretely: Linear sends a
flurry of `Issue.update` events when a new issue settles in (assignee gets set,
project gets attached, priority gets bumped, description edited). Each has a
unique `Linear-Delivery-Id` — so Layer 1 lets them all through — but they all
report `state.name = "Todo (AI)"`. Without this guard, every settling-update
re-fires `linear-pickup`.

`create` events have no `updatedFrom` and always count as a transition (that's
the legitimate "issue created directly in Todo (AI)" path).

**Fail mode:** Open. When `updatedFrom` is null/undefined entirely, we fire
anyway and log. Layer 3 still applies.

## Layer 3: Workflow-level dedup (plan-comment grep)

**Where:** `.github/workflows/linear-pickup.yml`, the "Skip if plan already
posted" step (~line 63).

**Mechanism:** Before invoking Claude, the workflow runs a single GraphQL
query for all comments on the issue and counts ones whose body starts with the
configured `plan_marker`. If the count is `> 0`, the workflow sets
`ALREADY_PLANNED=1`, all subsequent steps are gated `if: env.ALREADY_PLANNED
!= '1'`, and the verification step short-circuits successfully.

**What it catches:** A successful prior run from a *different* webhook delivery
that the lower layers couldn't have known about. Two distinct shapes here:

1. **First run partially crashed.** The Worker recorded the delivery ID in the
   DO, dispatched the workflow, and the workflow posted the plan comment — but
   the workflow then crashed before flipping state, or GitHub Actions itself
   failed the job. A retry comes in later (different delivery ID, fresh
   `updatedFrom` because the user re-flipped the state) and both Layer 1 and
   Layer 2 let it through. The plan-comment grep is what stops the second
   plan from being written.
2. **TTL gap.** A duplicate Linear delivery that arrives **after** the DO's
   10-minute TTL has lapsed (rare, but Linear's retry envelope is not
   formally bounded). Layer 1 has forgotten the delivery ID by then; the
   plan-comment grep still sees the original plan in the issue history.

**Fail mode:** Closed-ish — if the check itself fails the workflow exits with
an error (Linear API down). That's loud, not silent.

## Why three layers

| Failure mode | L1: DedupDO | L2: updatedFrom | L3: plan grep |
|---|:---:|:---:|:---:|
| Same `Linear-Delivery-Id` re-delivered within 10min | catches | — | — |
| Distinct deliveries, same state, different field changed (settling updates) | — | catches | catches |
| Retry after >10min TTL gap | — | depends | catches |
| First run partially completed (plan posted, state flip crashed) | — | — | catches |
| `create` event followed by an `update` while still in Todo (AI) | — | catches | catches |
| Linear webhook layer bug emits two distinct delivery IDs for one user action | — | catches (same state) | catches |

Each row has at least one column that's the *only* thing protecting against
that shape. Removing any layer regresses at least one shape.

## Decision: keep all three

We considered dropping Layer 3 once W-137 (the DedupDO) landed, on the theory
that "delivery-ID dedup makes plan-comment dedup redundant." It doesn't:

- **Layer 1 only knows about HTTP deliveries.** It can't see that GitHub
  Actions ran the workflow successfully and posted a plan. So a re-flip
  (user moves issue out of Todo (AI), then back) generates a *new* delivery
  ID with a *new* `updatedFrom.state` — both lower layers wave it through.
  Without Layer 3, that produces a second plan comment in the issue.
- **Layer 1 has a TTL.** Layer 3 reads from Linear's permanent comment
  history. They protect against duplicates on different time horizons.
- **Layer 3 is cheap.** One extra GraphQL query before invoking Claude (which
  itself burns 30+ tool calls and dollars of model cost). The cost ratio
  strongly favors checking.

The deliberate tradeoff: Layer 3 also short-circuits the "user intentionally
re-flipped to Todo (AI) for a fresh plan" path. That's a known limitation
tracked separately — the planned fix is a `retry-requested` label or
deleting the prior plan comment to opt out. Until that lands, the re-plan
path is: post a comment-reply on the existing plan describing the desired
change (which triggers `linear-replan`).

## Tracing through: a duplicate webhook delivery

Concrete walk-through. Wells flips issue W-42 to **Todo (AI)** at 10:00:00.
Linear's webhook layer re-delivers the same event at 10:00:00.200 (200ms
later) because it didn't see the Worker's 200 response in time.

**First delivery (10:00:00.000, `Linear-Delivery-Id: abc123`):**

1. HMAC verified, timestamp within 5min freshness window.
2. **Layer 1:** DedupDO for `abc123` returns `seen: false`, records it.
3. **Layer 2:** `event.action === "update"`, `updatedFrom.state` is present
   (issue moved from `Backlog` to `Todo (AI)`) — `isStateTransition` returns
   `true`.
4. Worker fires `repository_dispatch` event_type=`linear-pickup` with trace
   ID `t1`.
5. GitHub Actions starts `linear-pickup` for W-42.
6. **Layer 3:** Comments-query returns 0 plan markers — proceed.
7. Claude runs, posts plan comment, flips state to `Plan Review`. Verify
   passes.

**Second delivery (10:00:00.200, `Linear-Delivery-Id: abc123` — same ID):**

1. HMAC verified, timestamp within window.
2. **Layer 1:** DedupDO for `abc123` returns `seen: true` (recorded 200ms
   ago, well inside the 10min TTL). Worker responds `200 { deduped: true,
   trace: t2 }` and stops.
3. Layers 2 and 3 never run. No second dispatch, no second plan.

**Hypothetical third delivery (10:11:00, `Linear-Delivery-Id: xyz789` — a
new ID, e.g. Linear emitted a follow-up update because the project field
auto-populated):**

1. HMAC + freshness pass.
2. **Layer 1:** DedupDO for `xyz789` is fresh — `seen: false`, recorded.
3. **Layer 2:** `updatedFrom` is `{ "projectId": "..." }` — no `state` key.
   `isStateTransition` returns `false`. Worker logs the skip and stops.
4. Layer 3 never runs because the workflow was never dispatched.

**Hypothetical fourth delivery (11:00:00, user re-flips Backlog → Todo (AI)):**

1. HMAC + freshness pass.
2. **Layer 1:** Brand new delivery ID — `seen: false`.
3. **Layer 2:** `updatedFrom.state` present — `true`, proceed.
4. Worker fires dispatch.
5. **Layer 3:** Comments-query finds 1 plan marker (from the first delivery
   an hour ago). Workflow sets `ALREADY_PLANNED=1`, skips the Claude step,
   verify step short-circuits successfully. No second plan posted.

Each layer pulled its weight in a different scenario. None is redundant.
