export interface Env {
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_APP_TOKEN: string;
  LINEAR_PROJECT_TO_REPO: string;
  WELLS_LINEAR_USER_ID: string;
  GITHUB_DISPATCH_TOKEN: string;
  TODO_AI_STATE_NAME: string;
  PLAN_COMMENT_MARKER: string;
  APPROVAL_EMOJI: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
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

  console.log(`Webhook received: type=${event.type} action=${event.action}`);
  try {
    if (event.type === "Issue" && (event.action === "update" || event.action === "create")) {
      await handleIssueUpdate(event, env);
    } else if (event.type === "Reaction" && event.action === "create") {
      await handleReactionCreate(event, env);
    } else {
      console.log(`Ignored: ${event.type}.${event.action}`);
    }
    return new Response("ok");
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("Handler error:", msg, err);
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

async function handleIssueUpdate(event: LinearEvent, env: Env): Promise<void> {
  const issue = event.data as LinearIssue;
  const targetState = env.TODO_AI_STATE_NAME || "Todo (AI)";

  if (issue.state?.name !== targetState) {
    console.log(`Issue ${issue.identifier}: state "${issue.state?.name}" != "${targetState}", skipping`);
    return;
  }

  const projectId = issue.projectId || issue.project?.id;
  if (!projectId) {
    console.log(`Issue ${issue.identifier}: no project, skipping`);
    return;
  }

  const repo = lookupRepo(projectId, env);
  if (!repo) {
    console.log(`Issue ${issue.identifier}: no repo mapping for project ${projectId}`);
    return;
  }

  await fireDispatch(repo, "linear-pickup", { issue_id: issue.identifier }, env);
}

async function handleReactionCreate(event: LinearEvent, env: Env): Promise<void> {
  const reaction = event.data as LinearReaction;
  const approvalEmoji = env.APPROVAL_EMOJI || "+1";

  if (reaction.emoji !== approvalEmoji) return;
  if (reaction.userId !== env.WELLS_LINEAR_USER_ID) return;
  if (!reaction.commentId) return;

  const comment = await fetchComment(reaction.commentId, env);
  if (!comment) {
    console.log(`Reaction: could not fetch comment ${reaction.commentId}`);
    return;
  }

  const marker = env.PLAN_COMMENT_MARKER || "<!-- ssot:plan -->";
  if (!comment.body.startsWith(marker)) {
    console.log(`Reaction on non-plan comment ${reaction.commentId}, skipping`);
    return;
  }

  const issueId = comment.issue?.identifier;
  const projectId = comment.issue?.project?.id;
  if (!issueId || !projectId) {
    console.log(`Reaction: comment ${reaction.commentId} has no issue/project context`);
    return;
  }

  const repo = lookupRepo(projectId, env);
  if (!repo) {
    console.log(`Reaction on issue ${issueId}: no repo mapping for project ${projectId}`);
    return;
  }

  await fireDispatch(repo, "linear-implement", { issue_id: issueId }, env);
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
  } catch (e) {
    console.error(`Linear response not JSON: ${text}`);
    return null;
  }

  if (data.errors) {
    console.error(`Linear GraphQL errors:`, JSON.stringify(data.errors));
    return null;
  }

  console.log(`Fetched comment ${commentId}: bodyLen=${data.data?.comment?.body.length}, issue=${data.data?.comment?.issue?.identifier}`);
  return data.data?.comment ?? null;
}

function lookupRepo(projectId: string, env: Env): string | null {
  try {
    const mapping = JSON.parse(env.LINEAR_PROJECT_TO_REPO) as Record<string, string>;
    return mapping[projectId] ?? null;
  } catch {
    console.error("Invalid LINEAR_PROJECT_TO_REPO JSON");
    return null;
  }
}

async function fireDispatch(
  repo: string,
  eventType: string,
  payload: Record<string, unknown>,
  env: Env,
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

  console.log(`Fired ${eventType} to ${repo}`, payload);
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
