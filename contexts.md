# Jarvis contexts

Each `## id` section is one context. Jarvis reads this file at startup and
refuses to start if it's invalid. Ids use lowercase letters, digits and `-`.

Fields (one `Key: value` per line):

- `Name`, `Description`, `Data`, `Tools` (required). `Tools` is a comma list
  of known tools (`vendus`) or `none`. The classifier reads the name and
  description, so write the description for it.
- `Aliases` (optional): other names for the context, comma-separated. After
  Jarvis asks "which context?", typing or saying a context's name, id or
  alias picks it.
- `Handling`: `answer` (default) or `handoff`.
- `Handoff to`: who handles a handoff context (required for `handoff`).
- `Recognition cues` (handoff only): comma list of words or phrases checked
  locally before any model runs. A match hands off immediately. Matching is
  whole-word and ignores accents; cues written in ALL CAPS (`EC`) are
  case-sensitive, all others ignore case. A hyphen in a cue matches a hyphen,
  a space or nothing (`Cast-p` matches "Cast P" and "CastP").
- `Unless` (handoff only, may repeat): `word, word -> context-id`. If one of
  these words appears together with a cue, the question goes to that context
  instead of being handed off.

## personal
Name: Personal
Description: My own life, not my businesses: me, my family, home, health, preferences, routines, plans and anything in my personal profile. Also the default for anything that needs no business data: greetings, small talk, thanks, general-knowledge questions and questions about Jarvis itself.
Data: My profile (data/profile.md)
Tools: none
Aliases: pessoal, me, myself

## kidclub
Name: KidClub
Description: The KidClub business: its invoices, clients, sales, staff, suppliers and day-to-day running.
Data: Vendus (invoices, clients), read-only. Not connected yet.
Tools: none

## noisysource
Name: Noisy Source
Description: The Noisy Source business: its clients, projects, finances and admin, including invoicing and billing the European Commission.
Data: None connected yet.
Tools: none

## ec-hrt
Name: European Commission / HRT
Description: Work done for the European Commission / HRT itself: its projects, systems, colleagues, meetings and documents. Not invoicing or billing the Commission, which is Noisy Source.
Data: None. Handled by Kiro.
Tools: none
Handling: handoff
Handoff to: Kiro (the EC's agent)
Recognition cues: European Commission, Comissão Europeia, EC, HRT, EPSO, CASP, Cast-p, Recruiter Portal UTP, UTP, Kiro
Unless: invoice, invoices, invoiced, invoicing, bill, billing, fatura, faturas, faturar, faturação, factura, facturas -> noisysource
