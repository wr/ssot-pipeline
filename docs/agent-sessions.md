# Linear Agent Sessions (W-243)

Linear's native **Agent Sessions** let a user delegate or @mention the `@claude` app on an issue; Linear opens an "agent session" with a first-class working/waiting/done UI and a threaded activity stream (thought / action / response / elicitation / error). This is the native alternative to driving the loop off the custom `Todo (AI)` state + plan-comment → 👍 convention.

## Status: live (activated + verified 2026-05-28)

This repo ships native Agent Sessions support behind the `agent_sessions_enabled` config flag. It was **activated** in this deployment (`agent_sessions_enabled: true`) and verified end-to-end. Set the flag back to `false` (and redeploy) to disable. The legacy `Todo (AI)` / comment+👍 path is retained in parallel (hybrid) and unchanged.

What happens when enabled:
- **`created`** (delegate / @mention): the Worker acks with a `thought` and fires `linear-pickup`; `linear-pickup` posts a `thought` at start and the finished plan as an in-session **`elicitation`** ("reply approve / request changes"). The plan also lands as the Linear comment that `linear-implement` reads.
- **`prompted`** (user replies in the session): an **approval phrase** (`approve` / `lgtm` / `ship it` / …) → fires `linear-implement`, which streams an "implementing" `thought` and a PR-ready `response` (or an `error`); any other reply → posted as a comment + fires `linear-replan`; `agentActivity.signal === "stop"` → no-op.
- An issue whose project isn't in `project_to_repo` gets an `error` activity instead of silence. The Worker resolves the issue's project from Linear when the payload omits it (`fetchIssueProject`).

Agent Sessions arrive on the same `/linear` endpoint with the same `Linear-Signature` / `Linear-Delivery` / `webhookTimestamp` shape, so the HMAC verification, freshness window, and per-delivery dedup all apply unchanged. Activities are posted with the existing `LINEAR_APP_TOKEN`.

**Critical signing-secret gotcha (learned during activation):** `AgentSessionEvent` (and `AppUserNotification`) are **app-scoped** — Linear delivers them via the **`@claude` OAuth application's own webhook**, signed with the **application's webhook signing secret**, which is *different* from any workspace-level webhook secret. So `LINEAR_WEBHOOK_SECRET` on the Worker must be the **app webhook's** signing secret (not a workspace webhook's), or agent events fail HMAC (`401`) and the handler never runs. If a separate workspace webhook also points at the Worker, delete it — otherwise its deliveries fail HMAC and spam `webhook_sig_fail` logs (harmless but noisy).

## One-time setup to activate

1. **Give the `@claude` Linear app agent capabilities.** In the OAuth app behind `LINEAR_APP_TOKEN` (`actor=app`), enable agent capabilities and add the `app:assignable` and `app:mentionable` scopes (workspace admin + re-consent).
2. **Enable the right categories on the *app's* webhook.** On the `@claude` application's **own** webhook (in the app's developer settings, pointed at the Worker's `/linear`), enable **Issues, Comments, Reactions, and Agent session events**. This single webhook should carry everything; **delete any separate workspace-level webhook** to the Worker so events aren't delivered twice (and don't 401).
3. **Point the Worker at the *app* webhook's signing secret.** `cd worker && printf %s '<app-webhook-secret>' | npx wrangler secret put LINEAR_WEBHOOK_SECRET` — use the **app webhook's** signing secret, NOT a workspace webhook secret (see the gotcha above). Verify with `npx wrangler tail`: `/linear` events should return `200`, not `401`.
4. **Flip the flag.** Set `"agent_sessions_enabled": true` in `config/pipeline.json`, commit, and push — `deploy-worker.yml` redeploys the Worker on push to `main`.
5. **Try it.** Delegate a **fresh** issue (in a mapped project) to `@claude`. Expect a `thought` activity, a `linear-pickup` run, then a `response`; the plan lands as the usual plan comment. Note: re-delegating an issue that **already** had a session does *not* re-fire `created` — use a new issue to re-test.

To roll back: set the flag to `false` and redeploy. The handler returns immediately when the flag is off.

## Deferred

The native flow above (streamed activities + plan-as-elicitation + in-session approval + `prompted`→replan) shipped in W-253 and W-254. The plan still also lands as a Linear comment so `linear-implement` can read it. Remaining follow-ups:

- **Richer per-step streaming.** Workflows emit a start `thought` + an end `response`/`error` today; finer-grained `action` activities per step (and driving Linear's `active`/`awaitingInput`/`complete` lifecycle more precisely) would make the native UI more informative.

## API reference (as of 2026-05)

- Webhook header `Linear-Event: AgentSessionEvent`; top-level `{ action, agentSession, agentActivity, promptContext }` (the entity is under `agentSession`, **not** `data`). `promptContext` is a top-level XML string; the same data is also structured under `agentSession.issue` / `agentSession.comment`.
- Linear **auto-creates** the session on delegation/@mention and sends `action: "created"`; the Worker is purely reactive (no create mutation needed).
- The `agentSession` carries `issueId` and an `issue` object, but the issue's **project is not inlined**. Resolve it with a Linear `issue(id){ identifier project { id } }` query before repo routing — the Worker does this in `fetchIssueProject`. (Routing on a missing project was the activation's second bug.)
- Post progress with the `agentActivityCreate` GraphQL mutation — input `{ agentSessionId, content }`, where `content` is one of `thought {body}` / `response {body}` / `elicitation {body}` / `error {body}` / `action {action, parameter, result?}`.
- SLA: respond to the webhook HTTP request within ~5s and emit the first activity within ~10s of `created`, or the session is marked unresponsive. The Worker satisfies this by returning 200 immediately and doing the ack/dispatch in `ctx.waitUntil`.

Sources: [Agent Interaction](https://linear.app/developers/agent-interaction), [Agents getting started](https://linear.app/developers/agents), [Webhooks](https://linear.app/developers/webhooks).
