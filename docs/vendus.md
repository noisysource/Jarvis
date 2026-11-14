# Vendus API, as Jarvis uses it (#7)

Checked 2026-11-14. Sources: the monorepo's working client
(`noisysource/noisysource`, `functions/src/kidclub/vendus.ts`, checked
against live Vendus in October 2026), and Vendus's own docs:
[authentication](https://www.vendus.pt/ws/v1.1/authentication.doc),
[requests](https://www.vendus.pt/ws/v1.1/requests.doc),
[responses](https://www.vendus.pt/ws/v1.1/responses.doc),
[help: implementar a API](https://www.vendus.pt/ajuda/implementar-api-vendus/).

## Contract

- **Base URL:** `https://www.vendus.pt/ws/v1.1`
- **Auth:** the API key as `Authorization: Bearer <key>` (Vendus also takes
  HTTP Basic with the key as the username, or an `api_key` query parameter;
  Jarvis uses Bearer only, so the key never ends up in a URL).
- **The key belongs to a Vendus user.** Every request is that user's, and it
  can do only what that user may. Each activated user has its own key
  (APPS → API in the back office).
- **List documents:** `GET /documents/?since=YYYY-MM-DD&until=YYYY-MM-DD&type=FR&per_page=50&page=N`.
  `date_from`/`date_to` are refused (403 P001). Pages start at 1. An empty
  page is **404 with `errors[].code` "A001"** ("No data"), not `[]`.
  Rows carry `id`, `number`, `date`, `amount_gross`, `amount_net` (decimal
  strings).
- **One document:** `GET /documents/{id}/`, with `client`, `taxes[]`
  (`rate`, `base`, `amount`) and `items[]`.
- **Rate limits:** none documented. Jarvis reads at most 20 pages (1,000
  documents) per question and a period of at most 400 days.

## How Jarvis is kept read-only

1. **At Vendus:** a Vendus user of its own for Jarvis, with the fewest
   rights Vendus allows (it only needs to see documents). Whether Vendus has
   a pure read-only role wasn't confirmed: check the user's permissions when
   you create it.
2. **In code:** `src/vendus/vendus.ts` has one HTTP method, GET; two paths
   (`/documents/` and `/documents/{numeric id}/`); and five query fields.
   Anything else is refused before any network call (tested).

## Not used

Clients, products, PDFs, and anything that creates or changes a document.
KidClub's own invoicing (in the monorepo's functions) is unchanged.
