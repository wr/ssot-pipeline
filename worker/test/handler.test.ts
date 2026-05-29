// Worker test harness — covers HMAC signature, freshness window, approval-phrase
// word-boundary regex, resolveRepo, DO dedup, and the agent-session dispatch
// pipeline (the only remaining inbound path after the legacy Todo(AI)/reaction/
// comment handlers were retired).

import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import {
  handleAgentSessionEvent,
  isAgentSessionPayload,
  log,
  lookupRepo,
  matchesApprovalPhrase,
  postAgentActivity,
  resolveRepo,
  verifySignature,
  type AgentSessionEvent,
  type Env,
} from "../src/index";
import {
  agentActivityOkResponse,
  buildWebhookRequest,
  githubDispatchOkResponse,
  installFetchMock,
  signWebhookBody,
} from "./helpers";

// JSON fixtures — kept as strings so we can sign them byte-for-byte.
import agentSessionCreated from "./fixtures/webhook_agent_session_created.json";

const SECRET = "test-secret";
const SSOT_REPO = "wr/ssot-pipeline";
const SSOT_PROJECT_ID = "f9eb7447-31fb-4e02-b46b-7d147f2d0f55";
const PLAN_MARKER_LINE = "### 📋 Plan";

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

describe("log helper (W-144 structured JSON)", () => {
  // Cloudflare Logpush / `wrangler tail | jq` consumers will filter on these
  // field names — pin them so silent renames break the test, not production
  // alerting rules.
  it("emits a single-line JSON object via console.log for info", () => {
    const spy = (() => {
      const captured: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
      };
      return { captured, restore: () => (console.log = orig) };
    })();

    try {
      log("info", "dispatch_fired", { trace: "abc12345", repo: "wr/foo", event_type: "linear-pickup" });
      expect(spy.captured.length).toBe(1);
      const parsed = JSON.parse(spy.captured[0]!);
      expect(parsed.level).toBe("info");
      expect(parsed.event).toBe("dispatch_fired");
      expect(parsed.trace).toBe("abc12345");
      expect(parsed.repo).toBe("wr/foo");
      expect(parsed.event_type).toBe("linear-pickup");
    } finally {
      spy.restore();
    }
  });

  it("routes warn to console.warn and error to console.error", () => {
    const captured: { warn: string[]; error: string[] } = { warn: [], error: [] };
    const origW = console.warn;
    const origE = console.error;
    console.warn = (...args: unknown[]) => { captured.warn.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { captured.error.push(args.map(String).join(" ")); };

    try {
      log("warn", "dispatch_retry", { attempt: 2 });
      log("error", "handler_error", { trace: "deadbeef", message: "boom" });
      expect(captured.warn.length).toBe(1);
      expect(captured.error.length).toBe(1);
      expect(JSON.parse(captured.warn[0]!).event).toBe("dispatch_retry");
      expect(JSON.parse(captured.error[0]!).message).toBe("boom");
    } finally {
      console.warn = origW;
      console.error = origE;
    }
  });
});

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
    const body = JSON.stringify({ ...agentSessionCreated, webhookTimestamp: Date.now() });
    const req = new Request("https://worker.test/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Delivery": "delivery-no-sig",
      },
      body,
    });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("rejects with 401 for a bad signature", async () => {
    const body = JSON.stringify(agentSessionCreated);
    const req = await buildWebhookRequest({ body, signature: "deadbeef" });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("rejects with 401 when webhookTimestamp is missing from the body", async () => {
    const body = JSON.stringify(agentSessionCreated);
    const req = await buildWebhookRequest({ body, timestamp: null });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
    expect(await resp.text()).toBe("missing webhookTimestamp");
  });

  it("rejects with 401 for a stale webhookTimestamp (>5min old)", async () => {
    const body = JSON.stringify(agentSessionCreated);
    const staleTs = Date.now() - 10 * 60 * 1000; // 10 min ago
    const req = await buildWebhookRequest({ body, timestamp: staleTs });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
    expect(await resp.text()).toBe("stale webhookTimestamp");
  });

  it("rejects with 401 for a far-future webhookTimestamp (>5min ahead)", async () => {
    const body = JSON.stringify(agentSessionCreated);
    const futureTs = Date.now() + 10 * 60 * 1000;
    const req = await buildWebhookRequest({ body, timestamp: futureTs });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("rejects with 400 when Linear-Delivery is missing", async () => {
    const body = JSON.stringify(agentSessionCreated);
    const req = await buildWebhookRequest({ body, deliveryId: null });
    // Mock outbound — this should fail before reaching dispatch but be safe.
    const mock = installFetchMock([
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("linear.app"), respond: () => agentActivityOkResponse() },
    ]);
    cleanupFetch = mock.restore;
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(400);
  });
});

describe("POST /linear — DO dedup", () => {
  it("two webhooks with the same Linear-Delivery → second is deduped, only one dispatch", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("linear.app"), respond: () => agentActivityOkResponse() },
    ]);
    cleanupFetch = mock.restore;

    // Pre-bake webhookTimestamp into the body so both requests share an
    // identical signed body (buildWebhookRequest would otherwise inject a
    // fresh ts on each call, mismatching the signatures). Uses the agent fixture
    // + AgentSessionEvent header — the only remaining inbound dispatch path.
    const body = JSON.stringify({ ...agentSessionCreated, webhookTimestamp: Date.now() });
    const sig = await signWebhookBody(body, SECRET);
    const deliveryId = `delivery-dedup-${crypto.randomUUID()}`;
    const headers = {
      "Content-Type": "application/json",
      "Linear-Signature": sig,
      "Linear-Delivery": deliveryId,
      "Linear-Event": "AgentSessionEvent",
    };

    const req1 = new Request("https://worker.test/linear", { method: "POST", headers, body });
    const resp1 = await SELF.fetch(req1);
    expect(resp1.status).toBe(200);

    const req2 = new Request("https://worker.test/linear", { method: "POST", headers, body });
    const resp2 = await SELF.fetch(req2);
    expect(resp2.status).toBe(200);
    const json2 = (await resp2.json()) as { deduped?: boolean };
    expect(json2.deduped).toBe(true);

    const dispatches = mock.calls.filter((c) => c.url.includes("api.github.com/repos"));
    expect(dispatches.length).toBe(1);
  });
});

// --- AgentSessionEvent (W-243) ----------------------------------------------
// The native Linear Agent Sessions bridge. Dormant unless agent_sessions_enabled
// is true; the enabled-path tests call handleAgentSessionEvent directly with a
// capturing ExecutionContext so we can await the waitUntil ack/dispatch work.

describe("AgentSessionEvent (W-243)", () => {
  // Fake ExecutionContext that captures waitUntil promises so tests can await
  // the background ack/dispatch work the handler schedules.
  function capturingCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { promises.push(p); },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    return { ctx, settled: async () => { await Promise.all(promises); } };
  }
  const fakeEnv = { LINEAR_APP_TOKEN: "linear-token", GITHUB_DISPATCH_TOKEN: "gh-token" } as unknown as Env;
  const agentActivityOk = agentActivityOkResponse;

  it("isAgentSessionPayload detects agent payloads by presence of agentSession", () => {
    expect(isAgentSessionPayload({ agentSession: { id: "x" } })).toBe(true);
    expect(isAgentSessionPayload({ type: "Issue", action: "create" })).toBe(false);
    expect(isAgentSessionPayload(null)).toBe(false);
  });

  it("enabled=false → dormant: no waitUntil work, no calls", () => {
    // Dormant behavior is asserted via explicit flag injection, NOT the ambient
    // config value — so flipping agent_sessions_enabled on in config never breaks
    // this test (it did, once: the deploy gate caught it).
    const mock = installFetchMock([{ match: () => true, respond: () => githubDispatchOkResponse() }]);
    cleanupFetch = mock.restore;
    const { ctx } = capturingCtx();
    handleAgentSessionEvent(agentSessionCreated as unknown as AgentSessionEvent, fakeEnv, "t", ctx, false);
    expect(mock.calls.length).toBe(0);
  });

  it("AgentSessionEvent webhook is routed end-to-end and returns 200", async () => {
    // Flag-independent: a stop-signal event is a no-op under any flag value, so
    // this exercises the Linear-Event header routing + HMAC/freshness/dedup path
    // end-to-end without depending on whether the feature is currently enabled.
    const mock = installFetchMock([{ match: () => true, respond: () => githubDispatchOkResponse() }]);
    cleanupFetch = mock.restore;
    const body = JSON.stringify({ action: "prompted", agentSession: { id: "s-route" }, agentActivity: { signal: "stop" } });
    const req = await buildWebhookRequest({ body, linearEvent: "AgentSessionEvent" });
    const resp = await SELF.fetch(req);
    expect(resp.status).toBe(200);
    expect(mock.calls.find((c) => c.url.includes("api.github.com/repos"))).toBeUndefined();
  });

  it("created (enabled) → thought ack, fires linear-pickup, then response", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("api.github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();

    handleAgentSessionEvent(agentSessionCreated as unknown as AgentSessionEvent, fakeEnv, "trace123", ctx, true);
    await settled();

    const dispatch = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatch).toBeDefined();
    const dispatched = JSON.parse(dispatch!.body!);
    expect(dispatched.event_type).toBe("linear-pickup");
    expect(dispatched.client_payload.issue_id).toBe("W-300");
    expect(dispatched.client_payload.agent_session_id).toBe("agent-session-test");

    const activities = mock.calls.filter(
      (c) => c.url.includes("api.linear.app/graphql") && c.body!.includes("agentActivityCreate"),
    );
    expect(activities.length).toBe(2);
    expect(JSON.parse(activities[0]!.body!).variables.input.content.type).toBe("thought");
    expect(JSON.parse(activities[1]!.body!).variables.input.content.type).toBe("response");
  });

  // W-280: dispatch auth via a GitHub App installation token instead of a PAT.
  // Throwaway 2048-bit RSA test key (PKCS#8) — never used outside these tests.
  const TEST_PKCS8_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDl114jT2cx3Y6k
d1rBwoE5ByNjf+WDSpMUNXOOgz+mV2v4LyQQKBi20xLnGbVCxcP/yfZk6aA8FM1o
lITOCOho7yonr/VLA4n4FJBI8uDjdQC8Wzhn4qaU/Yu1X5giugT75MRuSFDS1Z5F
XDn5XhuH7xupMTyyUpIEdTx6+T17NVPe/enXvQ8LrEldD/1cTXnDmuHi10soLX6m
22SEyY97JpbZFbYaGFiJC+1u1E3g20wyyborSB/QU4KQGZ/4LWjvXRhWJltJMYo2
kXK/DeDV7+5pr33Yqy6MaZv7A9NERKXLheXZDqRFE7JFn1Rzf4eT9d8GyQLtJQZD
vpd8NsNZAgMBAAECggEAAQW1tft+7oJZRZMAVNdMIthMyH8DotNclxzrwCkGSfOe
l9KB2w6KmZmTvnJnU340snkP/v/pBgtjpIDwnEf+3KSfr+CA+03vOarBv4lRBcH5
+FyBgjjIW+ZKzko4D4N7TTGFzCXHMkDf/Nf9rAXGopKmMVj2N6bVXm61D6j3JIqk
hbshPLSWqFc1Vu1Q7eeWMiKOPrOs5MjdqxRX7fAkokzbkida/AO16luQPhMQ8q7X
cuEfZ8UBdCKGgR/XMoxSfaKqJy45maXcMusYU5L+zLihD8qbrbITbuhOzWL3S8Xf
La+SwAbsK1qk4IfSVh/RkM7qDPia1Imfk7T1/Mg89wKBgQD5dRZ2n3kyXWWkCpLJ
+z9czUcW99cUv9bD5FNIB0GSgc7X79fa163YZ5WRII3mtUwjjoVuIBJ7GunQlURr
SyfQ1FJrxbwpHtagdmWtsU22P4kS9PHe8th4gqWydc7rx0SgBX4S6kzIyHhWfGXw
U75cShzjj6EF1DSB22G+DPPzvwKBgQDr3pK68GeM00ddoPPi1BZeMdM9TI2Fe257
k4lruL9ApXr80LdeOlc9w/NrHUNPPU7u7Kgp41QvV+a3/uvBui2E0nPOgujaBDAD
2kJjbFC+YHQ4nd4kHq8HuhM04E42UWGMFwtkoOIty89ozlGorCILj67zqYRgNfYg
AELFdhau5wKBgQC/l9VT8HHmY+Nv1YseRLFKtoM2Oc5gqmLp+5CXTrNnMfnK0fRo
qaRlBFHUsDssiexbltgWV9253Vbdk/eDrKp88sYG7kzxDDVt8uFvQTFdm3jNLYIj
aUMnc7iN03vEjTzA5tcI8hldUNNUIaEtrzQSr/12LddPocdeQT/V9x7bAwKBgQDL
sp4ZX4Ct99DMJTI6lFr04ibB65jUzDIv+sxVAWn51G+QYlfZwpyRNObFfLIifpnq
cOsRsceEU29nO3ozBixFZtKoaBncHn2w9g8befGJWBdGxd+QZgdWrvXjVkt1UXbi
2wv1zZNHZZorsvKGrpGAVogK2jz+Mdvq6w6/JSqVxQKBgQDw4Cltyb+qGszSjD5D
94WppTOdB0t3DISHFo7Mn2c/OUtHjArJ4KiKp6e8l2LRvsnrGTpfHjJZrvltVRY3
2LAUxx77NbOprWDYsnpkbauPpfZDIO2nDqXUR12D4+i7sO8IF4aSwX1kAQ/xEHTM
3xsCpz5AlOsDEoRQ6HIDJMeiKw==
-----END PRIVATE KEY-----`;

  it("created with App creds → mints an installation token and dispatches with it (W-280)", async () => {
    const appEnv = {
      LINEAR_APP_TOKEN: "linear-token",
      DISPATCH_APP_ID: "3849589",
      DISPATCH_APP_PRIVATE_KEY: TEST_PKCS8_KEY,
    } as unknown as Env;
    const mock = installFetchMock([
      // Order matters: /access_tokens before /installation ("installations" contains "installation").
      { match: (u) => u.includes("/access_tokens"), respond: () => new Response(JSON.stringify({ token: "minted-app-token" }), { status: 201, headers: { "Content-Type": "application/json" } }) },
      { match: (u) => u.includes("/dispatches"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("/installation"), respond: () => new Response(JSON.stringify({ id: 4242 }), { status: 200, headers: { "Content-Type": "application/json" } }) },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();

    handleAgentSessionEvent(agentSessionCreated as unknown as AgentSessionEvent, appEnv, "trace280", ctx, true);
    await settled();

    // It looked up the installation and minted a token (no static PAT in env).
    expect(mock.calls.some((c) => c.url.includes("/installation"))).toBe(true);
    expect(mock.calls.some((c) => c.url.includes("/access_tokens"))).toBe(true);
    // The dispatch used the freshly-minted App token.
    const dispatch = mock.calls.find((c) => c.url.includes("/repos/") && c.url.includes("/dispatches"));
    expect(dispatch).toBeDefined();
    expect(dispatch!.headers.Authorization).toBe("Bearer minted-app-token");
    expect(JSON.parse(dispatch!.body!).event_type).toBe("linear-pickup");
  });

  it("created without App creds → falls back to the GITHUB_DISPATCH_TOKEN PAT (W-280)", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("/dispatches"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();

    handleAgentSessionEvent(agentSessionCreated as unknown as AgentSessionEvent, fakeEnv, "traceFallback", ctx, true);
    await settled();

    // No App creds → no installation/token minting; PAT used directly.
    expect(mock.calls.some((c) => c.url.includes("/installation"))).toBe(false);
    const dispatch = mock.calls.find((c) => c.url.includes("/dispatches"));
    expect(dispatch!.headers.Authorization).toBe("Bearer gh-token");
  });

  it("prompted with stop signal → no-op (no dispatch, no activity)", () => {
    const mock = installFetchMock([{ match: () => true, respond: () => githubDispatchOkResponse() }]);
    cleanupFetch = mock.restore;
    const { ctx } = capturingCtx();
    handleAgentSessionEvent(
      { action: "prompted", agentSession: { id: "s1" }, agentActivity: { signal: "stop" } },
      fakeEnv,
      "t",
      ctx,
      true,
    );
    expect(mock.calls.length).toBe(0);
  });

  it("prompted (enabled, no stop) → comments the reply, fires linear-replan", async () => {
    const mock = installFetchMock([
      {
        match: (u, init) => u.includes("api.linear.app/graphql") && typeof init?.body === "string" && init.body.includes("commentCreate"),
        respond: () => new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "cmt-1" } } } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      },
      { match: (u) => u.includes("api.github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();
    handleAgentSessionEvent(
      { action: "prompted", agentSession: { id: "s-p", issueId: "uuid-1", issue: { identifier: "W-260", project: { id: SSOT_PROJECT_ID } } }, agentActivity: { body: "also handle the edge case", signal: null } },
      fakeEnv,
      "t",
      ctx,
      true,
    );
    await settled();

    const comment = mock.calls.find((c) => c.url.includes("api.linear.app/graphql") && c.body!.includes("commentCreate"));
    expect(comment).toBeDefined();
    expect(JSON.parse(comment!.body!).variables.input.issueId).toBe("uuid-1");
    const dispatch = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatch).toBeDefined();
    const d = JSON.parse(dispatch!.body!);
    expect(d.event_type).toBe("linear-replan");
    expect(d.client_payload.issue_id).toBe("W-260");
    expect(d.client_payload.comment_id).toBe("cmt-1");
    expect(d.client_payload.agent_session_id).toBe("s-p");
  });

  it("prompted with an approval phrase → fires linear-implement (no comment, no replan)", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("api.github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();
    handleAgentSessionEvent(
      { action: "prompted", agentSession: { id: "s-a", issueId: "uuid-2", issue: { identifier: "W-270", project: { id: SSOT_PROJECT_ID } } }, agentActivity: { body: "approve", signal: null } },
      fakeEnv,
      "t",
      ctx,
      true,
    );
    await settled();

    const dispatch = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatch).toBeDefined();
    const d = JSON.parse(dispatch!.body!);
    expect(d.event_type).toBe("linear-implement");
    expect(d.client_payload.issue_id).toBe("W-270");
    expect(d.client_payload.agent_session_id).toBe("s-a");
    // Approval path doesn't create a comment or fire replan.
    expect(mock.calls.find((c) => c.body && c.body.includes("commentCreate"))).toBeUndefined();
  });

  it("prompted approval nested under agentActivity.content.body → fires linear-implement", async () => {
    // Real Linear payload nests the reply text under content.body (not flat .body).
    const mock = installFetchMock([
      { match: (u) => u.includes("api.github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();
    handleAgentSessionEvent(
      { action: "prompted", agentSession: { id: "s-b", issueId: "uuid-3", issue: { identifier: "W-280", project: { id: SSOT_PROJECT_ID } } }, agentActivity: { content: { type: "prompt", body: "approve" } } },
      fakeEnv,
      "t",
      ctx,
      true,
    );
    await settled();
    const dispatch = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatch).toBeDefined();
    expect(JSON.parse(dispatch!.body!).event_type).toBe("linear-implement");
  });

  it("created for an unmapped project → posts an error activity, no dispatch", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("api.github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();
    handleAgentSessionEvent(
      { action: "created", agentSession: { id: "s2", issue: { identifier: "W-301", project: { id: "00000000-0000-0000-0000-000000000000" } } } },
      fakeEnv,
      "t",
      ctx,
      true,
    );
    await settled();
    expect(mock.calls.find((c) => c.url.includes("api.github.com/repos"))).toBeUndefined();
    const err = mock.calls.find((c) => c.url.includes("api.linear.app/graphql") && c.body!.includes("\"type\":\"error\""));
    expect(err).toBeDefined();
    expect(JSON.parse(err!.body!).variables.input.content.type).toBe("error");
  });

  it("created without inline project → fetches it from Linear, then bridges", async () => {
    const mock = installFetchMock([
      {
        match: (u, init) => u.includes("api.linear.app/graphql") && typeof init?.body === "string" && init.body.includes("issue(id:"),
        respond: () => new Response(JSON.stringify({ data: { issue: { identifier: "W-250", project: { id: SSOT_PROJECT_ID } } } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      },
      { match: (u) => u.includes("api.github.com"), respond: () => githubDispatchOkResponse() },
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    const { ctx, settled } = capturingCtx();
    // Payload has the issue identifier but NO inline project (the real-world shape).
    handleAgentSessionEvent({ action: "created", agentSession: { id: "s3", issue: { identifier: "W-250" } } }, fakeEnv, "t", ctx, true);
    await settled();

    const issueQuery = mock.calls.find((c) => c.url.includes("api.linear.app/graphql") && c.body!.includes("issue(id:"));
    expect(issueQuery).toBeDefined();
    const dispatch = mock.calls.find((c) => c.url.includes("api.github.com/repos"));
    expect(dispatch).toBeDefined();
    expect(JSON.parse(dispatch!.body!).client_payload.issue_id).toBe("W-250");
  });

  it("postAgentActivity posts agentActivityCreate with the content input", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("api.linear.app/graphql"), respond: () => agentActivityOk() },
    ]);
    cleanupFetch = mock.restore;
    await postAgentActivity("sess-9", { type: "thought", body: "hi" }, fakeEnv, "tr");
    expect(mock.calls.length).toBe(1);
    const b = JSON.parse(mock.calls[0]!.body!);
    expect(b.query).toContain("agentActivityCreate");
    expect(b.variables.input.agentSessionId).toBe("sess-9");
    expect(b.variables.input.content).toEqual({ type: "thought", body: "hi" });
  });
});

// --- GET /config + /health sanity -------------------------------------------

describe("GET /config", () => {
  it("returns the pipeline config as JSON", async () => {
    const resp = await SELF.fetch("https://worker.test/config");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    const cfg = (await resp.json()) as Record<string, unknown>;
    expect(cfg.plan_marker).toBe(PLAN_MARKER_LINE);
    expect((cfg.project_to_repo as Record<string, string>)[SSOT_PROJECT_ID]).toBe(SSOT_REPO);
  });
});

describe("GET /version", () => {
  it("returns the pipeline config version as JSON", async () => {
    const resp = await SELF.fetch("https://worker.test/version");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    const body = (await resp.json()) as { version: number };
    expect(body.version).toBe(1);
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const resp = await SELF.fetch("https://worker.test/health");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });
});

// --- GET /verify (W-233 additive Stop-hook early-verify) --------------------
// /verify only reports {pass, reason}; it never flips state or dispatches. The
// plugin's Stop hook calls it to let the agent self-correct before finishing.
// It fails OPEN (pass=true) on any error so it can never wedge a run — the
// workflow's if:always() verify step remains the authoritative backstop.
describe("GET /verify — pickup post-conditions", () => {
  const linearIssue = (stateName: string, commentBodies: string[]): Response =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            state: { name: stateName },
            comments: { nodes: commentBodies.map((b) => ({ body: b })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("passes when the plan is posted and the issue is in Plan Review", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("linear.app"), respond: () => linearIssue("Plan Review", [`${PLAN_MARKER_LINE}\nthe plan body`]) },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=pickup");
    expect(resp.status).toBe(200);
    const v = (await resp.json()) as { pass: boolean; reason: string };
    expect(v.pass).toBe(true);
  });

  it("fails with an actionable reason when the plan is missing and the state is wrong", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("linear.app"), respond: () => linearIssue("Planning", ["a normal comment, no marker"]) },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=pickup");
    const v = (await resp.json()) as { pass: boolean; reason: string };
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("plan marker");
    expect(v.reason).toContain("Plan Review");
  });

  it("no-ops (pass) for a kind it can't verify yet, without querying Linear", async () => {
    const mock = installFetchMock([
      { match: () => true, respond: () => { throw new Error("should not fetch for unknown kind"); } },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=pr-review");
    const v = (await resp.json()) as { pass: boolean };
    expect(v.pass).toBe(true);
    expect(mock.calls.find((c) => c.url.includes("linear.app"))).toBeUndefined();
  });

  it("fails open (pass) when Linear returns errors, deferring to the backstop", async () => {
    const mock = installFetchMock([
      {
        match: (u) => u.includes("linear.app"),
        respond: () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=pickup");
    const v = (await resp.json()) as { pass: boolean };
    expect(v.pass).toBe(true);
  });
});

describe("GET /verify — implement post-conditions", () => {
  const linearIssueAttach = (stateName: string, urls: string[]): Response =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            state: { name: stateName },
            comments: { nodes: [] },
            attachments: { nodes: urls.map((u) => ({ url: u })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("passes when a GitHub PR is attached and the issue is in In Review", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("linear.app"), respond: () => linearIssueAttach("In Review", ["https://github.com/wr/ssot-pipeline/pull/99"]) },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=implement");
    const v = (await resp.json()) as { pass: boolean };
    expect(v.pass).toBe(true);
  });

  it("fails with reasons when no PR is attached and the state is wrong", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("linear.app"), respond: () => linearIssueAttach("In Progress", ["https://example.com/not-a-pr"]) },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=implement");
    const v = (await resp.json()) as { pass: boolean; reason: string };
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("PR attached");
    expect(v.reason).toContain("In Review");
  });

  it("flags only the state when a PR is attached but the state is wrong", async () => {
    const mock = installFetchMock([
      { match: (u) => u.includes("linear.app"), respond: () => linearIssueAttach("Done", ["https://github.com/wr/ssot-pipeline/pull/100"]) },
    ]);
    cleanupFetch = mock.restore;

    const resp = await SELF.fetch("https://worker.test/verify?issue=W-1&kind=implement");
    const v = (await resp.json()) as { pass: boolean; reason: string };
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("In Review");
    expect(v.reason).not.toContain("PR attached");
  });
});
