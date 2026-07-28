#!/usr/bin/env bash
# clean_demo.sh - reset Castor's SYNTHETIC demo to a clean state (mirrors Keel).
#
# Removes ONLY oracle-generated demo artifacts under AGENT_ROOT: the seeded
# corpus, intake sidecars/archive/quarantine, the intake ledger, the drafted
# register row, and generated digests. PRESERVES secrets (castor.env), code,
# the container, the egress config (gate/never-egress.json), the audit chain
# (logs/audit.jsonl - provenance; a truly clean PROD agent is a fresh deploy on
# an empty volume), and all structural scaffolding (templates, .gitkeep files).
# Scoped by design - never a blanket rm or git clean.
#
# Run INSIDE the Castor container against /app:
#   docker exec -w /app castor-webchat bash clean_demo.sh --yes
# Throwaway / CI against a repo copy used as AGENT_ROOT:
#   AGENT_ROOT=<repo-copy> CASTOR_ORACLE_ALLOW_HOST=1 bash clean_demo.sh --yes
#
# After this, `bash run_e2e.sh --yes` regenerates everything.
set -uo pipefail

AGENT_ROOT="${AGENT_ROOT:-/app}"

# --- host guard (parity with run_e2e: refuse to touch a host tree by accident) ---
if [ ! -f /.dockerenv ] && [ "${CASTOR_ORACLE_ALLOW_HOST:-}" != "1" ]; then
  echo "ERROR: clean_demo.sh runs INSIDE the Castor container." >&2
  echo "  docker exec -w /app castor-webchat bash clean_demo.sh --yes" >&2
  echo "  (CI/throwaway: AGENT_ROOT=<repo-copy> CASTOR_ORACLE_ALLOW_HOST=1 bash clean_demo.sh --yes)" >&2
  exit 2
fi

# --- destructive guard ---
if [ "${1:-}" != "--yes" ]; then
  echo "clean_demo.sh removes DEMO-GENERATED artifacts under AGENT_ROOT=$AGENT_ROOT."
  echo "It does NOT delete secrets (castor.env), code, the container, the egress"
  echo "config, or the audit chain. To proceed:  bash clean_demo.sh --yes"
  exit 1
fi

A="$AGENT_ROOT"
echo "=== resetting Castor demo under $A ==="

# 1. inbox: seeded drop, admitted copies + sidecars (inbox root), archive, quarantine.
#    Preserve the four dir mount points; remove only their contents.
if [ -d "$A/inbox" ]; then
  find "$A/inbox" -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true
  for d in drop archive quarantine; do
    [ -d "$A/inbox/$d" ] && find "$A/inbox/$d" -mindepth 1 -delete 2>/dev/null
  done
  echo "  cleared inbox/ (drop, admitted, sidecars, archive, quarantine)"
fi

# 2. state: intake ledger + generated digests + any drafted pipeline items.
#    PRESERVE templates (_item-template.yaml, _states.md, _daily-log-template.md)
#    and every .gitkeep.
rm -f "$A/state/intake-ledger.json" 2>/dev/null && echo "  removed state/intake-ledger.json"
if [ -d "$A/state/weekly-reports" ]; then
  find "$A/state/weekly-reports" -type f -name '*-digest.md' -delete 2>/dev/null || true
  echo "  cleared state/weekly-reports/*-digest.md"
fi
if [ -d "$A/state/pipeline" ]; then
  find "$A/state/pipeline" -type f ! -name '_item-template.yaml' -delete 2>/dev/null || true
fi

# 3. action-register: restore the pristine tracked copy in a git repo (repo-copy
#    runs), or remove the demo-created file in the container (no git there).
if git -C "$A" rev-parse --git-dir >/dev/null 2>&1 \
   && git -C "$A" ls-files --error-unmatch state/action-register.md >/dev/null 2>&1; then
  git -C "$A" checkout -- state/action-register.md 2>/dev/null \
    && echo "  restored state/action-register.md from git"
else
  rm -f "$A/state/action-register.md" 2>/dev/null && echo "  removed state/action-register.md (demo-created)"
fi

echo "=== clean. Re-run the demo with: bash run_e2e.sh --yes ==="
