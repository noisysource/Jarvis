# Manual check: answers from the example profile

For checking the personal answerer against the real model. Copy
`data/profile.example.md` to `data/profile.md` (or point `PROFILE_SOURCE` at
the example), then ask each question with `npm run ask "…"` and compare.
Exact wording will vary; what matters is the fact, or a plain "your profile
doesn't say" for the second list. No guessing.

## Answerable from the profile

| Question | Expected |
|---|---|
| What's my daughter's name? | Inês |
| How old is my daughter? | 9 (born 2 September 2017; today's date from the prompt) |
| When is Inês's next birthday, and how many days away is it? | 2 September 2027, about 300 days from 6 Nov 2026 |
| What's my partner's name and job? | Sam, an architect |
| Where do I live? | Lisbon, Campo de Ourique (address if asked) |
| Am I allergic to anything? | Penicillin |
| Who's my doctor? | Dra. Marta Silva, Centro de Saúde Exemplo |
| Which days do I go to the gym? | Monday, Wednesday and Friday at 07:30 |
| What does Inês do on Tuesdays? | Swimming at 18:00 |
| When does my passport expire? | 10 January 2030 |
| How do I take my coffee? | Espresso, no sugar |
| What's my car's plate? | AA-00-BB |
| Quando faz anos a minha filha? | 2 de setembro (answered in Portuguese) |

## Not in the profile: Jarvis should say so

| Question | Expected |
|---|---|
| What's my blood type? | Profile doesn't say |
| What's Inês's teacher called? | Profile doesn't say (school is known, teacher isn't) |
| When is Sam's birthday? | Profile doesn't say |
| What's my mother's phone number? | Profile doesn't say |
| How much do I weigh? | Profile doesn't say |

## General questions: answered normally

| Question | Expected |
|---|---|
| What's the capital of Australia? | Canberra |
| What day of the week is it? | The weekday from the prompt's "Now" line |
| How many days until Christmas? | Counted from today's date |
