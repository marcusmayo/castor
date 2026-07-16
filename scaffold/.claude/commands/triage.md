# /triage — Message Triage (Skeleton)

Triage items in inbox/: classify, assign action numbers, propose pipeline
updates, archive processed messages.

## Steps
1. Read each item in inbox/; classify (action / info / discard).
2. Assign the next action number; append to state/action-register.md.
3. If a message affects a tracked item, PROPOSE the edit to the matching
   state/pipeline/<id>.yaml as a shown diff — apply only on explicit operator
   confirmation. Propose, don't mutate.
4. Move processed messages to inbox/archive/.

## Guardrails
- Respect every rule in CLAUDE.md.
- No external sends. No PII output. No unconfirmed state mutation.
