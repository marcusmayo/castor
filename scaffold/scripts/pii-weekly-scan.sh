#!/usr/bin/env bash
# pii-weekly-scan.sh — weekly full-tree PII/secret sweep.
# Reuses the gate PATTERNS via scan-tree.js so it can never drift from the
# ingest and pre-commit gates. Findings are logged; a non-zero exit signals
# hits so cron/alerting can react. This is the backstop for anything that
# slipped past the ingest gate.
set -euo pipefail
ROOT="${AGENT_ROOT:-$HOME/castor}"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG="$LOG_DIR/pii-scan.log"

# Scan state/ and knowledge/ and inbox/ — where operator data lives. Not the
# code tree (gate patterns live there legitimately).
set +e
OUT="$(node "$ROOT/scripts/scan-tree.js" "$ROOT/state" 2>&1; \
       node "$ROOT/scripts/scan-tree.js" "$ROOT/knowledge" 2>&1; \
       node "$ROOT/scripts/scan-tree.js" "$ROOT/inbox" 2>&1)"
RC=$?
set -e

if echo "$OUT" | grep -q "finding(s)"; then
  echo "[$STAMP] PII SCAN FINDINGS:" >> "$LOG"
  echo "$OUT" | grep -A1000 "finding(s)" >> "$LOG"
  echo "$OUT" | grep "finding(s)"
  echo "pii-weekly-scan: findings logged to $LOG" >&2
  exit 1
fi
echo "[$STAMP] PII SCAN clean" >> "$LOG"
echo "pii-weekly-scan: clean"
exit 0
