# Fork setup guide

Step-by-step walkthrough for setting up your own fork of ssot-pipeline. After this you'll have a Worker routing Linear webhooks to your target repos and the full autonomous loop running.

## 1. Fork and clone

```bash
gh repo fork wr/ssot-pipeline --clone --remote
cd ssot-pipeline
```

## 2. Edit `config/pipeline.json`

Open `config/pipeline.json` and update these fields before doing anything else:

| Field | What to set |
|---|---|
| `approved_user_ids` | Your Linear user ID. Find it: Settings → Account → Profile, or via the API (`curl -sS -X POST https://api.linear.app/graphql -H "Authorization: $LINEAR_APP_TOKEN" -H "Content-Type: application/json" -d '{"query":"{ viewer { id } }"}' \| jq -r '.data.viewer.id'`) |
| `branch_prefix` | Your preferred branch prefix, e.g. `yourname/` |
| `review_bot_login` | `<your-handle>-claude-reviewer[bot]` (the App you'll create in step 4) |
| `fix_reviewer_logins` | `["<your-handle>-claude-reviewer[bot]"]` — add your own GitHub login too if you want human-requested reviews to trigger auto-fix |
| `project_to_repo` | Clear it: `{}` — `init-target-repo.sh` populates it per project |
| `approval_emojis`, `approval_phrases`, `approval_ack_emoji` | Leave as-is or adjust to taste |

Commit the changes:

```bash
git add config/pipeline.json
git commit -m "Configure pipeline for my fork"
```

## 3. Update `wrangler.toml`

Open `worker/wrangler.toml` and change the `name` field to something unique (e.g. `yourname-ssot-pipeline`). This sets your Worker's subdomain: `yourname-ssot-pipeline.<account>.workers.dev`.

```bash
git add worker/wrangler.toml
git commit -m "Set wrangler name for my deployment"
```

## 4. Create the reviewer GitHub App

See [`docs/github-app-setup.md`](./github-app-setup.md) section 4. The App name should be `<your-handle>-claude-reviewer`. Note the App ID and download the private key `.pem`.

## 5. Deploy the Cloudflare Worker

```bash
cd worker
npx wrangler deploy
```

The deploy output prints your Worker URL — it will look like `https://<wrangler-name>.<your-cf-account>.workers.dev`. You'll need it in the next steps. The config endpoint is `<that-URL>/config`.

Set the two Worker secrets you have right now (the third — `LINEAR_WEBHOOK_SECRET` — comes from step 7):

```bash
wrangler secret put LINEAR_APP_TOKEN       # from docs/linear-app-setup.md step 2
wrangler secret put GITHUB_DISPATCH_TOKEN  # fine-grained PAT — see docs/github-app-setup.md section 2
```

## 6. Set `SSOT_WORKER_URL` on your fork (and in Keychain)

Your fork's own `.github/workflows/ssot.yml` (the dogfood caller for the meta-repo) reads `vars.SSOT_WORKER_URL`. Set it on the fork:

```bash
gh variable set SSOT_WORKER_URL --repo <your-github-login>/ssot-pipeline \
  --body 'https://<wrangler-name>.<your-cf-account>.workers.dev/config'
```

Also seed your local Keychain so `init-target-repo.sh` doesn't prompt every time it wires up a new target repo:

```bash
security add-generic-password -U -s ssot-pipeline -a SSOT_WORKER_URL \
  -w 'https://<wrangler-name>.<your-cf-account>.workers.dev/config'
```

## 7. Configure the Linear webhook

1. In your fork's Linear workspace: Settings → API → Applications → edit your `claude` app
2. Set **Webhook URL** to: `https://<wrangler-name>.<your-cf-account>.workers.dev/linear`
3. Subscribe to: `Issue`, `Reaction`, `Comment`
4. Copy the signing secret Linear shows you, then set it on the Worker:

   ```bash
   wrangler secret put LINEAR_WEBHOOK_SECRET
   ```

See [`docs/linear-app-setup.md`](./linear-app-setup.md) for full Linear OAuth app setup.

## 8. Set `CLOUDFLARE_API_TOKEN` on this repo

The `deploy-worker` Action auto-redeploys the Worker on every merge that touches `config/pipeline.json` or `worker/**`:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo <your-github-login>/ssot-pipeline
```

## 9. Wire up your first target repo

```bash
./bin/init-target-repo.sh /path/to/target-repo <linear-project-url-or-id>
```

The script will:
- Set repo secrets on the target repo
- Prompt for `SSOT_WORKER_URL` if not in env/Keychain and set it as a GitHub Actions variable
- Install `ssot.yml` with the correct `uses:` path pointing at your fork
- Add the `project_to_repo` mapping to `config/pipeline.json` and push (triggering Worker redeploy)

## 10. Test the loop

Create a Linear issue in your project and move it to `Todo (AI)`. Watch:

- `wrangler tail` — Worker receives the webhook, fires `repository_dispatch`
- `gh run view --log` on the target repo — `linear-pickup` runs, Claude posts a plan
- Linear issue — plan comment appears, state flips to `Plan Review`

👍 the plan, and the implement cycle begins.
