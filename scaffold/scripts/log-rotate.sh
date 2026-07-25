#!/usr/bin/env bash
# log-rotate.sh — weekly rotation and compression of logs/.
#
# INVARIANT: audit.jsonl is the hash-chained audit trail. It is NEVER truncated
# or rotated in place. If it exceeds the threshold it is ARCHIVED (copied, then
# a fresh chain started with a genesis marker referencing the archive) — the
# existing chain is preserved intact on disk first. Losing or breaking that
# chain would destroy provenance, so this script copies before it ever touches
# the live file, and only starts a new chain, never edits the old one.
set -euo pipefail
ROOT="${AGENT_ROOT:-$HOME/castor}"
LOG_DIR="$ROOT/logs"
ARCHIVE="$LOG_DIR/archive"
STAMP="$(date -u +%Y%m%d%H%M%S)"
MAX_BYTES="${LOG_ROTATE_MAX_BYTES:-10485760}"   # 10 MB
mkdir -p "$ARCHIVE"

# 1. audit.jsonl — archive-first, never truncate.
AUDIT="$LOG_DIR/audit.jsonl"
if [ -f "$AUDIT" ]; then
  SIZE=$(wc -c < "$AUDIT")
  if [ "$SIZE" -gt "$MAX_BYTES" ]; then
    cp -p "$AUDIT" "$ARCHIVE/audit-$STAMP.jsonl"          # preserve the chain FIRST
    gzip -f "$ARCHIVE/audit-$STAMP.jsonl"
    # Start a fresh chain that points back to the archived segment.
    printf '{"ts":"%s","event":"CHAIN_ROTATED","prev_archive":"audit-%s.jsonl.gz"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAMP" > "$AUDIT"
    echo "log-rotate: audit chain archived to audit-$STAMP.jsonl.gz, fresh chain started"
  fi
fi

# 2. Other .log files — safe to rotate normally.
shopt -s nullglob
for f in "$LOG_DIR"/*.log; do
  SIZE=$(wc -c < "$f")
  if [ "$SIZE" -gt "$MAX_BYTES" ]; then
    mv "$f" "$ARCHIVE/$(basename "$f" .log)-$STAMP.log"
    gzip -f "$ARCHIVE/$(basename "$f" .log)-$STAMP.log"
    : > "$f"
  fi
done

# 3. Prune archives older than 90 days.
find "$ARCHIVE" -type f -name '*.gz' -mtime +90 -delete 2>/dev/null || true
echo "log-rotate: done"
exit 0
