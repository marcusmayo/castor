# /pipeline — Pipeline Status

Report portfolio status across governance stages. Read-only: this skill never
mutates state, never sends anything, and produces no PII in its output.

## Inputs
- Stage vocabulary: `System/pipeline-stages.yaml` (`stages`, `terminal`).
- Items: every `state/pipeline/*.yaml` EXCEPT `_item-template.yaml`, each
  conforming to that template (id, name, stage, owner, status, opened, updated,
  next_action, stakeholders, links, notes).

## Procedure
1. Read `System/pipeline-stages.yaml`. Hold `stages` (ordered) and `terminal`.
2. Read every `state/pipeline/*.yaml` except `_item-template.yaml`. If a file
   fails to parse, list it under a "could not read" note and continue — do not
   abort the whole report on one bad file.
3. For each item, check that `stage` is one of `stages`. Collect any item whose
   stage is not in the vocabulary into an "off-vocabulary" list — report it, do
   not silently bucket it elsewhere.
4. Group in-vocabulary items by `stage`, in vocabulary order. Within a stage,
   order by `updated` ascending (oldest first — the item that has sat longest).
5. Render each item as: `id  name  — owner: <owner>  updated: <updated>` and,
   if `next_action` is set and the stage is not terminal, a second line
   `      next: <next_action>`.
6. End with a one-line summary: total items, count per stage, and the count of
   off-vocabulary or unreadable items if any.

## Output
- To chat. No file is written. If there are no pipeline items, say so plainly.

## Refusal / guardrails
- Read-only. Never write to `state/pipeline/` or anywhere else.
- Never send. Never call an external interface.
- Respect every rule in CLAUDE.md.
