# /compliance-report — Unified Compliance Report (Skeleton)

Generate the unified Tier 1 (summary) / Tier 2 (evidence) report across the
nine-point posture. Read-only; output to state/weekly-reports/.

## Posture checklist (evidence sources once implemented)
1. Network exposure — deny-all NSG, no public IP (infra outputs)
2. Authentication — TOTP on web, key-only SSH, root disabled
3. PII redaction — ingest gate active; latest weekly scan result
4. Secrets — Key Vault only; nothing plaintext outside /run
5. Backup — last successful run timestamp
6. Kill switch — last rehearsal date
7. Vulnerability management — last npm audit; unattended-upgrades status
8. Audit logging — logs/audit.jsonl coverage and integrity
9. Intrusion prevention — fail2ban status and ban counts

## Steps
1. Collect evidence per control (service status, log tails, scan output).
2. Tier 1: one line per control — GREEN / AMBER / RED.
3. Tier 2: evidence excerpt per control.
4. Write state/weekly-reports/compliance-YYYY-MM-DD.md.

## Guardrails
- Read-only. Every evidence excerpt passes output sanitization.
