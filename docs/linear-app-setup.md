# Linear OAuth app setup

Goal: create a `claude` Linear app whose actions appear as `@claude` (not `@wells`) in your activity feed. Outputs: a long-lived `LINEAR_APP_TOKEN` you'll store as a GitHub repo secret and a Worker secret.

This is a one-time setup. Once done, every target repo wired with `init-target-repo.sh` reuses the same token.

## 1. Create the OAuth application

1. Go to https://linear.app/settings/api/applications/new
2. Fill in:
   - **Name:** `claude`
   - **Developer name:** Wells Riley
   - **Description:** Autonomous coding agent (ssot-pipeline)
   - **Callback URLs:** `http://localhost:8787/oauth/callback` (you can change this later — just needed to satisfy the form for the OAuth dance)
   - **Webhook URL:** leave blank for now, you'll add it in step 4
3. Save. Note the **Client ID** and **Client Secret** — you'll need them next.

## 2. Get an actor=app token

Linear's `actor=app` mode means actions are attributed to the application, not your user. Here's the manual OAuth dance:

```bash
# Step 1: open this URL in your browser (replace CLIENT_ID)
open "https://linear.app/oauth/authorize?client_id=CLIENT_ID&redirect_uri=http://localhost:8787/oauth/callback&response_type=code&scope=read,write,issues:create,comments:create,app:assignable,app:mentionable&actor=app"

# Step 2: approve, copy the `code` from the redirect URL.
# It'll redirect to: http://localhost:8787/oauth/callback?code=XYZ...

# Step 3: exchange code for token (replace placeholders)
curl -X POST https://api.linear.app/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=THE_CODE_FROM_STEP_2" \
  -d "redirect_uri=http://localhost:8787/oauth/callback" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

The response includes `access_token` — that's your `LINEAR_APP_TOKEN`. Save it (e.g., 1Password).

> Note: Linear's app tokens don't expire by default. If you ever regenerate it, you have to redo this dance.

## 3. Verify the token works

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name } }"}'
```

You should see something like `{"data":{"viewer":{"id":"...","name":"claude"}}}` — confirming actions attribute to the app, not you.

## 4. Configure the webhook

Once the Cloudflare Worker is deployed (separate step in the main README), come back here:

1. Go to your app at https://linear.app/settings/api/applications, edit the `claude` app
2. Set **Webhook URL** to: `https://<your-worker-subdomain>.workers.dev/linear`
3. Subscribe to events:
   - `Issue`
   - `Reaction`
4. Note the **Signing secret** — that's `LINEAR_WEBHOOK_SECRET`, store it as a Worker secret.
5. Scope: pick the projects you want covered (start with one for testing — you can add more later as you run `init-target-repo.sh`)

## 5. Save tokens where they need to live

| Where | Name | Value |
|---|---|---|
| GitHub repo secrets (each target repo) | `LINEAR_APP_TOKEN` | from step 2 |
| Worker (`wrangler secret put`) | `LINEAR_APP_TOKEN` | from step 2 |
| Worker (`wrangler secret put`) | `LINEAR_WEBHOOK_SECRET` | from step 4 |

For target repos: `init-target-repo.sh` handles setting `LINEAR_APP_TOKEN` automatically if you export it before running the script.
