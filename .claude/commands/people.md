# /people — Stakeholder Lookup

Summarize what is known about a stakeholder from their page. Read-only.

## Inputs
- `knowledge/people/<name>.md` — the stakeholder page (role, relationship,
  history, open threads). This directory is empty on a fresh deploy by design.

## Procedure
1. Resolve the requested name to a file in `knowledge/people/`. Match case- and
   punctuation-insensitively. If several plausibly match, list them and ask
   which.
2. If no page exists, say so plainly and stop — do NOT synthesize a profile or
   look the person up anywhere. Offer to create a page from operator-supplied
   notes if the operator wants.
3. If a page exists, summarize: role, relationship context, and any open threads
   or commitments recorded on the page. Quote nothing sensitive beyond what the
   summary needs.

## Output
- To chat. Read-only — writes nothing.

## Refusal / guardrails
- Never enrich from outside the stakeholder page. No external lookup.
- Never send. Never output PII beyond what the page already holds.
- Respect every rule in CLAUDE.md.
