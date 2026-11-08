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
| `src/web/mic*.js` | Records one utterance (AudioWorklet), finds its end (level-based endpointer), encodes 16 kHz WAV | #74 |
| `src/service-starting.ts` | "Starting" rather than "not running" while `voice:up` waits for a service | #80 |
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
step, no external scripts. Browser speech recognition and synthesis; English
by default with a `pt-PT` toggle. The voice is picked automatically (exact
region first, then Premium > Enhanced > Natural/Neural/Online, then the system
default), with a voice menu whose choice is remembered per language in
localStorage. Conversation history lives only in the page.

**Conversation mode (M0, #51).** A toggle, on by default and remembered. In a
spoken conversation the mic reopens about 0.4 s after speech synthesis
finishes (never during; right away if muted). It closes after ~8 s of silence
(resuming if the browser gives up sooner), on a whole-utterance stop phrase
("that's all", "stop", "obrigado", "é tudo" and small variants; not sent to
the server), or on the Stop tap. Typing ends the spoken conversation. If the
browser refuses an automatic start (`not-allowed`, or `start()` throws), it's
paused for the page and the normal mic button remains, with a note.

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
  `--print-realtime` (it doesn't print what it heard). The page records one
  utterance through an AudioWorklet, finds where speech starts and ends with
  a level-based endpointer (noise floor learnt before speech, 900 ms pause
  ends it, 8 s of nothing gives up, ~55 s at most; replaced by Silero VAD in
  #75), keeps 300 ms before speech, downsamples to 16 kHz and sends a WAV to
  `POST /transcribe` (`audio/wav` only, so a cross-site form needs a
  preflight this server never answers; 2 MB). The text comes back to the
  page, which sends it to `/ask` like typed text, so the **local EC precheck
  runs first** and an EC question reaches no model or memory. The
  browser's Web Speech recognition (audio to Google/Apple) is no longer
  used, with no fallback: if Whisper isn't running the page says so.
  **English only for now**: in Portuguese the mic is disabled with a note
  (a multilingual model is a later decision).

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
