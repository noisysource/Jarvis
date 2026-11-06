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
| v0: KidClub invoices | Read-only Vendus tool; Cloud Run deploy | `after-m0`, `jarvis-v0` |
| After v0 | Memory in Firestore (#24), phone access (#19) | `after-v0`, `backlog` |

## Contexts

Defined in `contexts.md` (#22) and read at startup. Adding a context is a file
edit, not a code change.

| Context | Handling | Data |
|---|---|---|
| `personal` | answer | Your profile, `data/profile.md` (#25) |
| `kidclub` | answer | Vendus, read-only (after M0; "not connected yet" in M0) |
| `noisysource` | answer | None connected yet. **Invoicing the European Commission belongs here.** |
| `ec-hrt` (European Commission / HRT) | **handoff to Kiro** | None. Jarvis replies that this is for Kiro (the EC's agent) and stops: no answer model, no tools, no memory. |

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
                                             └ personal    → loadMemories (stub)
                                                             → answer model: instructions + profile + history
                                                             → wrapUp (stub)
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
| `src/memory.ts` | Memory hook stubs; `makeSafeMemoryHooks`: 2 s timeout, failures never fail a question | #23 |
| `src/ask.ts` | `handleAsk(deps, req)`: context → clarify / handoff / loadMemories → answer → wrapUp | #14 |
| `src/request.ts` | `parseAskRequest(body)`: question ≤ 2000 chars, optional context, history ≤ 20 turns × 4000 chars | #26 |
| `src/answer/router.ts` | Answerer per context; contexts without one give an `unavailable` reply ("not connected yet"), not an error | #26 |
| `src/app.ts` | `buildDeps(config)`: wires the real deps; refuses to start without contexts, profile or key | #26 |
| `src/server.ts` | Hono: `POST /ask`, `GET /healthz`, `GET /` | #15, #27 |
| `src/web/` | Chat page: `index.html`, `app.js` | #27 |
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
by default with a `pt-PT` toggle. Conversation history lives only in the page.

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

**Deployment (after M0).** Node 22, multi-stage Dockerfile, non-root (#17).
Cloud Run in `europe-southwest1` (Madrid) with `--no-allow-unauthenticated`
(#18). Phone access (Siri Shortcut, messaging bots) is #19.

**Quality.** Vitest unit tests with stubbed deps; CI runs lint, typecheck,
tests and build on every PR.

## Build order

Done: #1 decisions · #2 scaffold · #3 CI

**M0: talk to Jarvis** (one PR per issue)
1. #4 types → #22 contexts.md → #5 config → #6 secrets (+ local `.env`)
2. #10 LLM interface → #25 profile → #11 classifier → #13 personal answerer
3. #23 memory hook stubs → #14 ask handler → #26 M0 ask flow
4. #15 server → #27 chat page with voice

**After M0:** #7 Vendus spike → #8 client → #9 tools → #12 KidClub answerer;
#17 Dockerfile → #18 Cloud Run deploy guide.

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
- **Speech:** English by default, `pt-PT` toggle.
- **Missing profile:** the server refuses to start.
- **Contexts:** `noisysource` added (owns invoicing the European Commission);
  `ec-hrt` (European Commission / HRT) is a handoff to Kiro, the EC's agent,
  with no tools and no memory.
- **EC precheck:** `ec-hrt` is recognised locally from cues in `contexts.md`
  and handed off without calling any model; invoicing words override the EC
  cues and route to `noisysource`.

## Out of scope for M0

Vendus, Cloud Run deployment, real memory (#24), personal data tools (Gmail,
Drive, calendar), phone access (#19).
