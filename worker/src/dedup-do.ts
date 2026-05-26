// Durable Object: per-delivery webhook dedup.
//
// Linear (per industry norm) delivers webhooks at-least-once. Each delivery
// carries a unique `Linear-Delivery-Id` header. We record every ID we've seen
// with a short TTL — replays of the same delivery within the TTL window are
// reported as "seen" and the caller returns 200 without re-dispatching.
//
// One DO instance per delivery ID (`idFromName(deliveryId)`) — no global
// bottleneck. Storage is single-key per instance, so each instance lives just
// long enough to record + expire.

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — Linear retries within minutes

export class DedupDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/seen") {
      const body = (await req.json()) as { deliveryId?: string; ttlMs?: number };
      const deliveryId = body.deliveryId;
      if (!deliveryId || typeof deliveryId !== "string") {
        return new Response(JSON.stringify({ error: "missing deliveryId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const ttlMs = typeof body.ttlMs === "number" && body.ttlMs > 0 ? body.ttlMs : DEFAULT_TTL_MS;
      const seen = await this.seen(deliveryId, ttlMs);
      return new Response(JSON.stringify({ seen }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  // Atomically check-and-record. Returns true if this deliveryId was already
  // recorded within the TTL window (caller should treat as duplicate). Returns
  // false on the first sighting (and records it now).
  //
  // Lazy expiry: stale records (recordedAt + ttlMs < now) are overwritten and
  // treated as unseen. blockConcurrencyWhile guarantees the get/put pair is
  // atomic against other requests hitting the same DO instance.
  async seen(deliveryId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
    return await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const existing = (await this.state.storage.get(deliveryId)) as
        | { recordedAt: number }
        | undefined;

      if (existing && existing.recordedAt + ttlMs > now) {
        return true;
      }

      await this.state.storage.put(deliveryId, { recordedAt: now });
      return false;
    });
  }
}
