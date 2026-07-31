# /compliance-report — Unified Compliance Report

Generate the unified Tier 1 (summary) / Tier 2 (evidence) report across the
nine-point posture. Read-only aggregation; the report is shown in chat (Tier 1 + Tier 2). No file is written.

## Posture checklist and evidence sources
1. Network exposure — deny-all NSG, no public IP (infrastructure outputs).
2. Authentication — TOTP on web, key-only SSH, root disabled.
3. PII redaction — ingest tripwire active; most recent `pii-weekly-scan` result.
4. Secrets — Key Vault only via managed identity; nothing plaintext outside the
   runtime decrypt path.
5. Backup — last successful `azure-backup` run timestamp (or "capability
   declined" if the azure_backup capability is off).
6. Kill switch — last rehearsal date recorded.
7. Vulnerability management — last `npm audit` / update run.
8. Audit — chain verification result from `state/compliance/audit-verify.json` (intact or broken).
9. Intrusion prevention — fail2ban / SSH alerting status.

## Procedure
Evidence is refreshed server-side immediately before this report runs and written
to `state/compliance/` (deterministic; the report never invokes node and never
searches the filesystem). Derive every point's status ONLY from the rules below.
Never infer status from code presence, `node_modules`, config-file contents,
capability descriptions, or any file outside `state/compliance/`.

Status vocabulary is exactly three values — GREEN, ATTENTION, NOT ENABLED.
Do not introduce any other status label anywhere in the report.

1. Point 8 (Audit): read `state/compliance/audit-verify.json`. If its `output`
   reports the chain intact, GREEN; if broken, ATTENTION. Record the `output`
   and `ranAt`.
2. Point 5 (Backup): read `state/compliance/capability-status.json`. If the
   `azure_backup` capability is enabled, GREEN; if it is not configured or
   declined, NOT ENABLED. Record the relevant line and `ranAt`.
3. Points 1, 2, 3, 4, 6, 7, and 9: no evidence file exists for these in
   `state/compliance/`, so each is ATTENTION — the control may be provisioned
   at the infrastructure layer but is not verifiable from agent-side evidence.
   Do not search for, infer, or substitute alternative evidence for these points.
4. Tier 1: a table of one-line statuses, one row per point, using only the three
   permitted values, followed by a verdict line counting each value.
5. Tier 2: the underlying evidence per point. For points 5 and 8, the state-file
   `output` and `ranAt`. For every ATTENTION point, the fixed line: "No evidence
   file in state/compliance/; provision an evidence writer to confirm." Never
   include raw PII — counts and statuses only.

## Output
- The Tier 1 summary and Tier 2 evidence, shown in chat. No file is written.

## Refusal / guardrails
- Read-only. Gathers evidence; changes no posture.
- Never output raw PII — statuses, counts, and timestamps only.
- A declined capability is reported as "not enabled", never as a failure.
- Respect every rule in CLAUDE.md.
