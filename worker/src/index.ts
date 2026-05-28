import config from "../../config/pipeline.json";
import { DedupDO } from "./dedup-do";

// Re-export so wrangler can find the Durable Object class via the worker entrypoint.
export { DedupDO };

export interface Env {
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_APP_TOKEN: string;
  GITHUB_DISPATCH_TOKEN: string;
  DEDUP: DurableObjectNamespace;
}

const CONFIG_JSON = JSON.stringify(config);

// Webhook freshness window. HMAC verifies *who* signed the payload but says
// nothing about *when* — so a captured signed payload would be replayable
// forever. Require the body's `webhookTimestamp` (UNIX ms) to be within ±5min
// of wall-clock, matching Stripe's industry-standard tolerance. The same
// window applies to clock skew in either direction.
const WEBHOOK_FRESHNESS_MS = 5 * 60 * 1000;

// Structured-log helper. Emits one JSON object per line so Cloudflare Logpush /
// `wrangler tail` can filter on `trace` natively (e.g. `jq 'select(.trace=="abc12345")'`)
// instead of grepping string templates. The 8-char trace ID stays human-readable
// — it's just one field on the JSON envelope. See W-144.
//
// `level` maps to console.log/warn/error so existing Cloudflare log routing on
// severity still works. `event` is a short snake_case verb (e.g. "dispatch_fired",
// "dedup_hit") that you can filter on as a stable key. `fields` carries arbitrary
// per-event context — keep keys consistent across call sites where possible.
export type LogLevel = "info" | "warn" | "error";
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = { level, event, ...fields };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (req.method === "GET" && url.pathname === "/config") {
      return new Response(CONFIG_JSON, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/linear") {
      return handleLinearWebhook(req, env, ctx);
    }

    if (req.method === "GET" && url.pathname === "/verify") {
      return handleVerify(url, env);
    }

    return new Response("not found", { status: 404 });
  },
};

// --- Handler helpers ---------------------------------------------------------
//
// Three patterns repeat across the issue / comment / reaction handlers.
// Extracted here so future additions touch one place.

// Resolve a Linear projectId to a configured GitHub repo, or null if either
// the project is missing or has no mapping. Logs a contextual skip message
// in either case using `label` (e.g. "issue W-42", "comment 0123…").
export function resolveRepo(projectId: string | undefined, label: string, trace: string): string | null {
  if (!projectId) {
    log("info", "resolve_repo_skip", { trace, label, reason: "no_project" });
    return null;
  }
  const repo = lookupRepo(projectId);
  if (!repo) {
    log("info", "resolve_repo_skip", { trace, label, reason: "no_mapping", project_id: projectId });
    return null;
  }
  return repo;
}

// Decide whether an Issue.update event represents an actual state transition
// (vs. a different field changing while the issue already sits in this state).
// Returns true when the event should be processed, false when it should be
// skipped (and logs the skip reason at the call site label).
//
// Defensive: when `updatedFrom` is absent entirely (null/undefined), we fire
// anyway — better one extra plan than zero. We log it so any regressions in
// Linear's webhook payload shape are visible. `create` events have no
// `updatedFrom` and always count as a transition.
export function isStateTransition(event: LinearEvent, label: string, trace: string): boolean {
  if (event.action !== "update") return true;
  const uf = event.updatedFrom;
  if (uf === undefined || uf === null) {
    log("info", "state_transition_missing_updated_from", { trace, label, decision: "fire" });
    return true;
  }
  if (!("state" in uf) && !("stateId" in uf)) {
    log("info", "state_transition_skip", {
      trace,
      label,
      reason: "no_state_change",
      updated_from_keys: Object.keys(uf),
    });
    return false;
  }
  return true;
}

async function handleLinearWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.text();
  const signature = req.headers.get("Linear-Signature") ?? "";
  const linearEvent = req.headers.get("Linear-Event") ?? "";

  if (!(await verifySignature(body, signature, env.LINEAR_WEBHOOK_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }

  // Parse first — freshness comes from the body's `webhookTimestamp` field,
  // not a header (Linear doesn't send one). Parse failure is 400, distinct
  // from the 401 replay-protection rejections below.
  let event: LinearEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Freshness check — after HMAC succeeds, reject replays. Missing field is
  // a hard reject so attackers can't simply strip it to opt out.
  const ts = event.webhookTimestamp;
  if (ts === undefined || ts === null) {
    log("warn", "webhook_reject", { reason: "missing_webhook_timestamp" });
    return new Response("missing webhookTimestamp", { status: 401 });
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    log("warn", "webhook_reject", { reason: "malformed_webhook_timestamp", value: ts });
    return new Response("invalid webhookTimestamp", { status: 401 });
  }
  const skew = Math.abs(Date.now() - ts);
  if (skew > WEBHOOK_FRESHNESS_MS) {
    log("warn", "webhook_reject", {
      reason: "stale_webhook_timestamp",
      skew_ms: skew,
      max_ms: WEBHOOK_FRESHNESS_MS,
      ts,
    });
    return new Response("stale webhookTimestamp", { status: 401 });
  }

  const trace = crypto.randomUUID().slice(0, 8);

  // Persistent dedup keyed by Linear-Delivery (a UUIDv4 per delivery). Linear
  // is at-least-once; without this, two reaction/comment events arriving 200ms
  // apart both pass HMAC + freshness and both fire repository_dispatch. See W-137.
  const deliveryId = req.headers.get("Linear-Delivery");
  if (!deliveryId) {
    log("warn", "webhook_reject", { trace, reason: "missing_delivery_id" });
    return new Response("missing Linear-Delivery", { status: 400 });
  }

  // Per-delivery DO instance — each ID maps to its own DO, no global bottleneck.
  const dedupStub = env.DEDUP.get(env.DEDUP.idFromName(deliveryId));
  let alreadySeen = false;
  try {
    const dedupResp = await dedupStub.fetch("https://dedup/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryId }),
    });
    if (dedupResp.ok) {
      const dedupData = (await dedupResp.json()) as { seen?: boolean };
      alreadySeen = dedupData.seen === true;
    } else {
      // Fail-open: if the DO call fails, log loudly and proceed rather than
      // dropping a real event. updatedFrom + in-workflow checks still help.
      log("error", "dedup_do_bad_status", { trace, status: dedupResp.status, action: "proceed" });
    }
  } catch (err) {
    log("error", "dedup_do_error", {
      trace,
      action: "proceed",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }

  if (alreadySeen) {
    log("info", "dedup_hit", {
      trace,
      delivery_id: deliveryId,
      event_type: event.type,
      event_action: event.action,
    });
    return new Response(JSON.stringify({ deduped: true, trace }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  log("info", "webhook_received", {
    trace,
    delivery_id: deliveryId,
    event_type: event.type,
    event_action: event.action,
  });

  try {
    if (linearEvent === "AgentSessionEvent" || isAgentSessionPayload(event)) {
      // Native Linear Agent Sessions (W-243). Same endpoint + HMAC + dedup;
      // routed here before the data-change switch because the payload carries
      // `agentSession` and has no `type`. Returns fast — the slow ack/dispatch
      // work runs in ctx.waitUntil to meet Linear's ~5s ack / ~10s activity SLA.
      handleAgentSessionEvent(event as unknown as AgentSessionEvent, env, trace, ctx);
      return new Response("ok");
    }
    if (event.type === "Issue" && (event.action === "update" || event.action === "create")) {
      await handleIssueUpdate(event, env, trace);
    } else if (event.type === "Reaction" && event.action === "create") {
      await handleReactionCreate(event, env, trace);
    } else if (event.type === "Comment" && event.action === "create") {
      await handleCommentCreate(event, env, trace);
    } else {
      log("info", "webhook_ignored", { trace, event_type: event.type, event_action: event.action });
    }
    return new Response("ok");
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log("error", "handler_error", { trace, message: msg });
    return new Response(`handler error: ${msg}`, { status: 500 });
  }
}

export async function verifySignature(
  body: string,
  signatureHex: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = bytesToHex(new Uint8Array(sig));
  return timingSafeEqual(expected, signatureHex);
}

async function handleIssueUpdate(event: LinearEvent, env: Env, trace: string): Promise<void> {
  const issue = event.data as LinearIssue;
  const stateName = issue.state?.name;
  const issueProjectId = issue.projectId || issue.project?.id;

  if (stateName === config.todo_ai_state) {
    // Dedupe: only fire on the *transition into* Todo (AI), not on every update
    // while the issue sits there. Linear sends multiple events for a new issue
    // (create + updates as project/priority/etc. settle) — without this, each
    // one re-fires pickup and we get duplicate Plan comments.
    if (!isStateTransition(event, `issue ${issue.identifier}`, trace)) {
      return;
    }

    const repo = resolveRepo(issueProjectId, `issue ${issue.identifier}`, trace);
    if (!repo) return;

    log("info", "dispatch_decision", {
      trace,
      issue_id: issue.identifier,
      event_type: "linear-pickup",
      action: event.action,
    });
    await fireDispatch(repo, "linear-pickup", { issue_id: issue.identifier, trace_id: trace }, env, trace);

    try {
      await postReaction({ issueId: issue.id }, config.approval_ack_emoji, env, trace);
    } catch (err) {
      log("error", "ack_reaction_failed", {
        trace,
        target: "issue",
        issue_id: issue.identifier,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  } else if (stateName === config.in_progress_state) {
    // Human manually moved issue to In Progress — treat as plan approval.
    // Gate on actorId to prevent the workflow's own "Flip to In Progress" step
    // (which runs under the Linear app token) from looping back here.
    if (!event.actorId || !(config.approved_user_ids as string[]).includes(event.actorId)) {
      log("info", "in_progress_skip", {
        trace,
        issue_id: issue.identifier,
        reason: "non_approved_actor",
        actor_id: event.actorId ?? null,
      });
      return;
    }

    // Must be an actual state transition, not a different field update.
    if (!isStateTransition(event, `issue ${issue.identifier} (In Progress)`, trace)) {
      return;
    }

    const repo = resolveRepo(issueProjectId, `issue ${issue.identifier}`, trace);
    if (!repo) return;

    log("info", "dispatch_decision", {
      trace,
      issue_id: issue.identifier,
      event_type: "linear-implement",
      reason: "manual_in_progress",
      actor_id: event.actorId,
    });
    await fireDispatch(repo, "linear-implement", { issue_id: issue.identifier, trace_id: trace }, env, trace);
  } else {
    log("info", "issue_state_not_actionable", {
      trace,
      issue_id: issue.identifier,
      state: stateName ?? null,
    });
  }
}

async function handleReactionCreate(event: LinearEvent, env: Env, trace: string): Promise<void> {
  const reaction = event.data as LinearReaction;

  if (!(config.approval_emojis as string[]).includes(reaction.emoji)) return;
  if (!config.approved_user_ids.includes(reaction.userId)) return;
  if (!reaction.commentId) return;

  const comment = await fetchComment(reaction.commentId, env);
  if (!comment) {
    log("info", "reaction_skip", {
      trace,
      reason: "comment_fetch_failed",
      comment_id: reaction.commentId,
    });
    return;
  }

  if (!comment.body.startsWith(config.plan_marker)) {
    log("info", "reaction_skip", {
      trace,
      reason: "non_plan_comment",
      comment_id: reaction.commentId,
    });
    return;
  }

  const issueId = comment.issue?.identifier;
  const projectId = comment.issue?.project?.id;
  if (!issueId || !projectId) {
    log("info", "reaction_skip", {
      trace,
      reason: "missing_issue_or_project",
      comment_id: reaction.commentId,
    });
    return;
  }

  const repo = resolveRepo(projectId, `reaction on issue ${issueId}`, trace);
  if (!repo) return;

  await fireDispatch(repo, "linear-implement", { issue_id: issueId, trace_id: trace }, env, trace);

  // Best-effort 🤖 ack on the plan comment so the user gets immediate visible
  // confirmation. Errors are logged but never bubble.
  try {
    await postReaction({ commentId: reaction.commentId }, config.approval_ack_emoji, env, trace);
  } catch (err) {
    log("error", "ack_reaction_failed", {
      trace,
      target: "comment",
      comment_id: reaction.commentId,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

async function handleCommentCreate(event: LinearEvent, env: Env, trace: string): Promise<void> {
  const comment = event.data as LinearComment;

  if (!comment.userId || !config.approved_user_ids.includes(comment.userId)) {
    log("info", "comment_skip", {
      trace,
      reason: "non_approved_user",
      user_id: comment.userId ?? null,
    });
    return;
  }

  if (!comment.parentId) {
    log("info", "comment_skip", { trace, reason: "top_level_no_parent" });
    return;
  }

  const parent = await fetchComment(comment.parentId, env);
  if (!parent) {
    log("info", "comment_skip", {
      trace,
      reason: "parent_fetch_failed",
      parent_id: comment.parentId,
    });
    return;
  }

  if (!parent.body.startsWith(config.plan_marker)) {
    log("info", "comment_skip", {
      trace,
      reason: "reply_to_non_plan",
      parent_id: comment.parentId,
    });
    return;
  }

  const issueId = parent.issue?.identifier;
  const projectId = parent.issue?.project?.id;
  if (!issueId || !projectId) {
    log("info", "comment_skip", {
      trace,
      reason: "missing_issue_or_project",
      parent_id: comment.parentId,
    });
    return;
  }

  const repo = resolveRepo(projectId, `Comment.create on issue ${issueId}`, trace);
  if (!repo) return;

  const isApproval = (config.approval_phrases as string[]).some((phrase) => matchesApprovalPhrase(comment.body, phrase));

  if (isApproval) {
    log("info", "dispatch_decision", {
      trace,
      issue_id: issueId,
      event_type: "linear-implement",
      reason: "approval_phrase",
      comment_id: comment.id,
    });
    await fireDispatch(repo, "linear-implement", { issue_id: issueId, approval_comment_id: comment.id, trace_id: trace }, env, trace);
    return;
  }

  log("info", "dispatch_decision", {
    trace,
    issue_id: issueId,
    event_type: "linear-replan",
    comment_id: comment.id,
  });
  await fireDispatch(repo, "linear-replan", { issue_id: issueId, comment_id: comment.id, trace_id: trace }, env, trace);

  try {
    await postReaction({ commentId: comment.id }, config.approval_ack_emoji, env, trace);
  } catch (err) {
    log("error", "ack_reaction_failed", {
      trace,
      target: "comment",
      comment_id: comment.id,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

// --- Agent Sessions (W-243) --------------------------------------------------
//
// Linear's native Agent Sessions: when an issue is delegated to / @mentions the
// @claude app, Linear auto-creates an agent session and POSTs an
// AgentSessionEvent to this same /linear endpoint (same Linear-Signature /
// Linear-Delivery / webhookTimestamp, so the HMAC + freshness + per-delivery
// dedup in handleLinearWebhook all apply unchanged). Progress is reported back
// with agentActivityCreate using the same LINEAR_APP_TOKEN as reactions.
//
// This is an ADDITIVE bridge, dormant unless `config.agent_sessions_enabled` is
// true AND the Linear app has agent scopes + the "Agent session events" webhook
// category enabled (one-time Linear-side setup — see docs/agent-sessions.md).
// The full "activities replace the plan-comment→👍 UX" migration is out of
// scope here; this only bridges a delegated issue into the existing loop.

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "error"; body: string }
  | { type: "action"; action: string; parameter?: string; result?: string };

export type AgentSessionEvent = {
  action?: string; // "created" | "prompted"
  agentSession?: {
    id?: string;
    issue?: { identifier?: string; project?: { id?: string } };
  };
  agentActivity?: { body?: string; signal?: string | null };
  promptContext?: string;
  webhookTimestamp?: number;
};

// True when a parsed webhook body looks like an AgentSessionEvent. Used as a
// fallback alongside the `Linear-Event: AgentSessionEvent` header — agent
// payloads carry `agentSession` and have no `type` field.
export function isAgentSessionPayload(e: unknown): boolean {
  return typeof e === "object" && e !== null && "agentSession" in (e as Record<string, unknown>);
}

// Handle an AgentSessionEvent. Returns void synchronously (the slow ack/dispatch
// work runs in ctx.waitUntil) so the webhook responds 200 inside Linear's ~5s
// ack window and the first activity lands inside the ~10s SLA. `enabled`
// defaults to the config flag but is injectable for testing.
export function handleAgentSessionEvent(
  event: AgentSessionEvent,
  env: Env,
  trace: string,
  ctx: ExecutionContext,
  enabled: boolean = (config as { agent_sessions_enabled?: boolean }).agent_sessions_enabled === true,
): void {
  if (!enabled) {
    log("info", "agent_session_disabled", { trace, action: event.action ?? null });
    return;
  }

  const action = event.action;
  const sessionId = event.agentSession?.id;

  // A user stopping the agent arrives as a `prompted` event carrying
  // agentActivity.signal === "stop" (not action: "stopped").
  if (action === "prompted" && event.agentActivity?.signal === "stop") {
    log("info", "agent_session_stop", { trace, session_id: sessionId ?? null });
    return;
  }

  // The foundation only bridges the initial delegation (`created`). Non-stop
  // `prompted` follow-ups are logged but not yet acted on.
  if (action !== "created") {
    log("info", "agent_session_unhandled_action", { trace, action: action ?? null, session_id: sessionId ?? null });
    return;
  }

  if (!sessionId) {
    log("warn", "agent_session_no_id", { trace });
    return;
  }

  const issueId = event.agentSession?.issue?.identifier;
  const projectId = event.agentSession?.issue?.project?.id;
  const repo = resolveRepo(projectId, `agent session ${sessionId}`, trace);

  if (!repo || !issueId) {
    // Nothing to bridge to — tell the user in-session rather than going silent.
    ctx.waitUntil(
      postAgentActivity(
        sessionId,
        { type: "error", body: "This issue isn't in a project wired to the SSOT pipeline, so I can't pick it up automatically." },
        env,
        trace,
      ).catch(() => {}),
    );
    return;
  }

  log("info", "agent_session_bridge", { trace, session_id: sessionId, issue_id: issueId, event_type: "linear-pickup" });

  ctx.waitUntil(
    (async () => {
      // 1. Immediate ack so the session shows activity inside the ~10s SLA.
      await postAgentActivity(sessionId, { type: "thought", body: `Picking up ${issueId} — generating a plan.` }, env, trace);
      // 2. Bridge into the existing loop (reuses the linear-pickup dispatch path).
      await fireDispatch(repo, "linear-pickup", { issue_id: issueId, trace_id: trace }, env, trace);
      // 3. Set expectations for the human.
      await postAgentActivity(sessionId, { type: "response", body: `On it — I'll post a plan on ${issueId} shortly for your review.` }, env, trace);
    })().catch((err) =>
      log("error", "agent_session_bridge_failed", {
        trace,
        session_id: sessionId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      }),
    ),
  );
}

// Post an activity to an agent session via agentActivityCreate. Mirrors
// postReaction's error handling: logs and swallows failures (best-effort).
export async function postAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  env: Env,
  trace: string,
): Promise<void> {
  const mutation = `mutation($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) { success }
  }`;

  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation, variables: { input: { agentSessionId, content } } }),
    signal: AbortSignal.timeout(8000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    log("error", "agent_activity_failed", { trace, session_id: agentSessionId, type: content.type, status: resp.status, body: text });
    return;
  }

  let data: { data?: { agentActivityCreate?: { success?: boolean } }; errors?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    log("error", "agent_activity_bad_json", { trace, session_id: agentSessionId, body: text });
    return;
  }

  if (data.errors) {
    log("error", "agent_activity_graphql_errors", { trace, session_id: agentSessionId, errors: data.errors });
    return;
  }

  log("info", "agent_activity_posted", {
    trace,
    session_id: agentSessionId,
    type: content.type,
    success: data.data?.agentActivityCreate?.success ?? null,
  });
}

async function postReaction(
  target: { commentId: string } | { issueId: string },
  emoji: string,
  env: Env,
  trace: string,
): Promise<void> {
  const isComment = "commentId" in target;
  const id = isComment ? target.commentId : target.issueId;
  const targetLabel = isComment ? `comment ${id}` : `issue ${id}`;

  // Single mutation driven by a typed ReactionCreateInput — Linear's schema
  // accepts either commentId or issueId on the same input type, so we don't
  // need separate mutations for the two target shapes.
  const mutation = `mutation($input: ReactionCreateInput!) {
    reactionCreate(input: $input) { success }
  }`;
  const input: Record<string, string> = { emoji };
  if (isComment) input.commentId = id;
  else input.issueId = id;

  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation, variables: { input } }),
    signal: AbortSignal.timeout(8000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    log("error", "reaction_create_failed", { trace, target: targetLabel, status: resp.status, body: text });
    return;
  }

  let data: { data?: { reactionCreate?: { success?: boolean } }; errors?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    log("error", "reaction_create_bad_json", { trace, target: targetLabel, body: text });
    return;
  }

  if (data.errors) {
    log("error", "reaction_create_graphql_errors", { trace, target: targetLabel, errors: data.errors });
    return;
  }

  log("info", "reaction_posted", {
    trace,
    target: targetLabel,
    emoji,
    success: data.data?.reactionCreate?.success ?? null,
  });
}

async function fetchComment(commentId: string, env: Env): Promise<LinearComment | null> {
  const query = `
    query($id: String!) {
      comment(id: $id) {
        id
        body
        issue {
          identifier
          project { id }
        }
      }
    }`;

  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: commentId } }),
    signal: AbortSignal.timeout(8000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    log("error", "linear_fetch_comment_failed", { status: resp.status, body: text });
    return null;
  }

  let data: { data?: { comment?: LinearComment }; errors?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    log("error", "linear_fetch_comment_bad_json", { body: text });
    return null;
  }

  if (data.errors) {
    log("error", "linear_fetch_comment_graphql_errors", { errors: data.errors });
    return null;
  }

  return data.data?.comment ?? null;
}

// GET /verify?issue=W-NN&kind=pickup|implement — assert a workflow's expected
// post-conditions and return { pass, reason }. Used by the ssot-agents plugin's
// Stop hook to let the agent self-correct a wrong outcome *before* the run ends.
// This is an ADDITIVE early-correction layer: each workflow's own `if: always()`
// verify step remains the authoritative backstop (it owns the Stuck/auto-replan
// orchestration). /verify never flips state or dispatches — it only reports.
//
// Supported kinds are fully Linear-side (the Worker only has the Linear token):
//   pickup    → plan comment posted + issue in plan-review state
//   implement → GitHub PR attached + issue in in-review state
// Any other kind returns pass=true (no-op) so the hook never blocks a workflow
// it can't assert. GitHub-side kinds (pr-review/pr-fix) would need the Worker to
// gain GitHub read scope — deliberately not pursued (see W-238).
async function handleVerify(url: URL, env: Env): Promise<Response> {
  const issue = url.searchParams.get("issue") ?? "";
  const kind = url.searchParams.get("kind") ?? "";
  const json = (pass: boolean, reason: string) =>
    new Response(JSON.stringify({ pass, reason }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (!issue) return json(true, "no issue supplied — skipping verify");
  if (kind !== "pickup" && kind !== "implement") {
    return json(true, `no verifier for kind="${kind}" — skipping`);
  }

  const query = `
    query($id: String!) {
      issue(id: $id) {
        state { name }
        comments { nodes { body } }
        attachments { nodes { url } }
      }
    }`;

  let resp: Response;
  try {
    resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: issue } }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Fail-open: if we can't reach Linear, don't block the run. The workflow's
    // backstop verify still runs and owns the authoritative outcome.
    return json(true, "could not reach Linear — deferring to backstop verify");
  }

  if (!resp.ok) {
    log("error", "verify_linear_failed", { issue, kind, status: resp.status });
    return json(true, "Linear query failed — deferring to backstop verify");
  }

  const data = (await resp.json()) as {
    data?: {
      issue?: {
        state?: { name?: string };
        comments?: { nodes?: { body: string }[] };
        attachments?: { nodes?: { url: string }[] };
      };
    };
    errors?: unknown;
  };
  if (data.errors || !data.data?.issue) {
    log("error", "verify_linear_errors", { issue, kind, errors: data.errors ?? "no_issue" });
    return json(true, "Linear returned no issue — deferring to backstop verify");
  }

  const issueData = data.data.issue;
  const state = issueData.state?.name ?? "";
  const missing: string[] = [];

  if (kind === "pickup") {
    // pickup succeeds when the plan comment is posted and the issue sits in plan-review.
    const expectState = config.plan_review_state;
    const hasPlan = (issueData.comments?.nodes ?? []).some(
      (n) => typeof n.body === "string" && n.body.startsWith(config.plan_marker),
    );
    if (!hasPlan) missing.push(`no comment starting with the plan marker "${config.plan_marker}" — post the plan comment`);
    if (state !== expectState) missing.push(`issue state is "${state}" but must be "${expectState}" — set it via mcp__linear__save_issue`);
  } else {
    // implement succeeds when a GitHub PR is attached and the issue sits in in-review.
    // This is the Linear-observable core only — the workflow's backstop verify
    // additionally checks the PR head-ref pattern and the Closes-trailer, which
    // need GitHub API access the Worker doesn't have.
    const expectState = config.in_review_state;
    const hasPr = (issueData.attachments?.nodes ?? []).some(
      (a) => typeof a.url === "string" && a.url.includes("github.com") && a.url.includes("/pull/"),
    );
    if (!hasPr) missing.push("no GitHub PR attached to the issue — open the PR and attach it via mcp__linear__create_attachment");
    if (state !== expectState) missing.push(`issue state is "${state}" but must be "${expectState}" — set it via mcp__linear__save_issue`);
  }

  if (missing.length === 0) return json(true, `${kind} post-conditions met`);
  log("info", "verify_fail", { issue, kind, state });
  return json(false, missing.join("; "));
}

export function lookupRepo(projectId: string): string | null {
  return (config.project_to_repo as Record<string, string>)[projectId] ?? null;
}

// Escape regex metacharacters in a literal phrase so it can be embedded in a RegExp source.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match an approval phrase against a comment body using case-insensitive
// word-boundary semantics. Phrases that contain at least one word character
// use `\b...\b` so "ship it" matches "Ship it!" but not "shipping it" or
// "I don't think we should ship it casually". Phrases made entirely of
// non-word characters (e.g. emoji like 👍 or ✅) fall back to a plain
// case-insensitive substring check, since `\b` is defined as the boundary
// between word and non-word characters and would never match around them.
export function matchesApprovalPhrase(body: string, phrase: string): boolean {
  if (!phrase) return false;
  const hasWordChar = /\w/.test(phrase);
  if (!hasWordChar) {
    return body.toLowerCase().includes(phrase.toLowerCase());
  }
  const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i");
  return pattern.test(body);
}

async function fireDispatch(
  repo: string,
  eventType: string,
  payload: Record<string, unknown>,
  env: Env,
  trace: string,
): Promise<void> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo "${repo}"`);

  const url = `https://api.github.com/repos/${owner}/${name}/dispatches`;
  const reqInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ssot-pipeline-worker",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  };

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, { ...reqInit, signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      log("info", "dispatch_fired", { trace, repo, event_type: eventType, payload });
      return;
    }
    const text = await resp.text();
    if (attempt < maxAttempts && resp.status >= 500) {
      log("warn", "dispatch_retry", {
        trace,
        repo,
        event_type: eventType,
        attempt,
        status: resp.status,
        backoff_ms: 500,
      });
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    throw new Error(`Dispatch to ${repo} (${eventType}) failed: ${resp.status} ${text}`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type LinearEvent = {
  type: string;
  action: string;
  actorId?: string;
  data: unknown;
  updatedFrom?: Record<string, unknown> | null;
  webhookTimestamp?: number;
};

type LinearIssue = {
  id: string;
  identifier: string;
  projectId?: string;
  project?: { id?: string };
  state?: { name?: string };
};

type LinearReaction = {
  emoji: string;
  userId: string;
  commentId?: string;
};

type LinearComment = {
  id: string;
  body: string;
  parentId?: string;
  userId?: string;
  issue?: {
    identifier?: string;
    project?: { id?: string };
  };
};
