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
- One small issue per PR where possible.
- Before opening a PR: `npm run lint && npm run typecheck && npm test`.
- Never log or commit secrets. Secrets come only from Google Secret Manager.
- Vendus access is read-only; do not add non-GET calls.
