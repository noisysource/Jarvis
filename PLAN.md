# Jarvis — Plan & Architecture

Jarvis is a personal AI orchestrator. It answers questions, works out which
**context** a question belongs to (from `contexts.md`), asks when it can't
tell, and answers each context with the data and tools listed for it.

Work is tracked in GitHub Issues and the **Jarvis** project board
(Backlog → To Do → In Progress → Review → Done). Every PR closes an issue.

## Milestones

| Milestone | Goal | Label |
|---|---|---|
| **M0: talk to Jarvis** | Chat page with voice, run locally; answers questions about you from your profile | `m0` |
| **Voice** (proof of concept, English) | A real spoken conversation, all local except Claude: ~1.5 s from the end of your sentence to Jarvis's first audio, and you can interrupt it (#72–#76) | `voice` |
| v0: KidClub invoices | Read-only Vendus tool; Cloud Run deploy | `after-m0`, `jarvis-v0` |
| After v0 | Memory in Firestore (#24) and its performance (#56), phone access (#19; Pi + Tailscale #53), daily brief (#49), local speech (#54), local models via Ollama (#55) | `after-v0`, `backlog` |

## Contexts

Defined in `contexts.md` (#22) and read at startup. Adding a context is a file
edit, not a code change.

| Context | Handling | Data |
|---|---|---|
| `personal` | answer | Your profile, `data/profile.md` (#25) |
| `kidclub` | answer | Vendus, read-only (after M0; "not connected yet" in M0) |
| `noisysource` | answer | None connected yet. **Invoicing the European Commission belongs here.** |
| `ec-hrt` (European Commission / HRT) | **handoff to Kiro** | None. Jarvis replies that this is for Kiro (the EC's agent) and stops: no answer model, no tools, no memory. |

**Routing rule.** Anything that needs no context's data (greetings, small
talk, thanks, general knowledge, questions about Jarvis) goes to `personal`
and is answered normally. So do questions about your own day, schedule or
to-dos ("what's on my plate today?"): until the daily brief (#49) exists,
Jarvis says honestly that it can't see your calendar or tasks yet. Jarvis asks "which context?" only when a request
needs some context's data and it's ambiguous which ("did the invoice get
paid?"). The personal answerer knows what Jarvis can do, from `contexts.md`. After
a clarify, the page treats a reply that names an offered context (name, id
or `Aliases` from `contexts.md`; case, accents and spacing ignored) as
picking it, with no model call; anything else is a new question. Only one
request is in flight at a time.

**Local precheck for handoffs.** `ec-hrt` lists *recognition cues* (e.g.
"European Commission", "EC", "HRT", "EPSO", "CASP", "UTP", "Cast-p", "Recruiter
Portal UTP") that are matched locally, before any model runs: whole words,
accents ignored, ALL-CAPS cues case-sensitive, a hyphen matching a hyphen,
space or nothing. A cue plus an invoicing word from its `Unless` list ("Invoice
the European Commission") routes straight to `noisysource`; a cue alone hands
off to Kiro. The precheck runs on **every** question, even when a context was
picked (e.g. after a clarify), so EC/HRT requests always reach Kiro. Questions with no cue go to the classifier, which still has
`ec-hrt` as an option as a backstop and is told that invoicing the EC is
Noisy Source. "The Commission" is deliberately not a cue, because it also
means a sales commission.

## Request flow (M0)

```
Chat page (GET /)                         Hono server (npm run dev, localhost)
 ├ text box / mic (SpeechRecognition)      POST /ask { question, context?, history[] }
 ├ history[] in page memory only   ───────►  precheck(question)            ← cues in contexts.md, no model
 │                                           ├ EC cue + invoicing word → noisysource
 │                                           ├ EC cue                  → handoff: "This is for Kiro"
 │                                           └ no match ↓
 └ speaks answer (speechSynthesis) ◄───────  classify(question, history)   ← contexts.md
                                             ├ unclear     → clarify (context buttons)
                                             ├ ec-hrt      → handoff: "This is for Kiro" (backstop; nothing else runs)
                                             ├ kidclub /
                                             │ noisysource → unavailable: "not connected yet" (M0)
                                             │               (no memory load, no wrap-up)
                                             └ personal    → loadMemories (MemoryStore, this context only)
                                                             → answer model: instructions + profile + history + memories
 ◄────────────────────────────────────────── reply sent
                                                             → after the reply (#56): wrapUp → extract (#61) → MemoryStore
                                                               (skipped with remember: false or an opt-out)
```

The server is **stateless**: the page sends the conversation with each
question, and after a clarify response it re-sends the question with
`context` set.

## Principles

- **Pure functions and types, no classes.** Enforced by lint. Dependencies
  are passed in as plain `Deps` objects so core logic is unit-testable with
  stubs. Library objects (Anthropic SDK client, Secret Manager client) are
  consumed, never defined.
- **Never guess the context.** Ambiguous → ask.
- **Never guess facts about you.** If the profile doesn't say, Jarvis says so.
- **Local server, no login, so other sites are kept out:** outside
  production it only accepts `Host: 127.0.0.1:<port>` or `localhost:<port>`
  (403 otherwise; blocks DNS rebinding), and `POST /ask` requires
  `application/json` (415 otherwise; blocks cross-site forms and simple
  requests, and no CORS preflight is ever answered). On Cloud Run, IAM
  protects the endpoint instead (#18).
- **Read-only by construction** for Vendus: the client only exposes `GET`, and
  paths are checked against an allowlist before any network call.
- **Secrets:** Secret Manager in the cloud. Locally only, `ANTHROPIC_API_KEY`
  may come from a gitignored `.env`. Never logged, never committed. The
  profile is treated the same way.

## Module layout

| File | Responsibility | Issue |
|---|---|---|
| `src/result.ts` | `Result<T, E>` with `ok` / `err` | #4 |
| `src/types.ts` | `ContextId`, `Context`, `Turn`, `AskRequest`, `AskResponse`, `Classification`, `Memory`, `MemoryHooks`, `AppError`, `Deps` | #4 |
| `src/contexts.ts` | `parseContexts(markdown)` for `contexts.md`; classifier/clarify/handoff helpers | #22 |
| `src/precheck.ts` | `makePrecheck(contexts)`: local cue matching for handoff contexts, no model | #22 |
| `src/config.ts` | `loadConfig(env)`: pure, zod-validated | #5 |
| `src/llm/model-ref.ts` | `parseModelRef("provider:model")`, known providers | #5, #10 |
| `src/secrets.ts` | `makeSecretGetter` (Secret Manager, memoised, failures retried), `resolveAnthropicKey` (`.env` locally only) | #6 |
| `src/profile.ts` | `ProfileSource`; file source now, secret/bucket later | #25 |
| `src/llm/types.ts` | Provider-neutral `LlmCall`, `LlmRequest`, `LlmResponse`, `ModelRef` | #10 |
| `src/llm/anthropic.ts` | Anthropic provider: effort, refusal handling, error mapping | #10 |
| `src/llm/registry.ts` | `makeLlm(config)`: picks the provider from `provider:model` config | #10 |
| `src/llm/ollama.ts` | Ollama provider: `/api/chat` streamed (NDJSON), `keep_alive` 30 m, startup warm-up; no JSON output or tools yet | #88 |
| `src/classify.ts` | `makeClassifier`: local precheck, then the classifier model → context id or `unclear` | #11 |
| `src/answer/personal.ts` | Answer model: instructions + profile (cached), then Lisbon date/time and memories (uncached), history, no tools | #13 |
| `src/time.ts` | `formatNow(now, timeZone)` for prompts | #13 |
| `src/memory.ts` | `makeMemoryHooks` on a `MemoryStore` (load: ~20 facts/playbooks + 3 history lines per context; wrap-up applies `extract`'s decisions, one history line per conversation); `makeSafeMemoryHooks`: 2 s timeout, failures never fail a question | #23, #59 |
| `src/memory-store.ts` | `MemoryStore` interface, word ranking, in-memory store | #59 |
| `src/memory-extract.ts` | The wrap-up's extract step: one classifier-model call (question + final answer + related memories, never tool results) with a fixed JSON format, then `filterSuggestions` enforces every rule in code | #61 |
| `src/llm/stream.ts` | `streamOrCall` (streams if the provider can, else one chunk), `streamedFrom` for stubs | #72 |
| `src/sentences.ts` | Streaming sentence splitter, language as a parameter | #72 |
| `src/tts/*` | `TtsProvider` (text, language, voice → streamed 16-bit mono PCM): Kokoro (Kokoro-FastAPI), Piper, browser | #73 |
| `src/tts-routes.ts` | `GET /tts` (providers and voices), `POST /speak` (streamed PCM; Host + JSON guards; no text in logs) | #73 |
| `src/local-url.ts` | Local service URLs must be loopback, or Jarvis won't start | #73 |
| `src/web/audio.js`, `src/web/voices.*` | PCM player for /speak; the dev-only /voices audition page | #73 |
| `src/stt/*` | `SttProvider` (16 kHz mono WAV, language → text): whisper.cpp's server | #74 |
| `src/stt-routes.ts` | `GET /stt` (ready?), `POST /transcribe` (audio/wav only, 2 MB, Host guard; audio never stored, transcripts never logged) | #74 |
| `src/web/mic*.js` | The conversation's mic (AudioWorklet), resampled to 16 kHz in 512-sample frames, kept a minute; WAV encoding | #74, #75 |
| `src/service-starting.ts` | "Starting" rather than "not running" while `voice:up` waits for a service | #80 |
| `src/stt/hints.ts` | Whisper name hints from the profile and `data/whisper-hints.txt`; never logged | #83 |
| `src/web/speaker.js`, `src/web/turn-lib.js` | Speaking a reply sentence by sentence (prefetch, fallback, what was said); SSE parser, turn detector, phase labels | #82, #75 |
| `src/web/silero.js`, `src/web/vad.js` | Silero VAD v5 on onnxruntime-web, served from `/vendor/…` | #75 |
| `scripts/voice-bench.ts` | `npm run voice:bench`: times the running Kokoro and Whisper | #76 |
| `src/turns.ts` | Holds a streamed answer's wrap-up until playback is reported; `decideWrapUp` | #72 |
| `src/memory-routes.ts` | Memories panel API: `GET /memories`, `DELETE /memories/:id`, `POST /memories/wipe`, `POST /memories/seen`; Host guard, JSON-only POSTs, `no-store`, no memory text in logs | #62 |
| `src/memory-cli.ts`, `scripts/memory.ts` | `npm run memory -- list / delete / wipe / export` on the same store as the server | #62 |
| `src/memory-rules.ts` | Pure rule checks: explicit "remember" and "forget" in the user's own words, secrets, business records, sensitive categories, EC cues + never-remember names | #61 |
| `src/memory-sqlite.ts` | SQLite `MemoryStore` on `node:sqlite`: mode-600 file, numbered schema steps, `secure_delete` + `VACUUM` on wipe, daily purge of expired history | #60 |
| `src/ask.ts` | `handleAsk(deps, req)`: context → clarify / handoff / (answered contexts only) loadMemories → answer → reply; wrapUp handed to `afterReply` | #14, #56 |
| `src/background.ts` | `makeBackgroundTasks`: runs after-reply work on the next event-loop turn, logs failures by name and error class, `drain()` on shutdown | #56 |
| `src/request.ts` | `parseAskRequest(body)`: question ≤ 2000 chars, optional context, history ≤ 20 turns × 4000 chars | #26 |
| `src/answer/router.ts` | Answerer per context; contexts without one give an `unavailable` reply ("not connected yet"), not an error | #26 |
| `src/app.ts` | `buildDeps(config)`: wires the real deps; refuses to start without contexts, profile or key | #26 |
| `src/server.ts` | Hono: `POST /ask` (validated, 256 KB limit), `GET /healthz`, request ids, JSON 404/500 | #15 |
| `src/main.ts` | Entry point: config → `buildDeps` (refuse to start on problems) → serve → graceful shutdown | #15 |
| `src/log.ts` | JSON-lines logger with Cloud Logging `severity` | #15 |
| `src/web/` | Chat page, served as-is: `index.html`, `app.css`, `app.js` (DOM + Web Speech), `chat.js` (pure, tested) | #27 |
| `src/web.ts` | Loads the page files at startup; strict CSP and mic-only Permissions-Policy | #27 |
| `src/vendus/*`, `src/answer/kidclub.ts` | Vendus client, tools, KidClub answerer | #7–#9, #12 (after M0) |

## Components

**Models, behind a provider interface.** All model calls go through one
provider-neutral function type:

```ts
type LlmCall = (req: LlmRequest) => Promise<Result<LlmResponse, LlmError>>;
// LlmRequest:  { system, messages, tools?, outputSchema?, effort?, maxTokens }
// LlmResponse: { kind: "text", text } | { kind: "tool_calls", calls } | { kind: "json", value }
```

Each provider is a module that exports a factory `(apiKey, model) => LlmCall`.
Models are picked by config as `provider:model` strings, one per role:

- Classifier: `CLASSIFIER_MODEL=anthropic:claude-haiku-5-5`, effort `low`
- Answers: `ANSWER_MODEL=anthropic:claude-sonnet-5-5`, effort `medium`

Adding Gemini or Grok later means adding one provider module and its API-key
secret, then changing those env vars. The KidClub tool loop is our own code
over `LlmCall`, not a vendor tool runner.

Anthropic provider: official `@anthropic-ai/sdk`; checks `stop_reason` before
reading content; turns `refusal` / `max_tokens` into typed errors. Sonnet calls
use the server-side refusal fallback (`fallbacks: "default"`); Haiku has none,
so a refused classification becomes `unclear`.

**Profile (M0).** `data/profile.md` is gitignored; `data/profile.example.md`
is committed. Loaded through `ProfileSource` (`PROFILE_SOURCE=file:…` now;
Secret Manager or a private bucket in the cloud later). The server refuses to
start without a profile. Only the `personal` answerer sees it.

**Chat page (M0).** One HTML page and one JS file served by Hono, no build
step, no external scripts. English by default with a `pt-PT` toggle.
Listening and Jarvis's voice are local since the Voice milestone (below); the
browser voice is the fallback. The browser voice is picked automatically (exact
region first, then Premium > Enhanced > Natural/Neural/Online, then the system
default), with a voice menu whose choice is remembered per language in
localStorage. Conversation history lives only in the page.

**Conversation mode (M0, #51; turn manager #75).** A toggle, on by default
and remembered. With it on, one press of the mic opens a spoken
conversation that stays open; with it off, the mic closes after one
question's answer. Listening resumes 0.4 s after Jarvis finishes speaking.
The conversation ends after ~8 s of silence, on a whole-utterance stop
phrase ("that's all", "stop", "obrigado", "é tudo" and small variants; not
sent to the server), on Stop or Escape, or when you type.

**Voice (#72–#76).** A pipeline coordinated by a turn manager in the page:
ears (local Whisper, `/transcribe`) → brain (`/ask`, streamed) → mouth
(local TTS, `/speak`). English only for now; `Language` is a parameter
everywhere, so pt-PT needs no redesign. Every local service listens on
127.0.0.1 only, behind the same Host and JSON guards; audio is never stored
and no conversation content is logged.

- **Streaming answers (#72).** `POST /ask` with `Accept: text/event-stream`
  sends `start {turnId}`, then `sentence {index, text}` as each sentence
  completes (`src/sentences.ts`: abbreviations, decimals, initials, list
  numbers; a long first sentence is cut at a clause so speech starts
  sooner), then `done` with the full answer; clarify, handoff, "not
  connected yet" and errors come as one `reply`. Without that header `/ask`
  is unchanged. Only the answer model streams (`LlmCall.stream`, with
  `streamOrCall` falling back to one chunk); routing, the precheck and the
  memory rules are untouched. Leaving the stream cancels the model call.
  Because a streamed answer finishes before it's been *spoken*, its wrap-up
  waits (`src/turns.ts`) for the page's `POST /ask/spoken {turnId,
  interrupted, spoken}`: played to the end → wrap up on the full answer;
  interrupted → skip, unless the question explicitly asked to remember or
  forget (not an opt-out), in which case wrap up on the question and what
  was actually spoken. No report within 2 minutes: a finished answer counts
  as heard, a cancelled one as interrupted.

- **Mouth (#73).** `TtsProvider` follows the LLM pattern: `speak({ text,
  language, voice }, signal)` → streamed 16-bit mono PCM (format and sample
  rate in headers), and `listVoices(language)`. Providers: **Kokoro** via
  Kokoro-FastAPI v0.9.2 (Apple GPU through PyTorch MPS; streamed raw PCM at
  24 kHz), **Piper** 1.8.0 (its HTTP server's WAV, header read and PCM
  passed on), and the **browser** voice (played by the page itself). Chosen
  by `TTS_PROVIDER` / `TTS_VOICE`; the browser is the default until a voice
  is picked. `/voices` (dev only) plays five fixed sentences in every
  voice with time to first audio. `npm run voice:setup` installs into
  `.voice/` with pinned versions; `npm run voice:up` starts both services
  on 127.0.0.1 at warning log level. While it waits for a service it keeps
  `.voice/run/<service>.starting` (its PID), so `/tts` and `/voices` say
  "starting" rather than "not running" (#80).

- **Ears (#74).** `SttProvider`: `transcribe({ wav, language }, signal)` →
  text, and `status()`. One provider: **whisper.cpp's server** (Homebrew
  `whisper-cpp`, Metal) on 127.0.0.1:8178 with **`small.en`**
  (`WHISPER_MODEL=base.en` for speed; settled by timing in #76), started
  without `--convert` (audio decoded in memory, no temp files) and without
  `--print-realtime` (it doesn't print what it heard). The page (see the turn manager, #75) sends a WAV to
  `POST /transcribe` (`audio/wav` only, so a cross-site form needs a
  preflight this server never answers; 2 MB). The text comes back to the
  page, which sends it to `/ask` like typed text, so the **local EC precheck
  runs first** and an EC question reaches no model or memory. The
  browser's Web Speech recognition (audio to Google/Apple) is no longer
  used, with no fallback: if Whisper isn't running the page says so.
  **English only for now**: in Portuguese the mic is disabled with a note
  (a multilingual model is a later decision). **Name hints (#83):** the
  names in the profile (`Name:` and the `## Family` section) plus the
  gitignored `data/whisper-hints.txt` (`WHISPER_HINTS_PATH`; CI refuses it
  if committed) go to Whisper as its per-request `prompt` (deduplicated,
  ≤ 40 hints, ≤ 400 characters), read fresh each time; only their count is
  logged.

- **The chat speaks with the configured voice (#82).** The page asks `/ask`
  streamed and plays each sentence through `/speak` as it arrives
  (`speaker.js`: the next sentence is fetched while the current one plays).
  The browser voice speaks when `TTS_PROVIDER=browser`, in Portuguese, and
  as a fallback when the service is down or `/speak` fails, with a note.
  Every streamed answer sends its playback report to `/ask/spoken`.

- **Latency (#76).** Every turn is timed:
  - end of turn (the silence waited)
  - Whisper (round trip, plus the server's time in a `Server-Timing` header)
  - routing (precheck, picked, sticky or classifier), and memories
  - Claude's first token and first sentence (the SSE `timing` event)
  - the voice's first audio
  - the total, from the end of your speech to the first sound

  The page shows them under each answer in development and posts them,
  numbers only, with the browser and its version, to `POST /latency` (a
  strict schema that accepts no text). They're logged as one `latency`
  line. **The bottleneck was thinking:** Claude Sonnet 5.5 and Claude
  Haiku 5.5 think by default, and the thinking is hidden, so the first
  sentence came only after it. Spoken answers (`spoken: true` from the
  page) now go without thinking (`VOICE_THINKING=off`; Sonnet 5.5's
  `between_tools`, `disabled` on models that allow it, low effort on Opus
  5.5 and Fable, which can't turn it off), and so does the classifier
  (`CLASSIFIER_THINKING=off`). Typed answers keep thinking. The first chunk
  is cut at a clause after 60 characters (`VOICE_FIRST_CHUNK_CHARS`).
  `voice:up` takes `KOKORO_DEVICE=mps|cpu` and warms Kokoro and Whisper up;
  `npm run voice:bench` times them. **Your first Mac run** (3–4 s typical;
  one 12 s first turn):
  - **Self-interruption:** Chrome's `vad` heard "Sure" through the
    speakers, so Chrome now defaults to `strict` too. Barge-in is ignored
    for 600 ms after his voice starts. The timing line shows the echo peak
    and run, for tuning. The prompt tells Claude that a reply ending in "—"
    was a deliberate interruption: no apologising, no going back to it.
  - **Cold start:** the first classifier call takes the new connection, and
    the first use of its JSON schema, which is compiled once on Anthropic's
    side. Both are now paid by a warm-up (at startup and on `POST /warm`
    when a conversation starts). Connections are kept open for 30 s
    (`undici` with keep-alive; Node's own fetch closes them after about
    4 s). Each HTTP attempt is logged (status, ms, retrying) to tell a retry
    from slowness.
  - **Speculative answer, opt-in:** `SPECULATIVE_ANSWER=on` starts the
    personal answer while the classifier runs. Its text is held back until
    the classifier agrees, and it's cancelled otherwise. It's off by
    default for the same EC reason as sticky context.
  - **First chunk:** a first sentence with no comma-like mark is cut at a
    word once it's 2× `VOICE_FIRST_CHUNK_CHARS`. The timing line shows the
    first chunk's length next to the voice's first audio.
  - **Fillers:** one only starts if the first sentence hasn't arrived yet
    (once it has, its audio is moments away, and a filler would only delay
    it). Starting the answer no longer stops a filler that's playing; the
    answer waits for it to end.
  - **Median:** each turn is reported once the stream and the playback are
    both over, in either order. It used to be lost when the first sound
    came after the stream ended.

  **Sticky context is opt-in**
  (`STICKY_CONTEXT=on`): a spoken follow-up stays in the last answered
  context, which the page sends as `stickyContext`, skipping the
  classifier. The precheck still runs first and handoff contexts never
  stick, but an EC question the precheck misses would reach the answer
  model, which the EC rule forbids, so it stays off unless you decide
  otherwise.

- **Fillers (#86).** On a spoken turn, if no answer audio has started 800
  ms after the end of your speech, a short filler plays. There are five
  fixed lines (`FILLERS`), pre-rendered through `/speak` in the configured
  voice when the page loads, or spoken by the browser voice as a fallback.
  Never the same one twice in a row, never on two spoken turns in a row,
  and never once the first sentence is about to play. If the first
  sentence arrives during a filler, it starts when the filler ends. They're
  not part of the answer: not in history, the playback report or memory.
  Barge-in and Stop stop them. With tools (later), a tool will pass its own
  honest line ("Let me check your calendar") through the same path.

- **Turn manager (#75).** One mic for the conversation (`mic.js`: echo
  cancellation, noise suppression, auto gain; resampled to 16 kHz and cut
  into 512-sample frames; the last minute kept). Each frame goes through
  **Silero VAD v5** (`silero.js`, `vad.js`), run with onnxruntime-web on one
  thread. Both are served by this server from the pinned npm packages
  (`/vendor/…`); the CSP gains `'wasm-unsafe-eval'` only. A pure turn
  detector (`turn-lib.js`) turns probabilities into events. Speech above 0.5
  for ~100 ms starts an utterance. Below 0.35 for `VOICE_END_OF_TURN_MS`
  (default 500) ends it, which sends the WAV from 320 ms before speech to
  ~200 ms after. 8 s of nothing ends the conversation; ~55 s is the most.
  **Barge-in:** while Jarvis thinks or speaks only an interruption is looked
  for. `vad`: ≥ 0.5 for 200 ms. `strict`: ≥ 0.85 for 450 ms, the Safari
  default, since its echo cancellation is weaker. `push`: the mic is
  ignored; ✋ Interrupt or Space. Set per browser with `BARGE_IN_CHROME`,
  `BARGE_IN_SAFARI` and `BARGE_IN_OTHER`, read from `GET /voice-settings`.
  An interruption stops the audio at once, aborts the `/ask` stream and
  `/speak` requests in flight, and records what was actually said: whole
  sentences, then the cut one up to the share played, ending in "—". That
  goes into history and the playback report, and the interruption is the
  start of the next utterance. Talking again within 4 s of your turn ending,
  before Jarvis has started speaking, cancels that question and sends the
  whole utterance instead. The phase line (Listening / Thinking / Speaking,
  text plus colour, read out) says how to interrupt.

**Local brain (#88, first slice of #55).** `ollama:<model>` is a provider
behind `LlmCall`, streaming only. `OLLAMA_URL` must be loopback (like the
voice services), and `OLLAMA_MODEL` defaults to `qwen3:8b`, with
`think: false` unless `OLLAMA_THINK=on` (a model that refuses the field is
retried without it). Requests
send `keep_alive: 30m`, and the model is loaded at startup. The chat page's
**Claude / Local** switch (default Local) sends `brain: "claude" | "local"`.
The request schema accepts only those two, and config says which model
each is. The answer carries `brain`, which the page shows; `GET /brains`
gives the labels. An Ollama error carries a message the page can show
("isn't running", "isn't installed").

**Bare conversation mode (#88, `BARE_MODE=on`).** Every turn, typed or
spoken, gets the local EC precheck (a handoff goes to Kiro with no model
call), then the selected brain with **only** the history and a short
persona (`src/answer/bare.ts`):
- "You are Jarvis, (`JARVIS_USER_NAME`)'s personal assistant": "I" is
  Jarvis, the person is "you". The name comes from the gitignored `.env`,
  never the code.
- It knows nothing of their life beyond the conversation.
- The conversational style: 1–3 sentences unless asked, react first, a
  question back when it helps, no lists or headings, plain words.

No classifier, no contexts, no profile, no memory reads or writes, no held
turn. With Local selected, nothing reaches Claude. `npm run eval:identity`
checks who is who and the style on both brains.

The bare persona lists what Jarvis can actually do: only talk. No calendar,
reminders, notes, email, web or tools. It says so when asked, and never
claims to have done one. `eval:identity` covers those cases too. It's
informational: more than 4 sentences is a warning, and it exits 0 unless
`--strict`.

**Spoken style in bare mode (#92).** Spoken turns get their own style, and
it's also the main latency fix: the reply opens with a reaction of one to
three words as its own sentence ("Okay.", "Good question."), so the first
piece Kokoro speaks is tiny and starts at once.
- Then at most one or two short sentences (`VOICE_MAX_SENTENCES`, default
  2 since #94, the reaction not counted), unless they ask for detail ("in detail",
  "tell me more", "step by step"). "Explain like I'm five" stays short.
- The limit is enforced in code too: the reply is cut after the last
  allowed sentence, the model is stopped, and only what was said is kept.
- Pauses (#94, experiment): with `VOICE_PUNCTUATION_STYLE=on` the model may
  use an ellipsis (...) or a dash (—) for a pause, now and then; off, it's
  told not to. The sentence splitter never splits on an ellipsis or a dash
  (they're pauses inside a piece; "...?" still ends one), and the first
  sentence is cut early only at , ; or :.
- No capitals for emphasis until they're tested. In Kokoro's phonemiser
  (misaki 0.9.4), an all-caps word that's an ordinary word ("REALLY") is
  said as that word with extra stress. But an all-caps word misaki knows as
  an acronym ("IT", "US", "ME", "AM", "WHO"…), when tagged as a noun, and an
  all-caps word it doesn't know, tagged as a proper noun, are spelled out
  letter by letter. `/voices` takes your own sentence to try them.
- The opening varies: each spoken turn's system suffix offers three
  reactions in a random order (never the one the last reply opened with),
  and about one turn in five asks for no reaction at all.
- Contractions, plain words, no quotes, brackets, lists or symbols.
- Numbers are read out in words in code, just before the voice, for any
  brain (`src/web/spoken-numbers.js`: "366" → "three hundred sixty-six",
  years, times, money, ordinals, percentages). The chat keeps the digits.
  English only for now.
- Never a promise for later, even after a refusal ("but I'll remember to
  tell you", "I can remember that for you"): it remembers nothing after
  the conversation.
- Typed turns keep the typed style.
- The page waits 1.6 s (not 0.8 s) before a filler when replies open with
  their own reaction (`/voice-settings` → `reactionFirst`). If a filler did
  play, the reply's own reaction isn't spoken (it still shows), so there's
  never "One moment. Okay."
- `eval:identity` adds spoken cases: no quotes or brackets, the limit, how
  soon the first words came, and whether the openings vary (one reaction
  opening more than half the replies fails). False promises after a
  refusal fail every ability case.

**Milestone "Conversation"** (now): talking to Jarvis should feel like
talking to a person, tuned on the free local brain (`qwen3:8b`), keeping
the current architecture.
1. Bare mode on Ollama with `think: false`, and the real abilities in the
   persona (#90).
2. Rebase #85 (echo fixes, fillers, timing line) onto `main`, keeping bare
   mode and the brain switch.
3. A voice style for bare mode: written to be spoken (short, react first,
   contractions, a question back when natural, no formatting, numbers in
   words), and the sentence limit in code (#92).
4. Flow: bigger pieces to Kokoro (two sentences when ready) so the
   intonation carries; easy barge-in where echo isn't a risk; the right
   setting for the Mac's built-in mic.
5. Done means a 10-minute free conversation on Local that feels natural,
   with a median time to first sound under 1.5 s, then one check on
   Claude.
6. Chatterbox and Dia2 as voice providers on `/voices`, to compare with
   Daniel.

**Milestone "Trust"** (now, #91), one PR at a time:
1. **The honesty guard (#96), in code, for every brain.** Done:
   `src/answer/honesty.ts`, run by `handleAsk` on every answer.
   - Each sentence (or first clause) is checked before it's shown or
     spoken. It's dropped if it:
     - claims an action ("I've scheduled/created/sent/added…", "Done.",
       "Noted:", "Your reminder is set")
     - promises one ("I'll remind you", "I'll remember", "I'll keep
       track", "I can remember that for you")
     - claims to perceive you ("you look tired", "I can see you're busy")
   - The exception is a turn where a tool ran and succeeded
     (`AnswerInput.onToolSucceeded`, for the tool loop to call).
   - If nothing useful is left (only a short reaction), "I can't do that
     yet." is added.
   - Never yes-then-no (#98): when the question asks for an action
     (remind, add, send, book…), an affirmative opening ("Sure.", "Okay.")
     is held until the next sentence passes. If nothing useful passes, it's
     never said and the reply is "Actually, I can't do that yet." (also
     after a non-affirmative opening like "Hmm."). Typed replies always
     hold it, since there's no cost. Streamed replies to other questions
     keep the fast opening.
   - It covers streamed and typed answers alike. The page, the voice,
     history and memory all get the checked text.
   - It logs `honesty guard` with counts per category and `replaced`,
     never text.
   - The test set is the replies from the identity eval's tests
     (`test/fixtures/honesty-cases.ts`). Made-up facts ("you have a
     meeting at ten") aren't the guard's job; the eval catches those.
2. **The profile back (#98)** (`PROFILE=on`, otherwise still bare): the
   bare persona also gets `data/profile.md`, re-read when it changes.
   - It has the personal answerer's who-is-who rules, and says so when the
     profile doesn't say (never guesses).
   - The name comes from `JARVIS_USER_NAME`, or else the profile's
     `Name:` line.
   - Still no memory, contexts or classifier.
   - `eval:identity --profile` uses the made-up example profile, never
     yours. `--guarded` checks what you'd actually get, after the guard.
3. **Google Calendar, the first real tool**, in two PRs:
   - **3a, reading (#100), done** (`src/calendar/`, `CALENDAR=on`, bare
     mode, local only):
     - **OAuth on the Mac:** `npm run calendar:connect` (installed-app flow,
       PKCE, loopback redirect, scope `calendar.events.readonly`). The
       client and refresh token are gitignored files under `data/`, 0600,
       and never logged. Production refuses `CALENDAR=on`, since secrets
       there come only from Secret Manager.
     - **The days, in code first** (`src/calendar/dates.ts`): on a turn
       that might be about the calendar (a cheap check in code), date
       phrases are resolved in Europe/Lisbon before any model call: today,
       tomorrow, the day after tomorrow, yesterday, weekday names (the
       next one, today included; "next Friday" is the next one after
       today), this week (today to Sunday), next week (Monday to Sunday),
       this/next weekend, and explicit dates ("12 November", "12/11" day
       first, "12 to 14 November"). A small model got "tomorrow" wrong
       by a day, so models no longer count days.
     - **The request:** only when no phrase names the days does the
       selected brain fill in a structured request (`outputSchema`;
       Ollama's `format`): `{tool: calendar_read|none, from, to}`.
     - **The date read is always stated**, worded by code: the answer
       opens with "Looking at Wednesday 11 November." (streamed first,
       outside the spoken sentence limit; no opening reaction then).
     - **Retry:** a bare "yes" after Jarvis offered to try again, or a
       bare "try again", repeats the last calendar question with a real
       read. The prompt says that without events at its end, nothing was
       read: never claim what's on or whether it can be reached.
     - **Code checks it:** only that tool, real YYYY-MM-DD dates, from ≤
       to, at most 14 days, from 31 days back to a year ahead. It then
       reads the primary calendar for those days (GET only), with day
       bounds in Europe/Lisbon.
     - **The answer:** the events go into the uncached part of the prompt
       as data, and the brain answers only from them. If it isn't
       connected, the read fails or the request is refused, the brain is
       told to say so or to ask which day, never to guess.
     - **EC events:** the local EC precheck matches the title or place, or
       an organiser or invitee is at europa.eu. Such an event reaches the
       brain only as "EC work, handled by Kiro" with its time: no title,
       place or people.
     - **Reading isn't an action:** the honesty guard stays on.
     - **Claude:** the page notes once, before the first question, that
       with Claude the events go to Anthropic.
   - **What a turn means for the calendar** (`src/calendar/intent.ts`,
     #102), decided in code from the question and the history:
     - a calendar question reads for the days it names
     - a follow-up naming a day ("what about tomorrow?", "and Friday?")
       reads too, while the conversation is about the calendar
     - a bare "yes" to an offer to check or try again repeats the last
       calendar question
     - "did you check?" / "have you tried?" reads now, and the reply
       opens with what really happened, worded by code: "No, I hadn't
       checked before. I've checked now: looking at Wednesday 11
       November." or "Yes, that answer came from a real check of your
       calendar. …"
     - a past reply counts as checked only if it opens with "Looking at
       <day>.", which only code writes after a read that worked
   - **Claimed tool results (#102):** a fourth honesty-guard category.
     - Dropped: statements about what's on the calendar ("your calendar is
       clear", "no events", "you have one event…") or about having checked
       it ("I did check"), unless `calendar_read` worked in that turn
       (`guard.resultsKnown()`, set from the tool step).
     - In a turn about the calendar, "you have X at ten" and "you're
       free" count as well.
     - The reply then says "I haven't checked your calendar for that.
       Which day shall I look at?". After a failed read it says "I
       couldn't check your calendar just now."; with no calendar, "I
       can't see your calendar yet."
     - Promises and claimed actions are still dropped after a read.
   - **Now (#102):** every bare prompt ends with today's date, weekday
     and time in Europe/Lisbon (uncached).
   - **No repeated date (#102):** if the model restates the date
     sentence, code takes it off (streamed and typed).
   - **The answer's path (#102):** answers and handoffs carry `path`, a
     list of steps: the EC precheck result, the brain, each tool or skill
     step (`AnswerInput.onStep`: name, arguments as checked by code, who
     chose them, ok or an error code, a count), and the guard's counts.
     The page shows it as one collapsible line under the reply. It holds
     fixed words, dates and counts only, and is never logged. Skills get
     their own mark (✨) when they exist.
   - **Voice only in voice mode (#102):** the page reads a reply aloud
     only for a mic turn, or when "read typed replies" is on (off by
     default). Each message has a copy button.
   - **3b, creating:** only after your explicit yes to an event (title,
     date, time, calendar) shown and spoken from the validated request,
     and confirmed from the tool's result. This needs the
     `calendar.events` scope (connect again).
4. Later: Haiku as a brain option (☁️ Claude Haiku), then memory, then
   contexts and the classifier, each behind its own switch and checked
   with the evals.

**Milestone "Reach"** (now, from 10 Nov 2026): make Jarvis useful first,
built and tested with **Claude as the reference brain**. If something fails
with Claude, it's the code; local brains (Qwen) are measured afterwards
with the evals, to see which jobs they can take. One PR at a time:
1. **Native tool calling for the calendar on Claude (#104).** With ☁️
   Claude and `CALENDAR=on`, Claude gets a `calendar_read` tool
   (`from`, `to`) and decides itself when to call it, instead of code
   guessing whether the question is about the calendar.
   - Code checks every call with `checkCalendarRequest` (real dates, at
     most 14 days, not too far from today), reads, and returns the same
     `calendarForBrain` text; EC events stay "EC work, handled by Kiro".
     A refused call, an unknown tool or a failed read goes back as a tool
     error, so the brain can say so.
   - At most 3 tool rounds (`MAX_TOOL_ROUNDS`); the last round gets no
     tools, so it has to answer.
   - Each call is on the path line (`by: model`); a read that worked lets
     the honesty guard pass what's on the calendar, as before.
   - **One source of truth, and less scaffolding.** With tools, Claude
     answers in its own words: no code-written opening sentence, no
     keyword-triggered "did you check?" path, and only two prompt rules
     (call the tool without announcing it; trust the list of what really
     ran). The local brain keeps the code-driven path and its sentences.
   - **The brain knows what it did earlier.** The page sends each earlier
     answer with the tool calls that really ran for it (from its path line:
     dates and counts, never titles), and the prompt lists them ("your
     answer 1: calendar_read Wed 11 Nov → 1 event"). Without this, Claude
     saw only the text of its old answers and wrongly "confessed" it had
     never checked, though every answer came from a real read.
   - The honesty guard stays a narrow safety net. Its calendar-claims check
     (built for the local brain, which invented calendar contents) is **off
     for Claude**: it kept dropping true answers, e.g. about an event Jarvis
     had just added. Fake actions, promises and perception are still dropped
     for every brain. For Local, calendar claims pass when a read (or an add)
     ran this turn, or earlier in the conversation and the question names no
     new day.
   - `TOOL_CALLING=off` brings back the code-driven path. The local brain
     always uses it (our Ollama provider doesn't do tools yet).
2. **Calendar: creating events (#110), always after your explicit OK**
   (`CALENDAR_WRITE=on`, with Claude's tools; was Trust 3b).
   - Claude gets `calendar_create` (title, date, start/end or all day).
     Code checks it (a real date, today or later, sensible times, a title,
     never EC work, which is Kiro's) and keeps it as a **pending
     proposal** in memory: random id, single use, gone after 15 minutes.
     Nothing is written to the calendar at this point.
   - The answer's path carries the proposal; the page shows a card,
     "Add to your calendar: “Work”, Wednesday 11 November, 21:00–22:00?",
     with **Add it** / **Don't add**.
   - Only **Add it** (`POST /calendar/confirm`) creates the event, with the
     one non-GET calendar call. Jarvis's reply is worded by code from
     Google's answer ("Added “Work” on Wednesday 11 November,
     21:00–22:00.") and goes into the history with its tool record.
   - The honesty guard still drops "I've added it" from the model: a
     proposal isn't an action.
   - Write access needs `CALENDAR_WRITE=on npm run calendar:connect`
     (scope `calendar.events`: events only, never settings or sharing).
     A read-only token gets a clear "connect again" message.
3. **Gmail (#112), read-only first, two accounts** (`GMAIL=on`, Claude's
   tools): `personal` and `noisysource`, each connected separately
   (`npm run gmail:connect -- <account>`, scope `gmail.readonly`, token in
   `data/google-gmail-<account>.json`, gitignored and refused by CI).
   - Claude gets `gmail_search` (account, a Gmail search, at most 10
     results: id, date, sender, subject, snippet) and `gmail_read` (one
     email's text, cut to 6,000 characters). GET calls only.
   - Code checks every call (a known account, a short query, a real id).
   - **EC email is Kiro's:** EC cues in the sender or subject, or anyone at
     `europa.eu` in From, To or Cc. It reaches Claude only as "EC email,
     handled by Kiro" (no sender, subject or id) and can't be opened.
   - Email text is marked as data, never instructions. Nothing is stored;
     logs carry counts and fixed words only. The path line shows each call.
   - Local doesn't get Gmail (no tool calling yet).
   - Later: drafts, then sending only with your OK.
4. **Skills:** saved playbooks that use tools (the Jarvis Builder backlog).
5. Later: Vendus, the daily brief (#49), phone access.

Kept as they are: EC → Kiro (precheck and the EC event filter), your OK
before any action, secrets local and never logged, the path line.
Paused: growing the honesty guard (it stays as a safety net), parity for
the local brain, further privacy work.

**Adding things back, one at a time, each behind its own switch:**
1. the profile
2. memory
3. contexts and the classifier

The personal answerer's prompt already has the who-is-who rules (the name
from the profile's `Name:` line) and the conversational style, ready for
the profile step.
**Playback reasons (#89):** the page's `/ask/spoken` report carries why
playback ended, and the server logs it as a `playback` line (numbers and
fixed words). In a stand-in test, a barge-in after the text has fully
arrived reproduces the "Sure, then silence" symptom (text complete,
`played: 0`). That's the self-interruption #85 addresses; the log on the
Mac will confirm or rule it out.

**Memory (#59–#62, #24).** Memories belong to one context and are only
loaded for it. Three kinds: **facts** (lasting things you said, preferences
included), **playbooks** (how you want recurring things done; never
permission to act) and **history** (one line per conversation, kept 30 days).
Everything goes through a `MemoryStore` interface. `MEMORY_STORE=sqlite`
(the default outside production): `node:sqlite`, `data/memory.sqlite`
(`MEMORY_DB`), mode 600, gitignored and checked in CI; deletes overwrite the
data (`secure_delete`) and a wipe compacts the file; expired history is
purged at startup and daily. `MEMORY_STORE=memory` keeps them in RAM only
(the production default until Firestore, #24, since Cloud Run's disk doesn't
last; the Pi, #53, sets `sqlite`). Ranking is shared code, so every store
orders memories the same way. Loading picks ~20 facts and playbooks by word match, then
recency, plus the 3 latest history lines; they go in the uncached prompt,
dated, as data the profile overrides. Saving is automatic after a real
answer (not clarify, handoff, unavailable or error); you review it in the
Memories panel (#62), and "don't remember this" (`remember: false`) skips
it. Rules, in the extraction prompt and again in code (#61): never EC/HRT
(the only exception mirrors the routing precheck: Noisy Source invoicing
playbooks when the invoicing exception applied, never mentioning HRT, UTP,
CASP, Recruiter Portal or colleague names); never secrets; never raw Vendus
data (the extractor never sees tool results); health, personal finances and
sensitive details about other people only on an explicit "remember that…".
Deletion is real.

How the wrap-up decides (#61): the classifier model suggests adds, updates
and deletes, each with a confidence, an `explicit` flag and a `sensitive`
label, plus the conversation's history line. Then code keeps a suggestion
only if: confidence ≥ 0.7; at most 3 new per exchange; not a duplicate;
updates and deletes only target the related memories it was shown, and
deletes only when the user asked to forget; no secret (even if asked); no
EC/HRT cue or never-remember name (`data/never-remember.txt`, gitignored)
unless it's a Noisy Source invoicing playbook under the precheck's invoicing
exception, which still may only name the EC itself, never HRT, UTP, CASP,
Recruiter Portal UTP, Cast-p, EPSO, Kiro or colleagues; no invoice/document
numbers, amounts, NIFs or customer lists outside `personal`; and health,
finance or sensitive-about-others content (by the model's label or a word
list) only when explicit. "Explicit" needs the model's flag and the user's
own words: remember, take note, lembra/lembre, guarda, não te esqueças,
anota, don't forget (any case, accents optional, whole words, not negated:
"don't remember this" and "do you remember…?" don't count). The history
line goes through the same code checks as facts (secrets, EC/HRT, business
records, sensitive) and is never explicit. Any EC question outside that
exception keeps nothing and makes no model call. An opt-out in the user's
own words ("não guardes", "não te lembres", "esquece isto", "don't
remember/keep/save this", "off the record") skips the whole exchange,
history line included, before any model call: checked in code by the
memory hooks and again by the extract step. One-off events (#71): the "still
true in a month" rule only applies to automatic saving. An explicit "remember
Diniz has football tomorrow" is kept as a fact that expires at the start of
the day after the event, in Lisbon time; the date is worked out in code from
the user's words (today/tomorrow/the day after, weekdays, dates; English and
Portuguese), then from the memory's text, then the model's date, else 30
days. Automatic one-offs, by the model's flag or words like "tomorrow", are
dropped. "Forget that…" can delete related history lines too (they can't be
edited), and an exchange that only asked to forget leaves no history line.
`src/memory-dates.ts` holds the date logic. In business contexts (KidClub,
Noisy Source) no memory may name a customer (a capitalised name that isn't a
context, weekday, month or language), and history lines stay general
("asked about an unpaid KidClub invoice"): no customers, families or who
owes what; otherwise they're dropped. `eval:memory` follows the live flow
(`handleAsk` with the same precheck, answer router and `ANSWERED_CONTEXT_IDS`
as the server, so contexts that aren't connected get no wrap-up) on a
throwaway in-memory store per case, never `data/memory.sqlite`.

**Personality (M0).** The personal answerer is warm, natural and a little
conversational: it greets back or acknowledges and adds a sentence of context
or an offer to help when chatting, answers factual questions first and
briefly, and uses a natural spoken length, usually short. The hard rules stay:
no invented personal facts, EC/HRT goes to Kiro, nothing done without the
user's OK.

**Vendus (after M0).** Assumed base URL `https://www.vendus.pt/ws/v1.1/` with
the API key as HTTP Basic username, to be verified in #7 before #8. Tools
return compact summaries, not raw payloads.

**Secrets & config.** Secret Manager: `anthropic-api-key`, later
`vendus-api-key`. The Cloud Run service account gets
`roles/secretmanager.secretAccessor` on those secrets only.

Non-secret env (`src/config.ts`, all optional locally):

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` / `development` / `test` |
| `HOST` | `127.0.0.1` (`0.0.0.0` in production) | Local server has no auth, so loopback only |
| `PORT` | `8080` | |
| `CLASSIFIER_MODEL` | `anthropic:claude-haiku-5-5` | `provider:model` |
| `ANSWER_MODEL` | `anthropic:claude-sonnet-5-5` | `provider:model` |
| `CONTEXTS_PATH` | `contexts.md` | |
| `PROFILE_SOURCE` | `file:data/profile.md` | Only `file:` for now |
| `TIMEZONE` | `Europe/Lisbon` | For "now" in the answer prompt |
| `GOOGLE_CLOUD_PROJECT` | none | **Required in production** |
| `ANTHROPIC_SECRET_NAME` | `anthropic-api-key` | Secret Manager name |
| `VENDUS_SECRET_NAME` | none | Not needed in M0 |

**Deployment (after M0).** Node 22 (22.13 or later, for `node:sqlite`), multi-stage Dockerfile, non-root (#17).
The memory wrap-up runs after the reply (#56), so Cloud Run needs CPU
allocated outside requests (instance-based billing); the deploy guide (#18)
sets it.
Cloud Run in `europe-southwest1` (Madrid) with `--no-allow-unauthenticated`
(#18). Phone access (Siri Shortcut, messaging bots) is #19.

**Quality.** Vitest unit tests with stubbed deps; CI runs lint, typecheck,
tests and build on every PR.

## Memory layers (design, #106)

Memory comes back after bare mode as layers, like a brain, one at a time,
each behind its own switch and checked with evals.

| Layer | Holds | Lasts | Today |
|---|---|---|---|
| **Working** | This conversation: the messages and the tool calls that really ran for each answer | The conversation | Done (#104): the page sends each answer's tool record; the prompt lists it |
| **Short-term** (#107) | Things just said or done: "Duarte has football tomorrow", a dated log of what Jarvis did (dates and counts only) | Days, then they expire | Partly: dated one-off memories and 30-day history lines |
| **Long-term** | Stable facts and preferences | Until changed or deleted | The SQLite memory and the profile |
| **Routine** (#108) | How things are done: playbooks, later learned skills | Until changed | Playbooks; skills in the Builder backlog |

**Built (#107, `MEMORY=on`, Claude's tools).** Jarvis remembers and recalls
by himself, and code enforces every memory rule (the same `filterSuggestions`
as before):
- `memory_remember` (text, short or long term, fact or routine, context,
  sensitivity, optionally the id it replaces). Short-term fades in 14 days,
  or the day after a dated event; long-term has no expiry. At most 3 new
  per message. "Off the record" and the page's Remembering toggle stop it.
  A real save lets "noted" through the honesty guard; a claim without one
  is still dropped.
- `memory_recall` (a few words) searches every context he works in (never
  EC/HRT) and strengthens what it finds (`touch`).
- `memory_forget` (an id it was shown), only when he asks to forget.
- Recent short-term memories are always in the prompt; long-term ones are
  recalled on demand. The path line shows every save, recall and forget.
- The older automatic wrap-up stays off in bare mode. Local doesn't get
  memory yet (no tool calling).

**Introspection (#108, decided by Renato):** a nightly job decides, for each
short-term memory, whether to drop it, make it long-term, or turn it into a
skill. Memories it may change on its own (visible and deletable in the
Memories panel); a skill or tool that would run code is a draft for his OK.

**Before each answer**, a little from each layer is loaded: all of working
memory, the most recent short-term items, the long-term facts that match the
question, and the routines that apply. The prompt stays small.

**Consolidation ("sleep", #108):** a nightly review of short-term memory and
the tool log. Items that keep coming up are proposed as long-term facts;
repeated tool sequences are proposed as routines (skills: playbooks over
existing tools). Nothing becomes permanent without Renato's OK. New tools
(code) are never built automatically: the Builder can only draft a PR.

**Never stored:** what tools fetch (calendar, email). It goes stale, so it's
read again. Memory keeps what Renato said and what Jarvis did.

The existing memory rules carry over to every layer: EC never, secrets never,
sensitive details only on an explicit "remember", deletes are real.

## Build order

**Voice:** #72 streaming answers → #73 mouth (TtsProvider: Kokoro-FastAPI,
Piper, browser; `/voices` audition page) → #74 ears (whisper.cpp with
Metal, `small.en`) → #75 turn manager (Silero VAD, end of turn after
~500 ms, barge-in, Safari echo fallback) → #76 latency (per-stage timings,
browser in the logs, sticky context decided with real numbers).


Done: #1 decisions · #2 scaffold · #3 CI

**M0: talk to Jarvis** (one PR per issue)
1. #4 types → #22 contexts.md → #5 config → #6 secrets (+ local `.env`)
2. #10 LLM interface → #25 profile → #11 classifier → #13 personal answerer
3. #23 memory hook stubs → #14 ask handler → #26 M0 ask flow
4. #15 server → #27 chat page with voice

**After M0:** #7 Vendus spike → #8 client → #9 tools → #12 KidClub answerer;
#17 Dockerfile → #18 Cloud Run deploy guide.

Backlog after M0 (labels in brackets):
- #53 Run Jarvis on the Raspberry Pi with Tailscale for phone access
  [`infra`, `backlog`]: a private alternative to Cloud Run (#17, #18).
  systemd service; `tailscale serve` for HTTPS (the mic needs it) on the
  Pi's tailnet name; an `ALLOWED_HOSTS` setting for the Host guard (#44);
  secrets in a mode-600 `.env` (needs the secrets rule updated for
  self-hosting). Nothing reachable outside the tailnet.
- #54 Local speech: Whisper for listening, Piper or Kokoro for speaking
  [`voice`, `privacy`, `backlog`]: optional server-side speech so voice
  never leaves your machines; English and pt-PT; compared on the M1 Pro and
  the Pi.
- #55 Ollama provider and model comparison [`llm`, `backlog`]: an `ollama:`
  provider behind `LlmCall`; `eval:classifier` and the profile questions
  run against any model, side by side with Claude. Defaults don't change
  until a local model passes.
- #56 (done) Memory performance [`memory`, `backlog`; before or with #24]: run the
  wrap-up after the reply is sent; skip the memory load for contexts with
  no answerer.

Memory (splits the old #24): #59 `MemoryStore` interface and hooks → #60
SQLite store (`node:sqlite`) → #61 wrap-up extraction and rules → #62 list
and delete (CLI, page panel, chat); #24 is now the Firestore store, with
deployment.

## Decisions

Confirmed in #1 (2026-11-05):

- **Models:** Claude Haiku (`claude-haiku-5-5`) for the classifier, Claude
  Sonnet (`claude-sonnet-5-5`) for answers, both behind the provider interface.
- **Endpoint auth:** Cloud Run IAM only for now; phone access is #19.
- **GCP region:** `europe-southwest1` (Madrid).
- **Secret names:** `anthropic-api-key`, `vendus-api-key`.

Confirmed for M0 (2026-11-06):

- **M0 before Vendus:** a local chat POC that answers questions about you
  from your profile comes first; Vendus and Cloud Run follow.
- **Local key:** `ANTHROPIC_API_KEY` may come from a gitignored `.env` for
  local dev only; the cloud uses Secret Manager.
- **Speech:** English by default, `pt-PT` toggle; best installed voice by
  default, with a remembered voice menu (#48).
- **Conversation mode:** on by default; the mic reopens after Jarvis speaks,
  stops on ~8 s silence, a stop phrase or a tap (#51).
- **Personality:** warm and conversational, natural spoken length instead of
  a sentence limit (#48).
- **Missing profile:** the server refuses to start.
- **Contexts:** `noisysource` added (owns invoicing the European Commission);
  `ec-hrt` (European Commission / HRT) is a handoff to Kiro, the EC's agent,
  with no tools and no memory.
- **EC precheck:** `ec-hrt` is recognised locally from cues in `contexts.md`
  and handed off without calling any model; invoicing words override the EC
  cues and route to `noisysource`.

## Out of scope for M0

Vendus, Cloud Run deployment or the Pi (#53), real memory (#24, #56),
personal data tools (Gmail, Drive, calendar), phone access (#19), local speech
(#54) and local models (#55).
