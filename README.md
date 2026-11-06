# Jarvis

A personal AI orchestrator. Architecture, milestones and decisions are in
[`PLAN.md`](PLAN.md); contexts are in [`contexts.md`](contexts.md).

## Run locally

Requires Node 22.12 or later.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add your Anthropic API key. `.env` is gitignored and is only read by
   `npm run dev`; production uses Google Secret Manager.

   ```bash
   cp .env.example .env
   ```

   Then set `ANTHROPIC_API_KEY` in `.env`. Alternatively, leave it out and
   set `GOOGLE_CLOUD_PROJECT` to read the key from Secret Manager with your
   `gcloud auth application-default login` credentials.

3. Start the dev server:

   ```bash
   npm run dev
   ```

   It listens on `http://127.0.0.1:8080` only (there's no login locally).

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

## Secrets in the cloud

The Cloud Run service account needs `roles/secretmanager.secretAccessor` on
the `anthropic-api-key` secret only (and later `vendus-api-key`), not on the
whole project. `ANTHROPIC_API_KEY` is ignored when `NODE_ENV=production`.
