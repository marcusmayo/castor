# Action Register

Canonical ledger of tracked actions. The triage skill appends here; the morning
skill reads here. Managed via scripts/register.js — follow its format exactly.

IDs are `ACT-` followed by a zero-padded integer (minimum six digits). The next
ID is derived by parsing the integer of the current maximum and incrementing, so
the ledger grows past a million without the numbering or the ordering breaking.
Never sort by the ID string; sort by the parsed integer.

`estimate` is a relative duration (e.g. `2w`, `3d`, `1m`). `due` is an absolute
date (YYYY-MM-DD). If `due` is empty and `estimate` is set, the due date is
computed as opened + estimate. An explicit `due` always wins.

| id | opened | description | owner | status | pipeline | estimate | due |
|----|--------|-------------|-------|--------|----------|----------|-----|
| ACT-000001 | 2026-07-20 | Example: score the five epics for ranking | platform | open | triage | 2w | |
| ACT-000002 | 2026-07-22 | Example: safety interlock certification evidence | safety | in-progress | in-progress | | 2026-08-15 |
