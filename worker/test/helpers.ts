// Test helpers shared across worker test files.
//
// signWebhookBody: HMAC-SHA256-hex over the raw body using the same algorithm
// as src/index.ts:verifySignature, so we can construct webhook requests that
// pass signature verification end-to-end.

export async function signWebhookBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Build a Linear-style webhook POST request with valid signature, fresh
// timestamp, and a delivery ID. Callers may override any of those via `opts`
// to exercise edge cases (bad signature, stale timestamp, missing delivery
// ID, etc.). The default secret matches what's wired into vitest.config.ts.
export interface WebhookRequestOpts {
  body: string;
  secret?: string;
  signature?: string;
  timestamp?: number | string | null;
  deliveryId?: string | null;
}

export async function buildWebhookRequest(opts: WebhookRequestOpts): Promise<Request> {
  const secret = opts.secret ?? "test-secret";
  const signature = opts.signature ?? (await signWebhookBody(opts.body, secret));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Linear-Signature": signature,
  };
  if (opts.timestamp !== null) {
    const ts = opts.timestamp ?? Date.now();
    headers["Linear-Delivery-Timestamp"] = String(ts);
  }
  if (opts.deliveryId !== null) {
    headers["Linear-Delivery-Id"] = opts.deliveryId ?? `delivery-${crypto.randomUUID()}`;
  }
  return new Request("https://worker.test/linear", {
    method: "POST",
    headers,
    body: opts.body,
  });
}

// Build a stubbed Linear GraphQL comment-fetch response. The Worker only
// reads `body`, `issue.identifier`, and `issue.project.id` from these.
export function linearCommentResponse(args: {
  id: string;
  body: string;
  issueIdentifier?: string;
  projectId?: string;
}): Response {
  return new Response(
    JSON.stringify({
      data: {
        comment: {
          id: args.id,
          body: args.body,
          issue: {
            identifier: args.issueIdentifier,
            project: { id: args.projectId },
          },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Generic Linear reactionCreate success response.
export function linearReactionSuccessResponse(): Response {
  return new Response(
    JSON.stringify({ data: { reactionCreate: { success: true } } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Generic GitHub repository_dispatch 204 (No Content) response.
export function githubDispatchOkResponse(): Response {
  return new Response(null, { status: 204 });
}

// Record of every outbound fetch the Worker made during a test, in order.
// Each entry captures the URL, method, headers (as a plain object), and
// body text if any — enough to assert which Linear/GitHub endpoint was hit
// and with what payload.
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

// Install a fetch mock that records every call and returns from `handlers`
// matched by URL substring. Returns { calls, restore } — restore puts back
// the original global fetch.
export function installFetchMock(handlers: Array<{
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}>): { calls: CapturedRequest[]; restore: () => void } {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => (headers[k] = v));
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k] = v;
      } else {
        Object.assign(headers, rawHeaders);
      }
    }
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, headers, body });

    for (const h of handlers) {
      if (h.match(url, init)) {
        return await h.respond(url, init);
      }
    }
    throw new Error(`No fetch mock handler matched ${method} ${url}`);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
