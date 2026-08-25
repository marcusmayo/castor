#!/usr/bin/env bash
# azure-backup.sh — daily encrypted backup of state/ and knowledge/ to Azure Blob.
#
# Gated on the azure_backup capability. Authenticates with the VM's managed
# identity (no storage keys on disk). If the capability is declined or azcopy is
# absent, it exits cleanly with a stated reason rather than failing the cron.
set -euo pipefail
ROOT="${AGENT_ROOT:-$HOME/castor}"

# Capability gate — declined means skip, not fail.
STATE_FILE="$ROOT/state/capabilities.json"
if [ -f "$STATE_FILE" ]; then
  if ! grep -q '"azure_backup"[^}]*"enabled"' "$STATE_FILE"; then
    echo "azure-backup: azure_backup capability not enabled — skipping"; exit 0
  fi
else
  echo "azure-backup: no capability state — run the setup wizard; skipping"; exit 0
fi

: "${BACKUP_STORAGE_ACCOUNT:?BACKUP_STORAGE_ACCOUNT not set}"
: "${BACKUP_CONTAINER:?BACKUP_CONTAINER not set}"

if ! command -v azcopy >/dev/null 2>&1; then
  echo "azure-backup: azcopy not installed — cannot back up" >&2; exit 1
fi

STAMP="$(date -u +%Y%m%d)"
azcopy login --identity >/dev/null 2>&1 || { echo "azure-backup: managed-identity login failed" >&2; exit 1; }
DEST="https://${BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/${BACKUP_CONTAINER}/${STAMP}/"
azcopy copy "$ROOT/state" "$DEST" --recursive >/dev/null
azcopy copy "$ROOT/knowledge" "$DEST" --recursive >/dev/null
echo "azure-backup: state/ and knowledge/ backed up to ${BACKUP_CONTAINER}/${STAMP}/"
exit 0
