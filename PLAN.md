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
| `src/llm.ts` | Claude client, effort, refusal fallback, error mapping | #10 |
| `src/classify.ts` | `classify(deps, q) → kidclub \| personal \| unclear` | #11 |
| `src/vendus/client.ts` | GET-only client with path allowlist | #8 |
| `src/vendus/tools.ts` | `list_invoices`, `get_invoice` with trimmed output | #9 |
| `src/answer/kidclub.ts` | Claude + Vendus tool loop (≤ 5 rounds) | #12 |
| `src/answer/personal.ts` | Claude, no tools | #13 |
| `src/ask.ts` | `handleAsk(deps, req)`: orchestration entry point | #14 |
| `src/server.ts` | Hono: `POST /ask`, `GET /healthz`, validation, logging | #15 |

## Components

**Claude.** Official `@anthropic-ai/sdk`. Default model `claude-opus-5-5`;
effort `low` for classification, `medium` for answers. Classifier uses
structured output. Server-side refusal fallback enabled; `stop_reason` checked
before reading content.

**Vendus.** Assumed base URL `https://www.vendus.pt/ws/v1.1/` with the API key
as HTTP Basic username. **To be verified in #7 before #8.** Tools return compact
summaries (number, date, client, totals, status), not raw payloads. If Vendus
supports it, use a dedicated read-only API user as a second safety layer.

**Secrets & config.** Secret Manager: `vendus-api-key`, `anthropic-api-key`.
The Cloud Run service account gets `roles/secretmanager.secretAccessor` on
those two secrets only. Non-secret env: `GOOGLE_CLOUD_PROJECT`,
`VENDUS_SECRET_NAME`, `ANTHROPIC_SECRET_NAME`, `PORT`, `JARVIS_MODEL`.

**Deployment.** Node 22, multi-stage Dockerfile, non-root (#17). Cloud Run with
`--no-allow-unauthenticated`, so it's callable only by IAM identities (#18).

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

Proposed defaults, pending confirmation in #1:

- Model: `claude-opus-5-5` for classifier and answerer
- Endpoint auth: Cloud Run IAM only
- GCP region `europe-west1`; secret names as above

## Out of scope for v0

Conversation memory, personal data tools (Gmail, Drive, calendar), any writes
to Vendus, a chat UI.
