# Jarvis — Plan & Architecture (v0)

Jarvis is a personal AI orchestrator. v0 is deliberately small: one HTTP endpoint
that answers a question, routes it to **KidClub** (the business) or **personal**,
asks which when it can't tell, and answers KidClub invoice questions with a
read-only Vendus API tool.

Work is tracked in GitHub Issues (label `jarvis-v0`) and the **Jarvis** project
board (Backlog → To Do → In Progress → Review → Done). Every PR closes an issue.

## Request flow

```
POST /ask { question, domain? }
   │
   ├─ domain given? ──yes──────────────────────────┐
   │                                               │
   └─ no → classify(question) → kidclub | personal | unclear
                                    │        │         │
                                    │        │         └─► { type: "clarify",
                                    │        │               message: "Is this about KidClub or something personal?",
                                    │        │               options: ["kidclub","personal"] }
                                    ▼        ▼
                         answerKidClub   answerPersonal
                         (Claude + Vendus  (Claude, no tools)
                          read-only tools)
                                    │
                                    └─► { type: "answer", domain, answer }
```

The service is **stateless**: after a clarify response, the client re-sends the
same question with `domain` set. No session store, no sticky instances.

## Principles

- **Pure functions and types, no classes.** Enforced by lint. Dependencies
  (LLM calls, Vendus GET, clock) are passed in as plain `Deps` objects so all
  core logic is unit-testable with stubs. Library-provided objects (Anthropic
  SDK client, Secret Manager client) are consumed, never defined.
- **Never guess the domain.** Ambiguous → ask.
- **Read-only by construction** for Vendus: the client only exposes `GET`, and
  paths are checked against an allowlist before any network call.
- **Secrets only from Secret Manager**, fetched once per process, never logged.

## Module layout

| File | Responsibility | Issue |
|---|---|---|
| `src/types.ts` | Domain, AskRequest, AskResponse (discriminated union), Deps | #4 |
| `src/config.ts` | `loadConfig(env)`: pure, zod-validated | #5 |
| `src/secrets.ts` | Secret Manager access, memoised | #6 |
| `src/llm/types.ts` | Provider-neutral types: `LlmCall`, `LlmRequest`, `LlmResponse`, `ModelRef` | #10 |
| `src/llm/anthropic.ts` | Anthropic provider: effort, refusal handling, error mapping | #10 |
| `src/llm/registry.ts` | `makeLlm(config)`: picks the provider from `provider:model` config | #10 |
| `src/classify.ts` | `classify(deps, q) → kidclub \| personal \| unclear` | #11 |
| `src/vendus/client.ts` | GET-only client with path allowlist | #8 |
| `src/vendus/tools.ts` | `list_invoices`, `get_invoice` with trimmed output | #9 |
| `src/answer/kidclub.ts` | Claude + Vendus tool loop (≤ 5 rounds) | #12 |
| `src/answer/personal.ts` | Claude, no tools | #13 |
| `src/ask.ts` | `handleAsk(deps, req)`: orchestration entry point | #14 |
| `src/server.ts` | Hono: `POST /ask`, `GET /healthz`, validation, logging | #15 |

## Components

**Models, behind a provider interface.** All model calls go through one
provider-neutral function type:

```ts
type LlmCall = (req: LlmRequest) => Promise<Result<LlmResponse, LlmError>>;
// LlmRequest:  { system, messages, tools?, outputSchema?, effort?, maxTokens }
// LlmResponse: { kind: "text", text } | { kind: "tool_calls", calls } | { kind: "json", value }
```

Each provider is a module that exports a factory `(apiKey, model) => LlmCall`
(pure functions, no classes). Models are picked by config as
`provider:model` strings, one per role:

- Classifier: `CLASSIFIER_MODEL=anthropic:claude-haiku-5-5`, effort `low`
- Answers: `ANSWER_MODEL=anthropic:claude-sonnet-5-5`, effort `medium`

Adding Gemini or Grok later means adding one provider module and its API-key
secret, then changing those env vars; nothing else changes. Because of that,
the KidClub tool loop is written in our own code over `LlmCall` rather than
using a vendor SDK's tool runner.

Anthropic provider: official `@anthropic-ai/sdk`; checks `stop_reason` before
reading content; turns `refusal` / `max_tokens` into typed errors. Sonnet calls
use the server-side refusal fallback (`fallbacks: "default"`); Haiku has no
server-side fallback, so a refused classification simply becomes `unclear`.

**Vendus.** Assumed base URL `https://www.vendus.pt/ws/v1.1/` with the API key
as HTTP Basic username. **To be verified in #7 before #8.** Tools return compact
summaries (number, date, client, totals, status), not raw payloads. If Vendus
supports it, use a dedicated read-only API user as a second safety layer.

**Secrets & config.** Secret Manager: `vendus-api-key`, `anthropic-api-key`
(one API-key secret per model provider in use). The Cloud Run service account
gets `roles/secretmanager.secretAccessor` on those secrets only. Non-secret env:
`GOOGLE_CLOUD_PROJECT`, `VENDUS_SECRET_NAME`, `ANTHROPIC_SECRET_NAME`, `PORT`,
`CLASSIFIER_MODEL`, `ANSWER_MODEL`.

**Deployment.** Node 22, multi-stage Dockerfile, non-root (#17). Cloud Run in
`europe-southwest1` (Madrid) with `--no-allow-unauthenticated`, so it's
callable only by IAM identities (#18). Phone access (Siri Shortcut, messaging
bots) needs its own auth method and is tracked separately in the backlog.

**Quality.** Vitest unit tests with stubbed deps; CI runs lint, typecheck and
tests on every PR (#3). Local stub mode for trying it without keys (#16).

## Build order

1. #1 decisions · #2 scaffold · #3 CI
2. #4 types · #5 config · #6 secrets · #10 llm
3. #7 Vendus spike → #8 client → #9 tools
4. #11 classify · #12 KidClub answerer · #13 personal answerer
5. #14 ask handler → #15 server → #16 stub dev mode
6. #17 Dockerfile → #18 deploy guide

## Decisions

Confirmed in #1 (2026-11-05):

- **Models:** Claude Haiku (`claude-haiku-5-5`) for the classifier, Claude
  Sonnet (`claude-sonnet-5-5`) for answers, both behind the provider interface
  so other providers (e.g. Gemini, Grok) are a config change.
- **Endpoint auth:** Cloud Run IAM only for now. Phone access (Siri Shortcut,
  messaging bots) and its auth method are a backlog item.
- **GCP region:** `europe-southwest1` (Madrid).
- **Secret names:** `vendus-api-key`, `anthropic-api-key`.
- **Everything else** in this plan and in the v0 issues is approved as written.

## Out of scope for v0

Conversation memory, personal data tools (Gmail, Drive, calendar), any writes
to Vendus, a chat UI, phone access via Siri Shortcut or messaging bots (#19).
