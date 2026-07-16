# /pipeline — Pipeline Status (Skeleton)

Report portfolio status across governance stages from the YAML item files in
state/pipeline/. Read-only — this skill never mutates state.

## Data source
One YAML per project/use case in state/pipeline/, conforming to
state/pipeline/_item-template.yaml.

## Steps
1. Load every state/pipeline/*.yaml (skip _item-template.yaml).
2. Group items by `stage`; within each stage, order by `updated` ascending.
3. Flag stale items (`updated` older than [N] days) and any `status: blocked`.
4. Surface each item's `next_action` (what / who / due); flag overdue dates.
5. Output: per-stage summary, then an exceptions list (stale / blocked / overdue).

## Guardrails
- Read-only. Item updates go through /triage proposals + operator confirmation.
- Names only in output — no contact details (CLAUDE.md).
