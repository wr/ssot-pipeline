import config from "../../config/pipeline.json";
import { DedupDO } from "./dedup-do";

// Re-export so wrangler can find the Durable Object class via the worker entrypoint.
export { DedupDO };

export interface Env {
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_APP_TOKEN: string;
  // Dispatch auth. Prefer a GitHub App (DISPATCH_APP_ID + PKCS#8 private key):
  // the Worker mints a short-lived installation token per dispatch, so nothing
  // expires and no rotation is ever needed (W-280). GITHUB_DISPATCH_TOKEN (a
  // fine-grained PAT) is the legacy fallback used only when App creds are unset.
  DISPATCH_APP_ID?: string;
  DISPATCH_APP_PRIVATE_KEY?: string;
  GITHUB_DISPATCH_TOKEN?: string;
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

    if (req.method === "GET" && url.pathname === "/version") {
      return new Response(JSON.stringify({ version: config.version }), {
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

async function handleLinearWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.text();
  const signature = req.headers.get("Linear-Signature") ?? "";
  const linearEvent = req.headers.get("Linear-Event") ?? "";

  if (!(await verifySignature(body, signature, env.LINEAR_WEBHOOK_SECRET))) {
    // Log which event type failed HMAC (no secret logged). Distinguishes a
    // wrong/rotated webhook secret from a second signing identity — e.g. Agent
    // Session events signed with the OAuth app's signing secret rather than the
    // workspace webhook's secret.
    log("warn", "webhook_sig_fail", { linear_event: linearEvent || null, body_len: body.length });
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
    linear_event: linearEvent || null,
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
    log("info", "webhook_ignored", { trace, event_type: event.type, event_action: event.action });
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
    issueId?: string;
    creatorId?: string;
    issue?: { id?: string; identifier?: string; project?: { id?: string } };
  };
  agentActivity?: { body?: string; signal?: string | null; content?: { body?: string; signal?: string | null; type?: string } };
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

  // A user stopping the agent arrives as a `prompted` event carrying a "stop"
  // signal. Linear nests activity fields under `.content` (flat `.signal` kept
  // as a fallback).
  const promptSignal = event.agentActivity?.content?.signal ?? event.agentActivity?.signal ?? null;
  if (action === "prompted" && promptSignal === "stop") {
    log("info", "agent_session_stop", { trace, session_id: sessionId ?? null });
    return;
  }

  // We bridge the initial delegation (`created`) and mid-session follow-ups
  // (`prompted`); anything else is logged and ignored.
  if (action !== "created" && action !== "prompted") {
    log("info", "agent_session_unhandled_action", { trace, action: action ?? null, session_id: sessionId ?? null });
    return;
  }

  if (!sessionId) {
    log("warn", "agent_session_no_id", { trace });
    return;
  }

  // The payload often omits the issue's project (and sometimes the identifier),
  // so they're resolved from Linear in the async body. agent_session_event logs
  // the actual payload shape for observability.
  const rawIssue = event.agentSession?.issue;
  log("info", "agent_session_event", {
    trace,
    session_id: sessionId,
    action,
    agent_session_keys: Object.keys(event.agentSession ?? {}),
    issue_ref: rawIssue?.identifier ?? rawIssue?.id ?? null,
    inline_project: rawIssue?.project?.id ?? null,
  });

  ctx.waitUntil(
    (async () => {
      // Immediate ack so the session shows activity inside the ~10s SLA.
      await postAgentActivity(sessionId, { type: "thought", body: "On it — taking a look at this issue." }, env, trace);

      const { issueId, projectId } = await resolveAgentSessionIssue(event, env, trace);
      const repo = projectId ? resolveRepo(projectId, `agent session ${sessionId}`, trace) : null;
      if (!repo || !issueId) {
        await postAgentActivity(
          sessionId,
          { type: "error", body: "I couldn't map this issue to a repo wired to the SSOT pipeline, so I can't act on it automatically." },
          env,
          trace,
        );
        return;
      }

      if (action === "created") {
        // Initial delegation → plan the issue.
        log("info", "agent_session_bridge", { trace, session_id: sessionId, issue_id: issueId, event_type: "linear-pickup" });
        await fireDispatch(repo, "linear-pickup", { issue_id: issueId, trace_id: trace, agent_session_id: sessionId }, env, trace);
        await postAgentActivity(sessionId, { type: "response", body: `Picking up ${issueId} — I'll post a plan shortly for your review.` }, env, trace);
        return;
      }

      // `prompted` follow-up: an approval phrase builds it (in-session approval);
      // anything else re-plans. Linear nests the reply text under
      // agentActivity.content.body (flat .body kept as a fallback).
      const promptText = (event.agentActivity?.content?.body ?? event.agentActivity?.body ?? "").trim();
      log("info", "agent_prompted_activity", {
        trace,
        session_id: sessionId,
        activity_keys: Object.keys(event.agentActivity ?? {}),
        content_keys: Object.keys(event.agentActivity?.content ?? {}),
        prompt_len: promptText.length,
      });
      if ((config.approval_phrases as string[]).some((p) => matchesApprovalPhrase(promptText, p))) {
        // Optional approval gate (OFF by default). When enforce_approved_users is
        // true, only an approved session creator may green-light implementation;
        // otherwise (default) the GitHub merge remains the real sign-off gate.
        if ((config as { enforce_approved_users?: boolean }).enforce_approved_users === true) {
          const creatorId = event.agentSession?.creatorId ?? "";
          if (!(config.approved_user_ids as string[]).includes(creatorId)) {
            log("info", "agent_session_approval_denied", { trace, session_id: sessionId, issue_id: issueId, creator_id: creatorId || null });
            await postAgentActivity(
              sessionId,
              { type: "response", body: "Approval isn't authorized — only an approved user can green-light implementation for this issue." },
              env,
              trace,
            );
            return;
          }
        }
        log("info", "agent_session_bridge", { trace, session_id: sessionId, issue_id: issueId, event_type: "linear-implement" });
        await fireDispatch(repo, "linear-implement", { issue_id: issueId, trace_id: trace, agent_session_id: sessionId }, env, trace);
        await postAgentActivity(sessionId, { type: "response", body: `Approved — building ${issueId} now. I'll open a PR for review.` }, env, trace);
        return;
      }

      // Non-approval → materialize the reply as a Linear comment and re-plan off
      // it, reusing the existing linear-replan flow (it reads the instruction
      // from a comment id). commentCreate needs the issue UUID.
      const issueUuid = event.agentSession?.issueId ?? rawIssue?.id ?? null;
      const commentId = issueUuid
        ? await postIssueComment(issueUuid, `Follow-up via agent session:\n\n${promptText || "(no additional text)"}`, env, trace)
        : null;
      if (!commentId) {
        await postAgentActivity(
          sessionId,
          { type: "error", body: "I couldn't record your follow-up to re-plan from — try commenting on the issue directly." },
          env,
          trace,
        );
        return;
      }
      log("info", "agent_session_bridge", { trace, session_id: sessionId, issue_id: issueId, event_type: "linear-replan" });
      await fireDispatch(repo, "linear-replan", { issue_id: issueId, comment_id: commentId, trace_id: trace, agent_session_id: sessionId }, env, trace);
      await postAgentActivity(sessionId, { type: "response", body: `Got it — re-planning ${issueId} with your guidance.` }, env, trace);
    })().catch((err) =>
      log("error", "agent_session_bridge_failed", {
        trace,
        session_id: sessionId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      }),
    ),
  );
}

// Resolve a Linear issue's canonical identifier + project id from an issue
// reference (identifier or UUID). Used by the agent-session bridge because the
// AgentSessionEvent payload doesn't reliably inline the project. Best-effort:
// returns nulls on any failure (caller posts an error activity).
async function fetchIssueProject(
  issueRef: string,
  env: Env,
  trace: string,
): Promise<{ identifier: string | null; projectId: string | null }> {
  const query = `query($id: String!) { issue(id: $id) { identifier project { id } } }`;
  try {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: issueRef } }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await resp.json()) as {
      data?: { issue?: { identifier?: string; project?: { id?: string } } };
    };
    const issue = data.data?.issue;
    return { identifier: issue?.identifier ?? null, projectId: issue?.project?.id ?? null };
  } catch (err) {
    log("error", "agent_issue_fetch_failed", {
      trace,
      issue_ref: issueRef,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return { identifier: null, projectId: null };
  }
}

// Resolve an agent session's issue identifier + project id, querying Linear when
// the webhook payload omits them (it usually omits the project). Shared by the
// created (→pickup) and prompted (→replan) bridges.
async function resolveAgentSessionIssue(
  event: AgentSessionEvent,
  env: Env,
  trace: string,
): Promise<{ issueId: string | null; projectId: string | null }> {
  const rawIssue = event.agentSession?.issue;
  const issueRef = rawIssue?.identifier ?? rawIssue?.id ?? null;
  let issueId = rawIssue?.identifier ?? null;
  let projectId = rawIssue?.project?.id ?? null;
  if (issueRef && (!issueId || !projectId)) {
    const fetched = await fetchIssueProject(issueRef, env, trace);
    issueId = issueId ?? fetched.identifier;
    projectId = projectId ?? fetched.projectId;
  }
  return { issueId, projectId };
}

// Create a Linear comment on an issue (by UUID) as the agent, returning the new
// comment id. Used by the prompted-follow-up bridge to feed the user's reply
// into linear-replan (which reads its instruction from a comment). Best-effort.
async function postIssueComment(issueUuid: string, body: string, env: Env, trace: string): Promise<string | null> {
  const mutation = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
  try {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: mutation, variables: { input: { issueId: issueUuid, body } } }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await resp.json()) as { data?: { commentCreate?: { comment?: { id?: string } } }; errors?: unknown };
    if (data.errors) {
      log("error", "agent_comment_create_errors", { trace, issue_uuid: issueUuid, errors: data.errors });
      return null;
    }
    return data.data?.commentCreate?.comment?.id ?? null;
  } catch (err) {
    log("error", "agent_comment_create_failed", {
      trace,
      issue_uuid: issueUuid,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
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

// --- GitHub App dispatch auth (W-280) -------------------------------------
// Mint a short-lived installation token from a GitHub App rather than rely on
// a static PAT, so dispatch credentials never expire and never need rotating.
// Falls back to the legacy GITHUB_DISPATCH_TOKEN PAT when App creds are unset.

function pemToPkcs8Bytes(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function base64url(input: string | Uint8Array): string {
  const bin = typeof input === "string" ? input : String.fromCharCode(...input);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signAppJwt(appId: string, pkcs8Pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s for clock skew; exp well under GitHub's 10-minute max.
  const claims = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const data = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data)));
  return `${data}.${base64url(sig)}`;
}

const ghAppHeaders = (auth: string) => ({
  Authorization: `Bearer ${auth}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ssot-pipeline-worker",
});

// Mint an installation token scoped to just this repo with the perms dispatch
// needs. Throws on any non-OK response so the caller can fall back to the PAT.
async function mintInstallationToken(owner: string, name: string, jwt: string): Promise<string> {
  const instResp = await fetch(`https://api.github.com/repos/${owner}/${name}/installation`, {
    headers: ghAppHeaders(jwt),
    signal: AbortSignal.timeout(8000),
  });
  if (!instResp.ok) throw new Error(`installation lookup for ${owner}/${name} failed: ${instResp.status}`);
  const inst = (await instResp.json()) as { id: number };
  const tokResp = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: "POST",
    headers: ghAppHeaders(jwt),
    body: JSON.stringify({ repositories: [name], permissions: { contents: "write", actions: "write" } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokResp.ok) throw new Error(`installation token for ${owner}/${name} failed: ${tokResp.status}`);
  return ((await tokResp.json()) as { token: string }).token;
}

// A freshly-minted App installation token when DISPATCH_APP_* are set
// (nothing to expire at rest), else the legacy GITHUB_DISPATCH_TOKEN PAT.
async function resolveDispatchToken(owner: string, name: string, env: Env, trace: string): Promise<string> {
  if (env.DISPATCH_APP_ID && env.DISPATCH_APP_PRIVATE_KEY) {
    try {
      const jwt = await signAppJwt(env.DISPATCH_APP_ID, env.DISPATCH_APP_PRIVATE_KEY);
      return await mintInstallationToken(owner, name, jwt);
    } catch (e) {
      log("warn", "dispatch_app_token_failed", { trace, repo: `${owner}/${name}`, error: String(e) });
      // fall through to the PAT
    }
  }
  if (!env.GITHUB_DISPATCH_TOKEN) {
    throw new Error("no dispatch credentials configured (set DISPATCH_APP_ID/DISPATCH_APP_PRIVATE_KEY or GITHUB_DISPATCH_TOKEN)");
  }
  return env.GITHUB_DISPATCH_TOKEN;
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
  const dispatchToken = await resolveDispatchToken(owner, name, env, trace);
  const reqInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${dispatchToken}`,
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
  webhookTimestamp?: number;
};
