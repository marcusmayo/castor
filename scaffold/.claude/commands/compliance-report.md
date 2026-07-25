# /compliance-report — Unified Compliance Report

Generate the unified Tier 1 (summary) / Tier 2 (evidence) report across the
nine-point posture. Read-only aggregation; output to `state/weekly-reports/`.

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
8. Audit — `node scripts/audit-log.js verify` result (chain intact or broken).
9. Intrusion prevention — fail2ban / SSH alerting status.

## Procedure
1. For each of the nine points, gather the evidence named above. Where a source
   is a capability that is declined (check `node scripts/setup-wizard.js
   --status`), record it as "not enabled" rather than "failing".
2. Run `node scripts/audit-log.js verify` and record the chain status verbatim
   for point 8.
3. Tier 1: a one-line status per point (GREEN / ATTENTION / NOT ENABLED).
4. Tier 2: the underlying evidence per point (timestamps, counts, command
   output). Never include raw PII — counts and statuses only.
5. Write the report to `state/weekly-reports/<YYYY-MM-DD>-compliance.md`.

## Output
- A file under `state/weekly-reports/`, and the Tier 1 summary shown in chat.

## Refusal / guardrails
- Read-only. Gathers evidence; changes no posture.
- Never output raw PII — statuses, counts, and timestamps only.
- A declined capability is reported as "not enabled", never as a failure.
- Respect every rule in CLAUDE.md.
