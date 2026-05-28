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

// Build a Linear-style webhook POST request with valid signature and a delivery
// ID header. Linear sends the freshness timestamp as `webhookTimestamp` in the
// request *body* (not a header) — this helper injects a fresh one by default
// so callers don't have to bake it into every fixture. The body is re-signed
// after any injection so verification still passes.
//
// `opts.timestamp`:
//   - omitted   → fresh Date.now() injected
//   - number    → that value injected (used for stale/future-timestamp tests)
//   - null      → no injection at all (used for missing-timestamp test)
// `opts.deliveryId`:
//   - omitted   → random delivery ID
//   - string    → that exact ID (used for dedup tests)
//   - null      → header omitted entirely (used for missing-delivery test)
export interface WebhookRequestOpts {
  body: string;
  secret?: string;
  signature?: string;
  timestamp?: number | null;
  deliveryId?: string | null;
  // When set, sent as the `Linear-Event` header (e.g. "AgentSessionEvent").
  linearEvent?: string;
}

export async function buildWebhookRequest(opts: WebhookRequestOpts): Promise<Request> {
  const secret = opts.secret ?? "test-secret";

  let body = opts.body;
  if (opts.timestamp !== null) {
    const parsed = JSON.parse(body);
    parsed.webhookTimestamp = opts.timestamp ?? Date.now();
    body = JSON.stringify(parsed);
  }

  const signature = opts.signature ?? (await signWebhookBody(body, secret));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Linear-Signature": signature,
  };
  if (opts.deliveryId !== null) {
    headers["Linear-Delivery"] = opts.deliveryId ?? `delivery-${crypto.randomUUID()}`;
  }
  if (opts.linearEvent !== undefined) {
    headers["Linear-Event"] = opts.linearEvent;
  }
  return new Request("https://worker.test/linear", {
    method: "POST",
    headers,
    body,
  });
}

// Generic Linear agentActivityCreate success response. The Worker only reads
// `agentActivityCreate.success` from these.
export function agentActivityOkResponse(): Response {
  return new Response(
    JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
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
