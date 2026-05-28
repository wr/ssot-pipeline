# Dedup layers

## Overview

Linear delivers webhooks **at-least-once** (industry norm, same as Stripe/Shopify). A
single delegation in Linear can therefore reach the Worker as multiple identical
`AgentSessionEvent` HTTP POSTs — milliseconds apart on a retry burst, or minutes
apart if the first delivery briefly errored. Without dedup, the loop would
double-fire `linear-pickup` and produce two plan comments, two implementation
PRs, etc.

The pipeline is now **agent-session-only**: the sole entry point is a user
delegating (or @mentioning) the `@claude` app on an issue, which Linear turns
into a `created` `AgentSessionEvent`; an in-session reply becomes a `prompted`
event. The dedup story is correspondingly simpler than the old `Todo (AI)` +
👍-reaction path. **Two** layers remain, each catching a different failure mode.
They overlap by design.

## Layer 1: HTTP-level dedup (`DedupDO`)

**Where:** `worker/src/dedup-do.ts`; called from `worker/src/index.ts`
(`handleLinearWebhook`, the `env.DEDUP` block right after signature + freshness
verification). It runs for **every** inbound webhook, before the
`AgentSessionEvent` handler.

**Mechanism:** Every Linear webhook carries a unique `Linear-Delivery` header
(a UUIDv4 per delivery). The Worker routes each ID into its own Durable Object
instance (`idFromName(deliveryId)` — no global bottleneck) and atomically
check-and-records the ID under a **10-minute TTL**. If the ID is already present
and unexpired, the DO returns `seen: true` and the Worker responds
`200 { deduped: true }` without acking the session or dispatching anything.

**What it catches:** Linear's at-least-once delivery retries — two identical
deliveries of the *same* `AgentSessionEvent` (same delivery ID) arriving
anywhere from milliseconds to ~10 minutes apart. This is the most common shape
of duplicate in practice: Linear's webhook layer occasionally re-fires when it
doesn't see a fast enough 200, even when the first delivery succeeded. Because
the Worker returns 200 immediately and does the slow ack/dispatch work in
`ctx.waitUntil` (to meet the ~5s ack / ~10s activity SLA), a retry that beats
the first delivery's `waitUntil` completion is still caught by the DO record.

**Fail mode:** Open. If the DO call errors, the Worker logs and proceeds —
better one extra plan than zero. Layer 2 still applies.

## Layer 2: Workflow-level dedup (plan-comment grep)

**Where:** `.github/workflows/linear-pickup.yml`, the "Skip if plan already
posted" step.

**Mechanism:** Before invoking Claude, `linear-pickup` runs a single GraphQL
query for all comments on the issue and counts ones whose body starts with the
configured `plan_marker`. If the count is `> 0`, the workflow sets
`ALREADY_PLANNED=1`, all subsequent steps are gated `if: env.ALREADY_PLANNED
!= '1'`, and the verification step short-circuits successfully.

**What it catches:** A successful prior run from a *different* webhook delivery
that Layer 1 couldn't have known about. Two shapes:

1. **First run partially crashed.** The Worker recorded the delivery ID in the
   DO, fired `linear-pickup`, and the workflow posted the plan comment — but the
   workflow then crashed before flipping state, or GitHub Actions itself failed
   the job. A later delivery comes in with a different delivery ID and both pass
   Layer 1. The plan-comment grep is what stops a second plan from being written.
2. **TTL gap.** A duplicate Linear delivery that arrives **after** the DO's
   10-minute TTL has lapsed (rare, but Linear's retry envelope isn't formally
   bounded). Layer 1 has forgotten the delivery ID by then; the plan-comment
   grep still sees the original plan in the issue history.

(Note the plan also lands as an in-session `elicitation`; the durable signal the
grep keys on is the Linear **comment** — the same one `linear-implement` reads.)

**Fail mode:** Closed-ish — if the check itself fails the workflow exits with an
error (Linear API down). That's loud, not silent.

## Why HMAC → freshness → dedup, in that order

The two dedup layers sit downstream of two cheaper gates in
`handleLinearWebhook`, and the ordering matters:

1. **HMAC** (`Linear-Signature` vs `LINEAR_WEBHOOK_SECRET`) verifies *who* signed
   the payload. Agent events are signed by the `@claude` OAuth **app's** webhook
   secret, so this is the secret the Worker must hold (see
   [`docs/agent-sessions.md`](./agent-sessions.md)). A bad signature is rejected
   `401` before anything else runs.
2. **Freshness** (`webhookTimestamp` within ±5min) rejects replays of a payload
   that was validly signed but captured and re-sent later. HMAC alone says
   nothing about *when*.
3. **Layer 1 dedup** only runs once a delivery is authentic and fresh — no point
   spending a DO round-trip on a forged or stale request.

Layer 2 then runs inside the dispatched workflow, on a different time horizon
(Linear's permanent comment history rather than a 10-minute TTL).

## Why both layers

| Failure mode | L1: DedupDO | L2: plan grep |
|---|:---:|:---:|
| Same `Linear-Delivery` re-delivered within 10min | catches | — |
| Distinct delivery IDs for one delegation, first run partially completed (plan posted, state flip crashed) | — | catches |
| Retry after >10min TTL gap | — | catches |

Each row has at least one column that's the *only* thing protecting against that
shape. Removing either layer regresses at least one shape.

- **Layer 1 only knows about HTTP deliveries.** It can't see that GitHub Actions
  ran the workflow successfully and posted a plan, so a fresh delivery ID waves
  through. Without Layer 2, that produces a second plan comment.
- **Layer 1 has a TTL.** Layer 2 reads from Linear's permanent comment history.
  They protect against duplicates on different time horizons.
- **Layer 2 is cheap.** One extra GraphQL query before invoking Claude (which
  itself burns 30+ tool calls and dollars of model cost). The cost ratio
  strongly favors checking.

## Tracing through: a duplicate agent-session delivery

Concrete walk-through. Wells delegates issue W-42 to `@claude` at 10:00:00.
Linear's webhook layer re-delivers the same `AgentSessionEvent` at 10:00:00.200
(200ms later) because it didn't see the Worker's 200 response in time.

**First delivery (10:00:00.000, `Linear-Delivery: abc123`):**

1. HMAC verified, `webhookTimestamp` within the 5min freshness window.
2. **Layer 1:** DedupDO for `abc123` returns `seen: false`, records it.
3. Worker recognizes the `AgentSessionEvent` (`action: "created"`), acks with a
   `thought` activity, and fires `repository_dispatch` event_type=`linear-pickup`
   with trace ID `t1` (all inside `ctx.waitUntil`).
4. GitHub Actions starts `linear-pickup` for W-42.
5. **Layer 2:** Comments-query returns 0 plan markers — proceed.
6. Claude runs, posts the plan as a Linear comment + in-session elicitation, and
   flips state to `Plan Review`. Verify passes.

**Second delivery (10:00:00.200, `Linear-Delivery: abc123` — same ID):**

1. HMAC verified, timestamp within window.
2. **Layer 1:** DedupDO for `abc123` returns `seen: true` (recorded 200ms ago,
   well inside the 10min TTL). Worker responds `200 { deduped: true, trace: t2 }`
   and stops. No second ack, no second dispatch, no second plan.

**Hypothetical third delivery (10:11:00, `Linear-Delivery: xyz789` — a new ID,
e.g. Linear re-delivered after the DO's TTL lapsed):**

1. HMAC + freshness pass.
2. **Layer 1:** DedupDO for `xyz789` is fresh — `seen: false`, recorded — so it
   waves through and `linear-pickup` is dispatched again.
3. **Layer 2:** Comments-query finds 1 plan marker (from the first delivery).
   Workflow sets `ALREADY_PLANNED=1`, skips the Claude step, and the verify step
   short-circuits successfully. No second plan posted.

Each layer pulled its weight in a different scenario. Neither is redundant.
