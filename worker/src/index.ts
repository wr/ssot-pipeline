import config from "../../config/pipeline.json";

export interface Env {
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_APP_TOKEN: string;
  GITHUB_DISPATCH_TOKEN: string;
}

const CONFIG_JSON = JSON.stringify(config);

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

  if (issue.state?.name !== config.todo_ai_state) {
    console.log(`trace=${trace} issue ${issue.identifier}: state "${issue.state?.name}" != "${config.todo_ai_state}", skipping`);
    return;
  }

  // Dedupe: only fire on the *transition into* Todo (AI), not on every update
  // while the issue sits there. Linear sends multiple events for a new issue
  // (create + updates as project/priority/etc. settle) — without this, each
  // one re-fires pickup and we get duplicate Plan comments. See W-88.
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
}

async function handleReactionCreate(event: LinearEvent, env: Env, trace: string): Promise<void> {
  const reaction = event.data as LinearReaction;

  if (reaction.emoji !== config.approval_emoji) return;
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
    await postReaction(reaction.commentId, config.approval_ack_emoji, env, trace);
  } catch (err) {
    console.error(`trace=${trace} failed to post ack reaction:`, err);
  }
}

async function postReaction(commentId: string, emoji: string, env: Env, trace: string): Promise<void> {
  const mutation = `
    mutation($commentId: String!, $emoji: String!) {
      reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
        success
      }
    }`;

  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINEAR_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation, variables: { commentId, emoji } }),
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

  console.log(`trace=${trace} posted ${emoji} reaction to comment ${commentId}: success=${data.data?.reactionCreate?.success}`);
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

async function fireDispatch(
  repo: string,
  eventType: string,
  payload: Record<string, unknown>,
  env: Env,
  trace: string,
): Promise<void> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo "${repo}"`);

  const resp = await fetch(`https://api.github.com/repos/${owner}/${name}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ssot-pipeline-worker",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: payload,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dispatch to ${repo} (${eventType}) failed: ${resp.status} ${text}`);
  }

  console.log(`trace=${trace} fired ${eventType} to ${repo}`, payload);
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
  data: unknown;
  updatedFrom?: Record<string, unknown> | null;
};

type LinearIssue = {
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
  issue?: {
    identifier?: string;
    project?: { id?: string };
  };
};
