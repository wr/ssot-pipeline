// Worker test harness — covers the Wave-2 surfaces that previously had zero
// automated coverage: HMAC signature, freshness window, approval-phrase
// word-boundary regex, isStateTransition, resolveRepo, DO dedup, and the
// full dispatch routing pipeline driven by canned Linear webhook fixtures.

import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import {
  isStateTransition,
  lookupRepo,
  matchesApprovalPhrase,
  resolveRepo,
  verifySignature,
} from "../src/index";
import {
  buildWebhookRequest,
  githubDispatchOkResponse,
  installFetchMock,
  linearCommentResponse,
  linearReactionSuccessResponse,
  signWebhookBody,
} from "./helpers";

// JSON fixtures — kept as strings so we can sign them byte-for-byte.
import issueCreateTodoAi from "./fixtures/webhook_issue_create_todo_ai.json";
import issueUpdateIntoTodoAi from "./fixtures/webhook_issue_update_into_todo_ai.json";
import issueUpdateAlreadyTodoAi from "./fixtures/webhook_issue_update_already_todo_ai.json";
import issueUpdateUnmappedProject from "./fixtures/webhook_issue_update_unmapped_project.json";
import reactionThumbsup from "./fixtures/webhook_reaction_thumbsup.json";
import reactionWrongUser from "./fixtures/webhook_reaction_wrong_user.json";
import commentShipIt from "./fixtures/webhook_comment_ship_it.json";
import commentReplan from "./fixtures/webhook_comment_replan.json";

const SECRET = "test-secret";
const SSOT_REPO = "wr/ssot-pipeline";
const SSOT_PROJECT_ID = "f9eb7447-31fb-4e02-b46b-7d147f2d0f55";
const PLAN_MARKER_LINE = "### 📋 Plan • react 👍 to approve";

// Always restore fetch between tests so a broken stub from one test doesn't
// leak into another.
let cleanupFetch: (() => void) | null = null;
afterEach(() => {
  if (cleanupFetch) {
    cleanupFetch();
    cleanupFetch = null;
  }
});

// --- Pure-function unit tests ------------------------------------------------

describe("matchesApprovalPhrase", () => {
  it("matches a phrase with word boundaries and case-insensitively", () => {
    expect(matchesApprovalPhrase("Looks good!", "looks good")).toBe(true);
    expect(matchesApprovalPhrase("lgtm 🚀", "lgtm")).toBe(true);
    expect(matchesApprovalPhrase("LGTM", "lgtm")).toBe(true);
  });

  it("rejects substrings that are not at word boundaries", () => {
    // The whole point of W-141 — "looks good" inside a longer sentence should
    // still match (word boundaries), but "looking good" should NOT match the
    // phrase "looks good" because "looks" is a prefix of "looking".
    expect(matchesApprovalPhrase("looking good", "looks good")).toBe(false);
    // And "shipping" must not match "ship".
    expect(matchesApprovalPhrase("we're shipping it later", "ship it")).toBe(false);
  });

  it("matches emoji phrases via substring fallback", () => {
    // \\b doesn't help around non-word characters, so emoji phrases fall back
    // to a plain case-insensitive substring check.
    expect(matchesApprovalPhrase("👍", "👍")).toBe(true);
    expect(matchesApprovalPhrase("Great work 👍", "👍")).toBe(true);
    expect(matchesApprovalPhrase("✅ done", "✅")).toBe(true);
  });

  it("treats negations as approval (caveat documented)", () => {
    // The regex is intentionally simple — word-boundary, not semantic. A
    // negated approval ("I don't think this looks good") will match. This is
    // fine because @wells is the only approved actor and won't type that;
    // the test pins the behavior so future changes are deliberate.
    expect(matchesApprovalPhrase("I don't think this looks good", "looks good")).toBe(true);
  });

  it("returns false for empty phrase", () => {
    expect(matchesApprovalPhrase("ship it", "")).toBe(false);
  });
});

describe("isStateTransition", () => {
  const trace = "test1234";

  it("returns true for create events (no updatedFrom)", () => {
    expect(
      isStateTransition({ type: "Issue", action: "create", data: {} }, "issue X-1", trace),
    ).toBe(true);
  });

  it("returns true for update events whose updatedFrom includes state/stateId", () => {
    expect(
      isStateTransition(
        { type: "Issue", action: "update", data: {}, updatedFrom: { stateId: "old" } },
        "issue X-1",
        trace,
      ),
    ).toBe(true);
    expect(
      isStateTransition(
        { type: "Issue", action: "update", data: {}, updatedFrom: { state: { name: "Backlog" } } },
        "issue X-1",
        trace,
      ),
    ).toBe(true);
  });

  it("returns false for update events whose updatedFrom lacks state", () => {
    // This is the dedup that keeps Linear's flurry of updates while an issue
    // sits in Todo (AI) from re-firing pickup.
    expect(
      isStateTransition(
        { type: "Issue", action: "update", data: {}, updatedFrom: { priority: 3 } },
        "issue X-1",
        trace,
      ),
    ).toBe(false);
  });

  it("defensively returns true when updatedFrom is missing entirely", () => {
    // If Linear's payload shape changes and updatedFrom drops, fire anyway —
    // an extra plan beats a silent miss.
    expect(
      isStateTransition(
        { type: "Issue", action: "update", data: {} },
        "issue X-1",
        trace,
      ),
    ).toBe(true);
  });
});

describe("resolveRepo / lookupRepo", () => {
  it("returns the configured repo for a known projectId", () => {
    expect(lookupRepo(SSOT_PROJECT_ID)).toBe(SSOT_REPO);
    expect(resolveRepo(SSOT_PROJECT_ID, "test", "trace1")).toBe(SSOT_REPO);
  });

  it("returns null for an unknown projectId", () => {
    expect(lookupRepo("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(resolveRepo("00000000-0000-0000-0000-000000000000", "test", "trace2")).toBeNull();
  });

  it("returns null when projectId is missing", () => {
    expect(resolveRepo(undefined, "test", "trace3")).toBeNull();
  });
});

describe("verifySignature", () => {
  it("returns true for a valid HMAC over the body", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signWebhookBody(body, SECRET);
    await expect(verifySignature(body, sig, SECRET)).resolves.toBe(true);
  });

  it("returns false for a tampered body", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signWebhookBody(body, SECRET);
    await expect(verifySignature(body + "tamper", sig, SECRET)).resolves.toBe(false);
  });

  it("returns false for an empty signature", async () => {
    await expect(verifySignature("{}", "", SECRET)).resolves.toBe(false);
  });

  it("returns false when secret mismatches", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signWebhookBody(body, "other-secret");
    await expect(verifySignature(body, sig, SECRET)).resolves.toBe(false);
  });
});

// --- End-to-end webhook tests via SELF.fetch --------------------------------

describe("POST /linear — signature + freshness gate", () => {
  it("rejects with 401 when signature is missing", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const req = new Request("https://worker.test/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Delivery-Timestamp": String(Date.now()),
        "Linear-Delivery-Id": "delivery-no-sig",
      },
      body,
    });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("rejects with 401 for a bad signature", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const req = await buildWebhookRequest({ body, signature: "deadbeef" });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("rejects with 401 when Linear-Delivery-Timestamp is missing", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const req = await buildWebhookRequest({ body, timestamp: null });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
    expect(await resp.text()).toBe("missing timestamp");
  });

  it("rejects with 401 for a stale timestamp (>5min old)", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const staleTs = Date.now() - 10 * 60 * 1000; // 10 min ago
    const req = await buildWebhookRequest({ body, timestamp: staleTs });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
    expect(await resp.text()).toBe("stale timestamp");
  });

  it("rejects with 401 for a far-future timestamp (>5min ahead)", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const futureTs = Date.now() + 10 * 60 * 1000;
    const req = await buildWebhookRequest({ body, timestamp: futureTs });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("rejects with 400 when Linear-Delivery-Id is missing", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const req = await buildWebhookRequest({ body, deliveryId: null });
    // Mock outbound — this should fail before reaching dispatch but be safe.
    const mock = installFetchMock([
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("linear.app"), respond: () => linearReactionSuccessResponse() },
    ]);
    cleanupFetch = mock.restore;
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(400);
  });
});

describe("POST /linear — routing + dispatch", () => {
  it("Issue.create with Todo (AI) → fires linear-pickup to the mapped repo", async () => {
    const body = JSON.stringify(issueCreateTodoAi);
    const mock = installFetchMock([
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("linear.app"), respond: () => linearReactionSuccessResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);

    const dispatchCall = mock.calls.find((c) => c.url.includes("github.com"));
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall!.url).toBe(`https://api.github.com/repos/${SSOT_REPO}/dispatches`);
    expect(dispatchCall!.method).toBe("POST");
    const dispatched = JSON.parse(dispatchCall!.body!);
    expect(dispatched.event_type).toBe("linear-pickup");
    expect(dispatched.client_payload.issue_id).toBe("W-200");
    expect(dispatched.client_payload.trace_id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("Issue.update already in Todo (AI) (no state change) → no dispatch", async () => {
    const body = JSON.stringify(issueUpdateAlreadyTodoAi);
    const mock = installFetchMock([
      { match: () => true, respond: () => githubDispatchOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);

    expect(mock.calls.find((c) => c.url.includes("github.com/repos"))).toBeUndefined();
  });

  it("Issue.update for unmapped project → no dispatch", async () => {
    const body = JSON.stringify(issueUpdateUnmappedProject);
    const mock = installFetchMock([
      { match: () => true, respond: () => githubDispatchOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);
    expect(mock.calls.find((c) => c.url.includes("github.com/repos"))).toBeUndefined();
  });

  it("Reaction by non-approved user → no dispatch", async () => {
    const body = JSON.stringify(reactionWrongUser);
    const mock = installFetchMock([
      { match: () => true, respond: () => githubDispatchOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);
    expect(mock.calls.find((c) => c.url.includes("github.com/repos"))).toBeUndefined();
  });

  it("Reaction by approved user on a plan comment → fires linear-implement", async () => {
    const body = JSON.stringify(reactionThumbsup);
    const mock = installFetchMock([
      {
        match: (u, init) =>
          u.includes("linear.app") &&
          typeof init?.body === "string" &&
          init.body.includes("query") &&
          init.body.includes("comment(id:"),
        respond: () =>
          linearCommentResponse({
            id: "comment-plan-1",
            body: `${PLAN_MARKER_LINE}\n\nHere is the plan...`,
            issueIdentifier: "W-201",
            projectId: SSOT_PROJECT_ID,
          }),
      },
      {
        match: (u) => u.includes("linear.app"),
        respond: () => linearReactionSuccessResponse(),
      },
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);

    const dispatchCall = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatchCall).toBeDefined();
    const dispatched = JSON.parse(dispatchCall!.body!);
    expect(dispatched.event_type).toBe("linear-implement");
    expect(dispatched.client_payload.issue_id).toBe("W-201");
  });

  it("Comment 'ship it!' reply to a plan comment → fires linear-implement with approval_comment_id", async () => {
    const body = JSON.stringify(commentShipIt);
    const mock = installFetchMock([
      {
        match: (u, init) =>
          u.includes("linear.app") &&
          typeof init?.body === "string" &&
          init.body.includes("comment(id:"),
        respond: () =>
          linearCommentResponse({
            id: "comment-plan-1",
            body: `${PLAN_MARKER_LINE}\n\nHere is the plan...`,
            issueIdentifier: "W-201",
            projectId: SSOT_PROJECT_ID,
          }),
      },
      { match: (u) => u.includes("linear.app"), respond: () => linearReactionSuccessResponse() },
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);

    const dispatchCall = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatchCall).toBeDefined();
    const dispatched = JSON.parse(dispatchCall!.body!);
    expect(dispatched.event_type).toBe("linear-implement");
    expect(dispatched.client_payload.approval_comment_id).toBe("comment-reply-shipit");
  });

  it("Comment non-approval reply to plan → fires linear-replan", async () => {
    const body = JSON.stringify(commentReplan);
    const mock = installFetchMock([
      {
        match: (u, init) =>
          u.includes("linear.app") &&
          typeof init?.body === "string" &&
          init.body.includes("comment(id:"),
        respond: () =>
          linearCommentResponse({
            id: "comment-plan-1",
            body: `${PLAN_MARKER_LINE}\n\nHere is the plan...`,
            issueIdentifier: "W-201",
            projectId: SSOT_PROJECT_ID,
          }),
      },
      { match: (u) => u.includes("linear.app"), respond: () => linearReactionSuccessResponse() },
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    const req = await buildWebhookRequest({ body });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);

    const dispatchCall = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatchCall).toBeDefined();
    const dispatched = JSON.parse(dispatchCall!.body!);
    expect(dispatched.event_type).toBe("linear-replan");
    expect(dispatched.client_payload.comment_id).toBe("comment-reply-replan");
  });
});

describe("POST /linear — DO dedup", () => {
  it("two webhooks with the same Linear-Delivery-Id → second is deduped, only one dispatch", async () => {
    const body = JSON.stringify(issueUpdateIntoTodoAi);
    const mock = installFetchMock([
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("linear.app"), respond: () => linearReactionSuccessResponse() },
    ]);
    cleanupFetch = mock.restore;

    const deliveryId = `delivery-dedup-${crypto.randomUUID()}`;
    const sig = await signWebhookBody(body, SECRET);
    const ts = Date.now();

    const req1 = new Request("https://worker.test/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": sig,
        "Linear-Delivery-Id": deliveryId,
        "Linear-Delivery-Timestamp": String(ts),
      },
      body,
    });
    const resp1 = await SELF.fetch(req1);
    expect(resp1.status).toBe(200);

    const req2 = new Request("https://worker.test/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": sig,
        "Linear-Delivery-Id": deliveryId,
        "Linear-Delivery-Timestamp": String(ts),
      },
      body,
    });
    const resp2 = await SELF.fetch(req2);
    expect(resp2.status).toBe(200);
    const json2 = (await resp2.json()) as { deduped?: boolean };
    expect(json2.deduped).toBe(true);

    const dispatches = mock.calls.filter((c) => c.url.includes("api.github.com/repos"));
    expect(dispatches.length).toBe(1);
  });
});

// --- GET /config + /health sanity -------------------------------------------

describe("GET /config", () => {
  it("returns the pipeline config as JSON", async () => {
    const resp = await SELF.fetch("https://worker.test/config");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    const cfg = (await resp.json()) as Record<string, unknown>;
    expect(cfg.todo_ai_state).toBe("Todo (AI)");
    expect((cfg.project_to_repo as Record<string, string>)[SSOT_PROJECT_ID]).toBe(SSOT_REPO);
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const resp = await SELF.fetch("https://worker.test/health");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });
});
