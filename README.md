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

   **Jarvis's voice (optional, Mac with Apple silicon).** Jarvis can speak
   with a local voice instead of the browser's. Nothing goes to the cloud:

   ```bash
   npm run voice:setup
   ```

   Run it in a native arm64 terminal (not Rosetta) with Homebrew at
   `/opt/homebrew`; the script stops otherwise. It uses only uv's own
   Python builds, never python.org's or Homebrew's, and rebuilds an
   environment in `.voice/` that was made with another Python.

   ```bash
   npm run voice:up
   ```

   Then, with `npm run dev` running, open **http://localhost:8080/voices**:
   every voice reads the same five sentences and shows its time to first
   audio. "Use this voice" shows two lines to put in `.env` (`TTS_PROVIDER`,
   `TTS_VOICE`); restart Jarvis to use it. Kokoro's first start takes a
   minute or two; until it's up, `/voices` says "Kokoro is starting" and
   refreshes by itself.

   | Installed into `.voice/` (gitignored) | Disk, roughly | Memory while running, roughly |
   |---|---|---|
   | Kokoro-FastAPI v0.9.2 (Python, PyTorch with Apple GPU, the 82M-parameter model) | 1.5–2.5 GB, mostly PyTorch; the model is ~330 MB | 1–2 GB |
   | Piper 1.8.0 + 4 English voices (~60 MB each) | ~0.3 GB | ~0.2 GB |

   | Whisper (whisper.cpp via Homebrew, with Metal) + `small.en` model | ~0.5 GB (the model is 466 MB) | ~0.9 GB |
   | …or `WHISPER_MODEL=base.en` (faster, a little less accurate) | ~0.15 GB | ~0.4 GB |

   The setup script prints the real disk use at the end. It needs Homebrew,
   and installs `uv`, `espeak-ng` and `whisper-cpp` with it; the Whisper
   model is checked against whisper.cpp's published SHA-1. All three
   services listen on 127.0.0.1 only (Kokoro on 8880, Piper on 5001,
   Whisper on 8178). Kokoro and Piper log at warning level, so the text being
   spoken isn't logged; Whisper doesn't print what it heard and keeps the
   audio in memory. Jarvis refuses to start if `KOKORO_URL`, `PIPER_URL` or
   `WHISPER_URL` points anywhere but this machine.

   **Talking to Jarvis.** Press 🎤 Speak once and talk back and forth: the
   line above the box says **Listening**, **Thinking** or **Speaking**.
   - Your turn ends after half a second of silence (`VOICE_END_OF_TURN_MS`,
     200–3000, default 500). Say "that's all" or press Escape / ■ Stop to end
     the conversation; 8 s of silence ends it too.
   - Jarvis answers in the configured voice (`TTS_PROVIDER` / `TTS_VOICE`,
     e.g. `kokoro` / `bm_daniel`), sentence by sentence while the answer is
     still being written. If that service is down, the browser's voice
     speaks instead and a note says why.
   - **Interrupt him by just talking.** He stops at once, the rest of the
     answer is cancelled, and what you say is the next question. Only what he
     actually said is kept in the conversation. How interrupting works is set
     per browser: `BARGE_IN_CHROME` (default `vad`: just talk),
     `BARGE_IN_SAFARI` (default `strict`: it takes clearer, longer speech,
     because Safari's echo cancellation is weaker and he could otherwise
     interrupt himself through the speakers) and `BARGE_IN_OTHER`. `push`
     ignores the mic while he talks; tap ✋ Interrupt or press Space.
     With headphones, `vad` works everywhere.
   - Speech is detected by **Silero VAD**, running in the page from files this
     server hosts (no CDN), and transcribed by the local Whisper. Nothing
     goes to Google or Apple (the browser's own speech recognition isn't
     used). If Whisper isn't running, the page says so.
   - **Names:** Whisper is told which names to expect, so it spells them
     right: your name and the names in your profile's `## Family` section,
     plus anything in `data/whisper-hints.txt` (one per line; copy
     `data/whisper-hints.example.txt`). That file is gitignored, like the
     profile, and the hints are never logged.
   - English only for now; in Portuguese, type (the browser voice answers).

   **Local brain (#88).** The 🧠 Local / ☁️ Claude button picks who answers,
   and each answer says which did. Local is the default and is remembered.
   Local runs on [Ollama](https://ollama.com) on this computer:

   ```bash
   ollama pull qwen3:8b
   ```

   ```bash
   ollama serve
   ```

   - `OLLAMA_MODEL` (default `qwen3:8b`; `OLLAMA_THINK=off`, the default,
     tells it to answer without thinking first, which is much quicker to
     start talking) and `OLLAMA_URL` (default
     `http://127.0.0.1:11434`, and it must be on this machine).
   - Jarvis loads the model when it starts and asks Ollama to keep it loaded
     for 30 minutes, so turns don't wait for it to load. If Ollama isn't
     running, the answer says so.
   - The page only ever sends "local" or "claude": which model each one is
     comes from config, never from the page.
   - The classifier, memory and the EC rules are unchanged.
   - **`BARE_MODE=on`: a bare conversation.** Every question, typed or
     spoken, goes straight to the brain you picked with only the
     conversation so far and a short persona: "You are Jarvis, (your
     name)'s personal assistant", in the conversational style (1–3
     sentences, react first, a question back when it helps, no lists).
     - Only the local EC precheck runs first (EC still goes to Kiro, with
       no model).
     - No classifier, contexts, profile or memory, read or written. With
       Local selected, nothing at all goes to Claude.
     - Put your name in your `.env` as `JARVIS_USER_NAME`; it's gitignored,
       so it's never committed.
     - Profile, memory and contexts come back one at a time, each behind its
       own switch.
   - In bare mode Jarvis knows it can **only talk** for now: no calendar,
     reminders, notes, email, web or tools. Asked for one, it says so and
     offers to talk it through. It never claims to have done it.
   - `npm run eval:identity` (or `-- local` / `-- claude`) checks who is
     who and the conversational style on both brains, in bare mode with a
     made-up name: "Can you code?", "Who are you?", the calendar, a
     reminder, a note, an email, the weather and a few more. More than 4
     sentences is a warning, not a failure. It's informational: it exits 0
     unless you add `--strict`.

   **Why did he stop?** Each spoken answer's end is logged as one
   `playback` line. It gives the `reason` (`finished`, `barge-in`,
   `new-question`, `stop`, `typed`, `muted`, `new-conversation`,
   `answer-cancelled`), the sentences `played` of `total`, any
   `voiceErrors`, whether the text had all arrived (`streamComplete`), and
   for a barge-in the voice detector's reading (`bargeProb`, out of 100)
   and `msAfterFirstAudio`. Numbers and fixed words only.

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
