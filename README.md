# Jarvis

A personal AI orchestrator. Architecture, milestones and decisions are in
[`PLAN.md`](PLAN.md); contexts are in [`contexts.md`](contexts.md).

## Run locally

Requires Node 22.13 or later (the memory store uses `node:sqlite`, which needs a flag before 22.13).

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

   And see what the memory wrap-up keeps and drops for the examples in
   `test/fixtures/memory-extraction.json` (English and pt-PT). Each case
   goes through the same flow as the server, so contexts that aren't
   connected yet get no wrap-up; it uses a throwaway in-memory store, never
   your `data/memory.sqlite`, and makes at most one small classifier-model
   call per case:

   ```bash
   npm run eval:memory
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

   Then open **http://localhost:8080** for the chat page: type, or press
   🎤 Speak and talk (Chrome or Safari; the browser asks for microphone
   access the first time). Answers are read aloud; 🔊 mutes them, and the
   language menu switches speech between English and Português (pt-PT).
   The voice menu defaults to "Automatic", the best installed voice for that
   language (Premium, then Enhanced, then Natural/Neural ones); pick another
   and it's remembered per language. On a Mac, better voices are under
   System Settings → Accessibility → Spoken Content → System voice → Manage
   Voices; reload the page after downloading one.
   **Conversation mode** (💬, on by default): once you've asked something by
   voice, the mic reopens by itself after Jarvis finishes speaking, and a red
   "Listening" banner shows while it's open. It never listens while Jarvis is
   talking. It stops after about 8 seconds of silence, when you say "that's
   all", "stop", "obrigado" or "é tudo", or when you tap ■ Stop. Typed
   questions never open the mic. If the browser won't reopen the mic without a
   tap, a note says so and you use 🎤 Speak as usual.
   When Jarvis asks which context you mean, tap a button or just type or
   say its name ("kid club", "pessoal"). The conversation lives only in
   the page: reload or "New conversation" clears it. Chrome's speech recognition sends audio to Google's speech
   service and Safari's to Apple's; Jarvis itself uses no other services.

   Memories are kept in `data/memory.sqlite` (gitignored, readable only by
   you; set `MEMORY_DB` to move it, or `MEMORY_STORE=memory` to keep them in
   RAM only). Deleting the file forgets everything.

   To see what Jarvis remembers, open **Memories** on the chat page (a badge
   counts new ones): delete any memory, or wipe a whole context. Turn off
   **🧠 Remembering** to keep the current conversation out of memory; it
   comes back on with New conversation. You can also ask "what do you
   remember about me?" or "forget that…", or use the terminal:

   ```bash
   npm run memory -- list
   ```

   (also `list --context kidclub --kind playbook`, `delete <id>`,
   `wipe --context <id>` which asks you to confirm, and `export`, which
   prints JSON and writes no file).

   Jarvis learns automatically after each answer, within rules it enforces
   in code: nothing about EC/HRT work, no secrets, no invoice data, and
   health, money or sensitive things about other people only when you say
   so ("remember", "take note", "lembra", "guarda", "não te esqueças",
   "anota"). To keep one exchange out of memory entirely, history line
   included, say so: "não guardes isto", "não te lembres", "esquece isto",
   "don't remember/keep/save this" or "off the record". To keep certain
   names out of memory altogether (EC colleagues,
   say), copy `data/never-remember.example.txt` to `data/never-remember.txt`
   (gitignored) and list them, one per line.

   It listens on `http://127.0.0.1:8080` only (there's no login locally).
   It also only accepts requests addressed to `127.0.0.1:8080` or
   `localhost:8080` (other Host headers get 403, which blocks DNS-rebinding
   tricks), and `POST /ask` only takes `Content-Type: application/json` (415
   otherwise, which blocks cross-site form posts).
   It won't start without a valid `contexts.md`, your profile and a key, and
   says what's missing. Try it:

   ```bash
   curl -s -X POST http://127.0.0.1:8080/ask -H 'content-type: application/json' -d '{"question":"When is my daughter'"'"'s birthday?"}'
   ```

   Replies are JSON: `answer`, `clarify` (pick a context and resend with
   `"context"`), `handoff` (EC/HRT → Kiro), `unavailable` (not connected
   yet) or `error`. `GET /healthz` returns `{"status":"ok"}`. Logs are JSON
   lines and never include your questions or answers.

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

## Secrets in the cloud

The Cloud Run service account needs `roles/secretmanager.secretAccessor` on
the `anthropic-api-key` secret only (and later `vendus-api-key`), not on the
whole project. `ANTHROPIC_API_KEY` is ignored when `NODE_ENV=production`.
