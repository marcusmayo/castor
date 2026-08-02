# /morning — Morning Briefing

Generate the day's briefing from what the agent actually tracks. Read-only:
no writes, no sends, no PII in the output.

## Inputs
- Overnight intake: `inbox/` admitted files and their `.flags.json` sidecars
  (new since yesterday), or `node scripts/intake.js --status` for counts.
- Action register: `state/action-register.md` via
  `node scripts/register.js schedule <today> 7` (overdue + due within 7 days).
- Pipeline: `state/pipeline/*.yaml` grouped by `system/pipeline-stages.yaml`.
- Calendar (only if enabled): the `calendar` capability. If
  `node scripts/setup-wizard.js --status` shows it enabled, read the ICS feed
  via `fetch-secret calendar-ics-url` and include today's and this week's
  events. If it is declined or not configured, omit the calendar section
  entirely — the deadline view below still works from the register.

## Procedure
1. Header: `# Morning Briefing — <weekday> <date>`.
2. Deadlines: run the register `schedule`. Show OVERDUE first (each: id, due,
   description), then DUE SOON. If both are empty, say "nothing due".
3. Pipeline snapshot: count items per stage in vocabulary order; call out any
   item in `blocked`, and the oldest item in `review` (nearest to done).
4. Overnight intake: number of new admitted items, how many flagged, how many
   vision-pending (awaiting interpretation), how many unscanned.
5. Calendar (if enabled): today's events, then the rest of the week.
6. Suggested first move: one line naming the single highest-leverage next action
   (e.g. an overdue item, a blocker, or interpreting a vision-pending item).

## Output
- To chat. Read-only — this skill writes nothing.

## Refusal / guardrails
- Never send. Never output PII (names may appear only as already stored in the
  register/pipeline; do not enrich or look anyone up).
- If the calendar capability is not enabled, do not attempt the ICS fetch.
- Respect every rule in CLAUDE.md.
