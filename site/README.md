# site/ — the ssot-pipeline landing page

A single static page (`index.html`, no build step, no framework) that sells the
open-source loop on its three differentiators: **human-gated · zero standing
infra · fully auditable**. Tracked in W-359.

## Aesthetic

Operations-console / blueprint: warm near-black, parchment text, a clay accent
with **sage for the human-gate** and **amber for trace IDs**. Display in Fraunces,
chrome and code in IBM Plex Mono, body in IBM Plex Sans. The motif is the loop
rendered as a live trace, with the merge gate highlighted.

## Local preview

```sh
cd site && python3 -m http.server 8788
# open http://localhost:8788
```

## Deploy to Cloudflare Pages

Fits the existing stack (the Worker already lives on Cloudflare). Two options:

- **Dashboard:** Cloudflare → Workers & Pages → Create → Pages → connect the repo,
  set **build output directory** to `site/` and **no build command**.
- **Wrangler:**
  ```sh
  npx wrangler pages deploy site --project-name ssot-pipeline
  ```

`_headers` applies a strict CSP + security headers automatically on Pages.

## Editing

Everything is in `index.html` (inline CSS + a few lines of vanilla JS for scroll
reveals and the copy-to-clipboard button). Update the comparison table and copy as
the landscape moves; keep claims honest and ours-forward. Replace the GitHub URLs
if the repo moves or goes public under a different handle.
