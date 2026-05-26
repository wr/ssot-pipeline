import config from "../../config/pipeline.json";

export interface Env {
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_APP_TOKEN: string;
  GITHUB_DISPATCH_TOKEN: string;
}

const CONFIG_JSON = JSON.stringify(config);

// Webhook freshness window. HMAC verifies *who* signed the payload but says
// nothing about *when* — so a captured signed payload would be replayable
// forever. Require the Linear-Delivery-Timestamp header to be within ±5min
// of wall-clock, matching Stripe's industry-standard tolerance. The same
// window applies to clock skew in either direction.
const WEBHOOK_FRESHNESS_MS = 5 * 60 * 1000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
      return handleLinearWebhook(req, env);
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleLinearWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const signature = req.headers.get("Linear-Signature") ?? "";

  if (!(await verifySignature(body, signature, env.LINEAR_WEBHOOK_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }

  // Freshness check — after HMAC succeeds, reject replays. Missing header is
  // a hard reject so attackers can't simply strip the header to opt out.
  const tsHeader = req.headers.get("Linear-Delivery-Timestamp");
  if (!tsHeader) {
    console.warn("rejecting webhook: missing Linear-Delivery-Timestamp header");
    return new Response("missing timestamp", { status: 401 });
  }
  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) {
    console.warn(`rejecting webhook: malformed Linear-Delivery-Timestamp=${tsHeader}`);
    return new Response("invalid timestamp", { status: 401 });
  }
  const skew = Math.abs(Date.now() - ts);
  if (skew > WEBHOOK_FRESHNESS_MS) {
    console.warn(`rejecting webhook: timestamp skew ${skew}ms exceeds ${WEBHOOK_FRESHNESS_MS}ms (header=${tsHeader})`);
    return new Response("stale timestamp", { status: 401 });
  }

  let event: LinearEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const trace = crypto.randomUUID().slice(0, 8);
  console.log(`trace=${trace} received ${event.type}.${event.action}`);

  try {
    if (event.type === "Issue" && (event.action === "update" || event.action === "create")) {
      await handleIssueUpdate(event, env, trace);
    } else if (event.type === "Reaction" && event.action === "create") {
      await handleReactionCreate(event, env, trace);
    } else if (event.type === "Comment" && event.action === "create") {
      await handleCommentCreate(event, env, trace);
    } else {
      console.log(`trace=${trace} ignored: ${event.type}.${event.action}`);
    }
    return new Response("ok");
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`trace=${trace} handler error:`, msg, err);
    return new Response(`handler error: ${msg}`, { status: 500 });
  }
}

async function verifySignature(
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

  if (stateName === config.todo_ai_state) {
    // Dedupe: only fire on the *transition into* Todo (AI), not on every update
    // while the issue sits there. Linear sends multiple events for a new issue
    // (create + updates as project/priority/etc. settle) — without this, each
    // one re-fires pickup and we get duplicate Plan comments.
    if (event.action === "update") {
      const uf = event.updatedFrom;
      if (uf === undefined || uf === null) {
        // Defensive: better one extra plan than zero. Log so regressions are visible.
        console.log(`trace=${trace} issue ${issue.identifier}: update event missing updatedFrom — firing anyway`);
      } else if (!("state" in uf) && !("stateId" in uf)) {
        console.log(`trace=${trace} issue ${issue.identifier}: update without state change (updatedFrom keys: ${Object.keys(uf).join(",") || "<empty>"}), skipping`);
        return;
      }
    }

    const projectId = issue.projectId || issue.project?.id;
    if (!projectId) {
      console.log(`trace=${trace} issue ${issue.identifier}: no project, skipping`);
      return;
    }

    const repo = lookupRepo(projectId);
    if (!repo) {
      console.log(`trace=${trace} issue ${issue.identifier}: no repo mapping for project ${projectId}`);
      return;
    }

    console.log(`trace=${trace} issue ${issue.identifier}: firing linear-pickup (action=${event.action})`);
    await fireDispatch(repo, "linear-pickup", { issue_id: issue.identifier, trace_id: trace }, env, trace);

    try {
      await postReaction({ issueId: issue.id }, config.approval_ack_emoji, env, trace);
    } catch (err) {
      console.error(`trace=${trace} failed to post issue ack reaction:`, err);
    }
  } else if (stateName === config.in_progress_state) {
    // Human manually moved issue to In Progress — treat as plan approval.
    // Gate on actorId to prevent the workflow's own "Flip to In Progress" step
    // (which runs under the Linear app token) from looping back here.
    if (!event.actorId || !(config.approved_user_ids as string[]).includes(event.actorId)) {
      console.log(`trace=${trace} issue ${issue.identifier}: In Progress transition by non-approved actor ${event.actorId ?? "unknown"}, skipping`);
      return;
    }

    // Must be an actual state transition, not a different field update.
    if (event.action === "update") {
      const uf = event.updatedFrom;
      if (uf !== undefined && uf !== null && !("state" in uf) && !("stateId" in uf)) {
        console.log(`trace=${trace} issue ${issue.identifier}: In Progress update without state change (updatedFrom keys: ${Object.keys(uf).join(",") || "<empty>"}), skipping`);
        return;
      }
    }

    const projectId = issue.projectId || issue.project?.id;
    if (!projectId) {
      console.log(`trace=${trace} issue ${issue.identifier}: no project, skipping`);
      return;
    }

    const repo = lookupRepo(projectId);
    if (!repo) {
      console.log(`trace=${trace} issue ${issue.identifier}: no repo mapping for project ${projectId}`);
      return;
    }

    console.log(`trace=${trace} issue ${issue.identifier}: firing linear-implement (manual In Progress by actor ${event.actorId})`);
    await fireDispatch(repo, "linear-implement", { issue_id: issue.identifier, trace_id: trace }, env, trace);
  } else {
    console.log(`trace=${trace} issue ${issue.identifier}: state "${stateName}" not actionable, skipping`);
  }
}

async function handleReactionCreate(event: LinearEvent, env: Env, trace: string): Promise<void> {
  const reaction = event.data as LinearReaction;

  if (!(config.approval_emojis as string[]).includes(reaction.emoji)) return;
  if (!config.approved_user_ids.includes(reaction.userId)) return;
  if (!reaction.commentId) return;

  const comment = await fetchComment(reaction.commentId, env);
  if (!comment) {
    console.log(`trace=${trace} reaction: could not fetch comment ${reaction.commentId}`);
    return;
  }

  if (!comment.body.startsWith(config.plan_marker)) {
    console.log(`trace=${trace} reaction on non-plan comment ${reaction.commentId}, skipping`);
    return;
  }

  const issueId = comment.issue?.identifier;
  const projectId = comment.issue?.project?.id;
  if (!issueId || !projectId) {
    console.log(`trace=${trace} reaction: comment ${reaction.commentId} missing issue/project context`);
    return;
  }

  const repo = lookupRepo(projectId);
  if (!repo) {
    console.log(`trace=${trace} reaction on issue ${issueId}: no repo mapping for project ${projectId}`);
    return;
  }

  await fireDispatch(repo, "linear-implement", { issue_id: issueId, trace_id: trace }, env, trace);

  // Best-effort 🤖 ack on the plan comment so the user gets immediate visible
  // confirmation. Errors are logged but never bubble.
  try {
    await postReaction({ commentId: reaction.commentId }, config.approval_ack_emoji, env, trace);
  } catch (err) {
    console.error(`trace=${trace} failed to post ack reaction:`, err);
  }
}

async function handleCommentCreate(event: LinearEvent, env: Env, trace: string): Promise<void> {
  const comment = event.data as LinearComment;

  if (!comment.userId || !config.approved_user_ids.includes(comment.userId)) {
    console.log(`trace=${trace} ignored: Comment.create (userId=${comment.userId ?? "unknown"} not in approved list)`);
    return;
  }

  if (!comment.parentId) {
    console.log(`trace=${trace} ignored: Comment.create (top-level, no parentId)`);
    return;
  }

  const parent = await fetchComment(comment.parentId, env);
  if (!parent) {
    console.log(`trace=${trace} Comment.create: could not fetch parent comment ${comment.parentId}`);
    return;
  }

  if (!parent.body.startsWith(config.plan_marker)) {
    console.log(`trace=${trace} ignored: Comment.create (reply to non-plan comment ${comment.parentId})`);
    return;
  }

  const issueId = parent.issue?.identifier;
  const projectId = parent.issue?.project?.id;
  if (!issueId || !projectId) {
    console.log(`trace=${trace} Comment.create: parent comment ${comment.parentId} missing issue/project context`);
    return;
  }

  const repo = lookupRepo(projectId);
  if (!repo) {
    console.log(`trace=${trace} Comment.create: no repo mapping for project ${projectId}`);
    return;
  }

  const isApproval = (config.approval_phrases as string[]).some((phrase) => matchesApprovalPhrase(comment.body, phrase));

  if (isApproval) {
    console.log(`trace=${trace} issue ${issueId}: firing linear-implement (approval phrase in comment=${comment.id})`);
    await fireDispatch(repo, "linear-implement", { issue_id: issueId, approval_comment_id: comment.id, trace_id: trace }, env, trace);
    return;
  }

  console.log(`trace=${trace} issue ${issueId}: firing linear-replan (comment=${comment.id})`);
  await fireDispatch(repo, "linear-replan", { issue_id: issueId, comment_id: comment.id, trace_id: trace }, env, trace);

  try {
    await postReaction({ commentId: comment.id }, config.approval_ack_emoji, env, trace);
  } catch (err) {
    console.error(`trace=${trace} failed to post comment ack reaction:`, err);
  }
}

async function postReaction(
  target: { commentId: string } | { issueId: string },
  emoji: string,
  env: Env,
  trace: string,
): Promise<void> {
  const isComment = "commentId" in target;
  const mutation = isComment
    ? `mutation($id: String!, $emoji: String!) {
        reactionCreate(input: { commentId: $id, emoji: $emoji }) { success }
      }`
    : `mutation($id: String!, $emoji: String!) {
        reactionCreate(input: { issueId: $id, emoji: $emoji }) { success }
      }`;
  const id = isComment ? target.commentId : target.issueId;
  const targetLabel = isComment ? `comment ${id}` : `issue ${id}`;

  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation, variables: { id, emoji } }),
    signal: AbortSignal.timeout(8000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`trace=${trace} reactionCreate failed: ${resp.status} ${text}`);
    return;
  }

  let data: { data?: { reactionCreate?: { success?: boolean } }; errors?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`trace=${trace} reactionCreate response not JSON: ${text}`);
    return;
  }

  if (data.errors) {
    console.error(`trace=${trace} reactionCreate errors:`, JSON.stringify(data.errors));
    return;
  }

  console.log(`trace=${trace} posted ${emoji} reaction to ${targetLabel}: success=${data.data?.reactionCreate?.success}`);
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
    console.error(`Linear fetch failed: ${resp.status} ${text}`);
    return null;
  }

  let data: { data?: { comment?: LinearComment }; errors?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`Linear response not JSON: ${text}`);
    return null;
  }

  if (data.errors) {
    console.error(`Linear GraphQL errors:`, JSON.stringify(data.errors));
    return null;
  }

  return data.data?.comment ?? null;
}

function lookupRepo(projectId: string): string | null {
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
function matchesApprovalPhrase(body: string, phrase: string): boolean {
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
      console.log(`trace=${trace} fired ${eventType} to ${repo}`, payload);
      return;
    }
    const text = await resp.text();
    if (attempt < maxAttempts && resp.status >= 500) {
      console.warn(`trace=${trace} dispatch attempt ${attempt} failed (${resp.status}), retrying in 500ms`);
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

type LinearEvent = {
  type: string;
  action: string;
  actorId?: string;
  data: unknown;
  updatedFrom?: Record<string, unknown> | null;
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
