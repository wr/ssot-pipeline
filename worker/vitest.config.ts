import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Worker tests run inside the Workers runtime (Miniflare) via
// @cloudflare/vitest-pool-workers. Bindings, Durable Objects, and the
// `cloudflare:test` module are all available — see worker/test/*.test.ts.
//
// `main` points at the worker entrypoint so SELF.fetch() drives our actual
// handler and the DedupDO export is wired up automatically.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Provide test-time secrets — wrangler.toml deliberately omits these
        // (they're real wrangler secrets in prod). Values here are arbitrary
        // strings used only by the test HMAC signer and dispatch mocks.
        bindings: {
          LINEAR_WEBHOOK_SECRET: "test-secret",
          LINEAR_APP_TOKEN: "test-linear-token",
          GITHUB_DISPATCH_TOKEN: "test-github-token",
        },
      },
    }),
  ],
});
