# Linear Agent Sessions (W-243)

Linear's native **Agent Sessions** let a user delegate or @mention the `@claude` app on an issue; Linear opens an "agent session" with a first-class working/waiting/done UI and a threaded activity stream (thought / action / response / elicitation / error). This is the native alternative to driving the loop off the custom `Todo (AI)` state + plan-comment → 👍 convention.

## Status: live (activated + verified 2026-05-28)

This repo ships the **Worker-side foundation** behind the `agent_sessions_enabled` config flag. It was **activated** in this deployment (`agent_sessions_enabled: true`) and verified end-to-end: delegating an issue to `@claude` fires the bridge → `linear-pickup` → plan, with thought/response activities in the session. Set the flag back to `false` (and redeploy) to disable. The richer "activities fully replace the plan-comment → 👍 UX" migration is intentionally **not** done yet — see [Deferred](#deferred).

What the foundation does when enabled: on an `AgentSessionEvent` with `action: "created"` (a delegation/@mention), the Worker acks with a `thought` activity, bridges the issue into the existing loop by firing `linear-pickup`, and posts a `response` activity telling the user a plan is coming. A `prompted` event carrying `agentActivity.signal === "stop"` is treated as a stop (no-op). An issue whose project isn't in `project_to_repo` gets an `error` activity instead of silence.

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

The foundation **bridges** Agent Sessions into the existing comment-based loop; it does not yet replace that UX. Out of scope here, as follow-ups:

- **Activities instead of comments.** Have `linear-pickup` / `linear-implement` stream their progress as agent activities (and post the plan as an `elicitation` the user approves in-session) instead of plain Linear comments + the 👍 reaction. This changes the human approval experience and is a Worker↔workflow contract change — worth deciding deliberately.
- **`prompted` follow-ups.** Non-stop `prompted` events (a user replying mid-session with more guidance) are currently logged but not acted on. Wiring them to `linear-replan` (or feeding them into an in-flight implement) is the natural next step.
- **Session lifecycle states.** Linear manages `pending`/`active`/`awaitingInput`/`complete`/`stale` from emitted activities; we currently emit a minimal thought→response. Richer activity emission (per workflow step) would make the native UI more informative.

## API reference (as of 2026-05)

- Webhook header `Linear-Event: AgentSessionEvent`; top-level `{ action, agentSession, agentActivity, promptContext }` (the entity is under `agentSession`, **not** `data`). `promptContext` is a top-level XML string; the same data is also structured under `agentSession.issue` / `agentSession.comment`.
- Linear **auto-creates** the session on delegation/@mention and sends `action: "created"`; the Worker is purely reactive (no create mutation needed).
- The `agentSession` carries `issueId` and an `issue` object, but the issue's **project is not inlined**. Resolve it with a Linear `issue(id){ identifier project { id } }` query before repo routing — the Worker does this in `fetchIssueProject`. (Routing on a missing project was the activation's second bug.)
- Post progress with the `agentActivityCreate` GraphQL mutation — input `{ agentSessionId, content }`, where `content` is one of `thought {body}` / `response {body}` / `elicitation {body}` / `error {body}` / `action {action, parameter, result?}`.
- SLA: respond to the webhook HTTP request within ~5s and emit the first activity within ~10s of `created`, or the session is marked unresponsive. The Worker satisfies this by returning 200 immediately and doing the ack/dispatch in `ctx.waitUntil`.

Sources: [Agent Interaction](https://linear.app/developers/agent-interaction), [Agents getting started](https://linear.app/developers/agents), [Webhooks](https://linear.app/developers/webhooks).
