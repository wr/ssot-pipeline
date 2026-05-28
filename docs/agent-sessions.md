# Linear Agent Sessions (W-243)

Linear's native **Agent Sessions** let a user delegate or @mention the `@claude` app on an issue; Linear opens an "agent session" with a first-class working/waiting/done UI and a threaded activity stream (thought / action / response / elicitation / error). This is the native alternative to driving the loop off the custom `Todo (AI)` state + plan-comment → 👍 convention.

## Status: foundation shipped, dormant by default

This repo ships the **Worker-side foundation** behind the `agent_sessions_enabled` config flag (**default `false`**). Nothing changes in the running loop until you both flip the flag **and** do the one-time Linear-side app setup below. The richer "activities fully replace the plan-comment → 👍 UX" migration is intentionally **not** done yet — see [Deferred](#deferred).

What the foundation does when enabled: on an `AgentSessionEvent` with `action: "created"` (a delegation/@mention), the Worker acks with a `thought` activity, bridges the issue into the existing loop by firing `linear-pickup`, and posts a `response` activity telling the user a plan is coming. A `prompted` event carrying `agentActivity.signal === "stop"` is treated as a stop (no-op). An issue whose project isn't in `project_to_repo` gets an `error` activity instead of silence.

Because Agent Sessions arrive on the **same** `/linear` webhook with the **same** `Linear-Signature` / `Linear-Delivery` / `webhookTimestamp`, the existing HMAC verification, freshness window, and per-delivery dedup all apply unchanged. Activities are posted with the **same** `LINEAR_APP_TOKEN` used for reactions — no new secret.

## One-time setup to activate

1. **Give the `@claude` Linear app agent capabilities.** In the Linear app's settings (the OAuth app behind `LINEAR_APP_TOKEN`, `actor=app`), enable the agent capabilities and add the `app:assignable` and `app:mentionable` scopes. This requires a workspace admin and re-consent. (A separate app also works, but reusing `@claude` keeps one token/identity.)
2. **Enable the webhook category.** On the same app's webhook (already pointed at the Worker's `/linear`), turn on the **"Agent session events"** category so `AgentSessionEvent` deliveries start arriving.
3. **Flip the flag.** Set `"agent_sessions_enabled": true` in `config/pipeline.json`, commit, and redeploy the Worker (`cd worker && npm run deploy`). The Worker serves config at `GET /config`, so workflows pick it up too.
4. **Try it.** Delegate an issue (in a mapped project) to `@claude`, or @mention it. You should see a `thought` activity within a few seconds, a `linear-pickup` run fire, and a `response` activity. The plan still lands as the usual plan comment on the issue.

To roll back: set the flag to `false` and redeploy (or just disable the webhook category). The handler returns immediately when the flag is off.

## Deferred

The foundation **bridges** Agent Sessions into the existing comment-based loop; it does not yet replace that UX. Out of scope here, as follow-ups:

- **Activities instead of comments.** Have `linear-pickup` / `linear-implement` stream their progress as agent activities (and post the plan as an `elicitation` the user approves in-session) instead of plain Linear comments + the 👍 reaction. This changes the human approval experience and is a Worker↔workflow contract change — worth deciding deliberately.
- **`prompted` follow-ups.** Non-stop `prompted` events (a user replying mid-session with more guidance) are currently logged but not acted on. Wiring them to `linear-replan` (or feeding them into an in-flight implement) is the natural next step.
- **Session lifecycle states.** Linear manages `pending`/`active`/`awaitingInput`/`complete`/`stale` from emitted activities; we currently emit a minimal thought→response. Richer activity emission (per workflow step) would make the native UI more informative.

## API reference (as of 2026-05)

- Webhook header `Linear-Event: AgentSessionEvent`; top-level `{ action, agentSession, agentActivity, promptContext }` (the entity is under `agentSession`, **not** `data`). `promptContext` is a top-level XML string; the same data is also structured under `agentSession.issue` / `agentSession.comment`.
- Linear **auto-creates** the session on delegation/@mention and sends `action: "created"`; the Worker is purely reactive (no create mutation needed).
- Post progress with the `agentActivityCreate` GraphQL mutation — input `{ agentSessionId, content }`, where `content` is one of `thought {body}` / `response {body}` / `elicitation {body}` / `error {body}` / `action {action, parameter, result?}`.
- SLA: respond to the webhook HTTP request within ~5s and emit the first activity within ~10s of `created`, or the session is marked unresponsive. The Worker satisfies this by returning 200 immediately and doing the ack/dispatch in `ctx.waitUntil`.

Sources: [Agent Interaction](https://linear.app/developers/agent-interaction), [Agents getting started](https://linear.app/developers/agents), [Webhooks](https://linear.app/developers/webhooks).
