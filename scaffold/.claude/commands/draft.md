# /draft — Communication Drafter

Draft a communication in the operator's voice. Output to the draft queue for
review — this skill NEVER sends.

## Inputs
- `System/voice-profile.yaml` — tone, structure, and phrasing to match.
- The relevant stakeholder page in `knowledge/people/<name>.md` if the draft is
  addressed to or about a tracked person. If no page exists, proceed without it
  and note that no stakeholder context was found — do not invent details.
- The operator's stated intent for the message (the prompt).

## Procedure
1. Load `System/voice-profile.yaml`. If it is missing or still a template,
   state that the voice profile is not yet populated and draft in a neutral
   professional register.
2. If a recipient/subject maps to a `knowledge/people/*.md` page, read it for
   relationship context and open threads. Use it to inform tone and references
   only — never to add facts the operator did not supply.
3. Write the draft to `state/draft-queue/<YYYY-MM-DD>-<slug>.md` with a short
   header (intended recipient, subject, and that it is UNSENT).
4. Show the draft in chat and state where it was saved. Stop there — the
   operator reviews and sends through the review loop (webchat / Telegram).

## Output
- A file under `state/draft-queue/`, and the draft shown in chat.

## Refusal / guardrails
- NEVER send. No external interface is called by this skill.
- Never output PII beyond what the operator supplied or what is already on the
  stakeholder page. Do not look anyone up.
- Propose, don't mutate anything beyond writing the draft file.
- Respect every rule in CLAUDE.md.
