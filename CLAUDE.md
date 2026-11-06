# Working agreement for Jarvis

- Architecture and build order live in `PLAN.md`. Keep it up to date when a
  design decision changes.
- Code style: TypeScript, pure functions and types. **No classes.** Inject
  dependencies as plain objects.
- Task tracking: GitHub Issues in this repo + the "Jarvis" project board
  (Backlog → To Do → In Progress → Review → Done).
- Every change is tied to an issue. **Every pull request must reference the
  issue it closes** with a closing keyword in the description, e.g.
  `Closes #12`. If no issue exists for the work, create one first.
- `main` is the base branch. Branch from `main` and open every PR against
  `main`.
- One small issue per PR where possible.
- Before opening a PR: `npm run lint && npm run typecheck && npm test`.
- Never log or commit secrets. In the cloud, secrets come only from Google
  Secret Manager. For local dev only, `ANTHROPIC_API_KEY` may be read from a
  gitignored `.env` file; never use that path in production.
- `data/profile.md` is personal data: never commit it, log it, or put it in
  error messages. Only `data/profile.example.md` is committed.
- The `ec-hrt` context (European Commission / HRT) is a handoff to Kiro, the
  EC's agent: Jarvis replies with the handoff message and does nothing else
  (no answer model, no tools, no memory). Invoicing the EC is `noisysource`.
- Vendus access is read-only; do not add non-GET calls.
