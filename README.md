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

3. Create your profile. Jarvis answers questions about you only from this
   file, and it won't start without it:

   ```bash
   cp data/profile.example.md data/profile.md
   ```

   Then replace the example with your own details. `data/profile.md` is
   gitignored and CI fails if it's ever committed. Edits apply without a
   restart. Limit: 50 KB.

4. Optional: check the models answer with your key. This makes two tiny
   calls, one to the classifier model and one to the answer model:

   ```bash
   npm run smoke:llm
   ```

   And see how the classifier routes the example questions in
   `test/fixtures/classifier-questions.json` (about a dozen small classifier
   calls; the EC/HRT precheck cases make none):

   ```bash
   npm run eval:classifier
   ```

   Ask the personal answerer a question directly, using your real profile
   (one answer-model call; skips the classifier). The model and token use,
   including cache reads, are printed dimmed below the answer:

   ```bash
   npm run ask "When is my daughter's birthday?"
   ```

5. Start the dev server:

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
