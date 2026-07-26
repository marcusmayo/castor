#!/usr/bin/env bash
# run_e2e.sh — Castor end-to-end acceptance oracle, one command.
#
# Drives the full Castor pipeline in canonical order against SYNTHETIC data and
# verifies each lane, mirroring Keel's oracle. LOUD by design: a deterministic
# step that fails STOPS the run with a banner naming the missing prerequisite; a
# model-dependent step with no key/CLI SKIPS loudly (never silently) and is listed
# in the summary. Guards are structural enforcement, not documentation.
#
# Run INSIDE the Castor container against /app:
#   docker exec -w /app castor-webchat bash run_e2e.sh --yes
# Throwaway-container / CI run against a repo copy used as AGENT_ROOT:
#   AGENT_ROOT=<repo-copy> CASTOR_ORACLE_ALLOW_HOST=1 bash run_e2e.sh --yes
#
# Lanes: seed -> gate/egress -> intake -> pending(webchat) -> register
#        -> model-routing -> digest -> jobs(health/scan/audit) -> [skill via claude -p]
#
# DESTRUCTIVE to demo state under AGENT_ROOT: run on a FRESH agent before real data.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"        # code root — scripts/ resolve here
AGENT_ROOT="${AGENT_ROOT:-/app}"             # data root — sidecars/state/logs live here
FIX="$ROOT/tests/fixtures"
export AGENT_ROOT
cd "$ROOT"

# --- host guard (needs the container's node deps + claude CLI) ---
if [ ! -f /.dockerenv ] && [ "${CASTOR_ORACLE_ALLOW_HOST:-}" != "1" ]; then
  echo "ERROR: run_e2e.sh runs INSIDE the Castor container." >&2
  echo "  docker exec -w /app castor-webchat bash run_e2e.sh --yes" >&2
  echo "  (CI/throwaway: AGENT_ROOT=<repo-copy> CASTOR_ORACLE_ALLOW_HOST=1 bash run_e2e.sh --yes)" >&2
  exit 2
fi

# --- destructive-demo guard ---
if [ "${1:-}" != "--yes" ]; then
  echo "!!! run_e2e.sh runs the FULL pipeline on SYNTHETIC data and is DESTRUCTIVE to"
  echo "!!! demo state under AGENT_ROOT=$AGENT_ROOT — it seeds fixtures into inbox/drop,"
  echo "!!! writes intake sidecars, and drafts a register item."
  echo "!!! Run on a FRESH Castor agent BEFORE it holds real data."
  echo "!!! To proceed:  bash run_e2e.sh --yes"
  exit 1
fi

STEP=0; SKIPPED=0; SKIPS=""

run_step () {   # fail-loud
  STEP=$((STEP+1)); local label="$1"; shift
  echo; echo "================================================================"
  echo "STEP ${STEP}: ${label}"; echo "  \$ $*"
  echo "----------------------------------------------------------------"
  "$@"; local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo; echo "################################################################"
    echo "STEP ${STEP} FAILED (exit ${rc}): ${label}"
    echo "  The message above names the missing prerequisite or failed check."
    echo "  A guard fired — fix the producing step, not this one."
    echo "  Pipeline STOPPED. Nothing downstream ran."
    echo "################################################################"
    exit "$rc"
  fi
  echo "  [step ${STEP} OK]"
}

run_optional () {   # skip-loud: $1=label  $2=precondition (eval)  $3=enable-hint  rest=command
  STEP=$((STEP+1)); local label="$1" cond="$2" hint="$3"; shift 3
  echo; echo "================================================================"
  echo "STEP ${STEP}: ${label}  (model-dependent)"
  if ! eval "$cond" >/dev/null 2>&1; then
    echo "----------------------------------------------------------------"
    echo "  SKIPPED — precondition not met."
    echo "  Enable: ${hint}"
    echo "  [step ${STEP} SKIPPED — surfaced loudly, not silent]"
    SKIPPED=$((SKIPPED+1)); SKIPS="${SKIPS}\n  - ${label} — ${hint}"
    return 0
  fi
  echo "  \$ $*"; echo "----------------------------------------------------------------"
  "$@"; local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo; echo "################################################################"
    echo "STEP ${STEP} FAILED (exit ${rc}): ${label} (model lane was enabled)"
    echo "################################################################"
    exit "$rc"
  fi
  echo "  [step ${STEP} OK]"
}

echo "### Castor E2E acceptance oracle ###"
echo "### code=$ROOT  AGENT_ROOT=$AGENT_ROOT ###"

# Seed synthetic corpus + ensure data dirs exist.
run_step "seed synthetic corpus" bash -c '
  set -e
  A="'"$AGENT_ROOT"'"; F="'"$FIX"'"
  mkdir -p "$A/inbox/drop" "$A/state" "$A/knowledge" "$A/logs"
  for f in backlog.xlsx report.pdf scanned.pdf diagram.png status.png brief.docx message.eml; do
    cp "$F/$f" "$A/inbox/drop/$f"
  done
  printf "id,note\n1,employee record with a fake ssn 123-45-6789 in it\n" > "$A/inbox/drop/leak.csv"
  printf "id,note\n1,a perfectly clean row of data\n"                     > "$A/inbox/drop/clean.csv"
  printf "MZ" > "$A/inbox/drop/malware.exe"
  echo "seeded $(ls -1 "$A/inbox/drop" | wc -l) items into $A/inbox/drop"
'

# Gate config present — the egress gate fails closed without it.
run_step "gate config present (fail-closed guard)" bash -c '
  test -f "'"$AGENT_ROOT"'/gate/never-egress.json" \
    || { echo "MISSING: '"$AGENT_ROOT"'/gate/never-egress.json — gate fails closed; bootstrap.sh seeds it from the example"; exit 1; }
  echo "never-egress.json present"
'

# Egress boundary — the gate blocks sensitive content, passes clean text.
run_step "egress boundary (tripwire blocks sensitive, passes clean)" node -e '
  const { checkTripwire } = require("./gate/tripwire");
  const bad = checkTripwire("employee ssn 123-45-6789 leaked to a personal note");
  const ok  = checkTripwire("a perfectly clean sentence with nothing sensitive");
  if (!bad.blocked) { console.error("FAIL: sentinel not blocked — egress boundary is OPEN"); process.exit(1); }
  if (ok.blocked)   { console.error("FAIL: clean text blocked — false positive"); process.exit(1); }
  console.log("gate blocks sensitive ("+bad.hits.length+" hit) and passes clean text");
'

# Intake pass — DROP -> sidecars / quarantine.
run_step "intake pass (--once)" node scripts/intake.js --once

# Verify intake outcomes: admit+flag, admit clean, image vision-pending, unsupported quarantined.
run_step "verify intake outcomes" node -e '
  const fs=require("fs"), path=require("path");
  const INBOX=path.join(process.env.AGENT_ROOT,"inbox");
  const QUAR=path.join(INBOX,"quarantine");
  const files=fs.readdirSync(INBOX);
  const flags=n=>{const f=files.find(x=>x.endsWith(n+".flags.json"));return f?JSON.parse(fs.readFileSync(path.join(INBOX,f),"utf8")):null;};
  const must=(c,m)=>{if(!c){console.error("FAIL: "+m);process.exit(1);}};
  const leak=flags("leak.csv");   must(leak && leak.tripwire.flagged===true,  "leak.csv must be admitted AND flagged");
  const clean=flags("clean.csv"); must(clean && clean.tripwire.flagged===false,"clean.csv must be admitted and NOT flagged");
  must(files.some(f=>f.endsWith("diagram.png.vision-pending.json")),"diagram.png must write a vision-pending marker");
  const q=fs.existsSync(QUAR)?fs.readdirSync(QUAR).filter(f=>!f.endsWith(".reason.txt")):[];
  must(q.some(f=>f.endsWith("malware.exe")),"malware.exe (unsupported) must be structurally quarantined");
  console.log("intake OK: leak flagged, clean not, image vision-pending, unsupported quarantined");
'

# Pending aggregation — the webchat panel groups sidecars by state.
run_step "pending aggregation (webchat panel)" node -e '
  const { listPending } = require("./webchat/pending");
  const g = listPending(process.env.AGENT_ROOT);
  if (g.visionPending.length < 1) { console.error("FAIL: no vision-pending items grouped"); process.exit(1); }
  if (g.flagged.length < 1)       { console.error("FAIL: no flagged items grouped"); process.exit(1); }
  console.log(`pending: ready=${g.ready.length} flagged=${g.flagged.length} unscanned=${g.unscanned.length} vision-pending=${g.visionPending.length}`);
'

# Register — draft an action item, read it back.
run_step "register add + list" bash -c '
  set -e
  node scripts/register.js add "oracle demo item" --owner oracle --estimate 1w --pipeline intake >/dev/null
  node scripts/register.js list | grep -qi "oracle demo item" || { echo "FAIL: register item not listed after add"; exit 1; }
  echo "register item drafted and listed"
'

# Model routing resolves; the gateway config generates.
run_step "model routing + gateway-config" bash -c '
  set -e
  node scripts/model-routing.js list >/dev/null
  node scripts/model-routing.js gateway-config | grep -q "model_list" || { echo "FAIL: gateway-config missing model_list"; exit 1; }
  echo "routing resolves; gateway-config emits model_list"
'

# Digest — aggregates deadlines + pipeline + intake pending counts into a dated report.
run_step "digest (aggregates intake pending)" bash -c '
  set -e
  node scripts/digest.js >/dev/null
  f="$(ls -t "'"$AGENT_ROOT"'"/state/weekly-reports/*-digest.md 2>/dev/null | head -1)"
  [ -n "$f" ] || { echo "FAIL: digest wrote no report file"; exit 1; }
  grep -qE "Flagged:|Vision-pending:" "$f" || { echo "FAIL: digest report missing pending counts"; cat "$f"; exit 1; }
  echo "digest wrote $(basename "$f") with pending counts"
'

# Jobs — each self-guards via exit code.
run_step "health-check (exit 0 = healthy)" node scripts/health-check.js
run_step "scan-tree (usage-guard only; findings are informational)" bash -c '
  node scripts/scan-tree.js "'"$AGENT_ROOT"'/knowledge" --quiet; rc=$?
  [ "$rc" -eq 2 ] && { echo "FAIL: scan-tree usage error"; exit 1; }
  echo "scan-tree ran (rc=$rc; 0 clean / 1 findings both valid on synthetic data)"; exit 0
'
run_step "audit chain verify" node scripts/audit-log.js verify

# Skill lane — claude -p routes through the gateway. Skip-loud without a key/CLI.
MODEL="$(node scripts/model-routing.js resolve routine 2>/dev/null | tr -d "[:space:]" || true)"
run_optional "skill lane (claude -p routes via gateway)" \
  '[ -n "${OPENROUTER_API_KEY:-}" ] && command -v claude && [ -n "'"$MODEL"'" ]' \
  "set OPENROUTER_API_KEY (+ ANTHROPIC_BASE_URL to the gateway), install the claude CLI" \
  bash -c 'out="$(claude -p "Reply with the single token ORACLE_OK and nothing else." --model "'"$MODEL"'" --output-format text 2>&1)"; echo "$out" | grep -q "ORACLE_OK" || { echo "FAIL: model did not return ORACLE_OK: $out"; exit 1; }; echo "claude -p routed via gateway and responded"'

# --- summary ---
echo; echo "================================================================"
echo "CASTOR E2E COMPLETE — $((STEP-SKIPPED)) steps passed; ${SKIPPED} model lane(s) skipped."
if [ "$SKIPPED" -gt 0 ]; then printf 'Skipped (surfaced loudly):%b\n' "$SKIPS"; fi
echo "Deterministic core satisfied: gate/egress, intake, pending, register, routing, digest, jobs."
echo "Note: attested-vision interpret (VISION_API_KEY, direct Anthropic) is exercised"
echo "      through the webchat interpret action on a live agent, not this script."
echo "================================================================"
