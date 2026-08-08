#!/usr/bin/env bash
# infra/scripts/bootstrap.sh — Castor first-boot bootstrap (managed-identity path).
#
# Runs ON THE VM HOST (not in a container), after cloud-init has cloned the repo
# and built the image. Non-interactive by design: no secret is ever prompted or
# committed. It fetches operator secrets from the per-agent Key Vault via the
# VM's user-assigned managed identity (IMDS token + Key Vault REST over curl —
# no az CLI, no account keys), generates castor.env, regenerates the gateway
# config, seeds the egress tripwire, brings
# the stack up, and smoke-tests the webchat liveliness probe.
#
# Contract (infra/docker/compose.yaml env_file): castor.env must define
#   OPENROUTER_API_KEY, VISION_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
# Vault secrets (operator-set post-apply — see setup-wizard / capabilities.yaml):
#   model-api-key  -> OPENROUTER_API_KEY   (required)
#   vision-api-key -> VISION_API_KEY       (required)
# App-TOTP is gone (edge-only auth; Cloudflare Access is the gate). Optional capability secrets
# (telegram-*, resend-*) are out of scope for core bootstrap.
#
# RBAC propagation is eventually consistent; the token and per-secret fetches
# retry to absorb the lag (Bicep has no time_sleep, so this loop is where it
# lands). Load-bearing steps fail loudly — nothing is silently skipped.
set -euo pipefail

log(){ printf '>> %s\n' "$*"; }
die(){ printf 'ABORT: %b\n' "$*" >&2; exit 1; }

AGENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$AGENT_ROOT"

FLAGS="$AGENT_ROOT/.provision-flags"
COMPOSE="$AGENT_ROOT/infra/docker/compose.yaml"
ENV_FILE="$AGENT_ROOT/infra/docker/castor.env"
GATEWAY_CFG="$AGENT_ROOT/infra/docker/litellm/openrouter.yaml"
NEVER_EGRESS="$AGENT_ROOT/gate/never-egress.json"
NEVER_EGRESS_EXAMPLE="$AGENT_ROOT/gate/never-egress.example.json"
IMAGE="castor:latest"
KV_API="7.4"
PUBLISH_PORT="${CASTOR_PUBLISH_PORT:-8443}"

# --- preflight ---
command -v docker  >/dev/null || die "docker not found on host"
command -v curl    >/dev/null || die "curl not found on host"
command -v python3 >/dev/null || die "python3 not found on host"
docker info >/dev/null 2>&1 || die "cannot reach the docker daemon — add \$USER to the docker group (sudo usermod -aG docker \$USER; re-login) or run this with sudo"

# --- 1. provision flags (written by cloud-init from vm.bicep) ---
[ -f "$FLAGS" ] || die "missing $FLAGS — cloud-init did not complete"
# shellcheck disable=SC1090
. "$FLAGS"
[ "${AGENT_PROFILE:-}" = "castor" ] || die "AGENT_PROFILE='${AGENT_PROFILE:-}' — this bootstrap is the Castor managed-identity path only"
[ -n "${KEY_VAULT_NAME:-}" ] || die "KEY_VAULT_NAME empty in .provision-flags — no vault provisioned (Keel profile?)"
[ -n "${MSI_CLIENT_ID:-}" ]  || die "MSI_CLIENT_ID empty in .provision-flags"
log "agent=castor vault=$KEY_VAULT_NAME"

VAULT_BASE="https://${KEY_VAULT_NAME}.vault.azure.net"
IMDS="http://169.254.169.254/metadata/identity/oauth2/token"

# --- 2. AAD token via IMDS (retry for MI / RBAC propagation) ---
get_token(){
  curl -s -H 'Metadata:true' -G "$IMDS" \
    --data-urlencode 'api-version=2018-02-01' \
    --data-urlencode 'resource=https://vault.azure.net' \
    --data-urlencode "client_id=${MSI_CLIENT_ID}" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true
}
TOKEN=""
for i in $(seq 1 12); do
  TOKEN="$(get_token)"
  [ -n "$TOKEN" ] && break
  log "IMDS token not ready ($i/12) — identity propagating, sleeping 15s"
  sleep 15
done
[ -n "$TOKEN" ] || die "no managed-identity token from IMDS after 12 attempts"
log "managed-identity token acquired"

# --- 3. Key Vault secret fetch ---
#   200 -> value; 403 -> role still propagating, retry; 404 -> not set, fail with the fix;
#   401 -> token expired, refresh once; other -> retry.
kv_get(){
  local name="$1" out code body
  for i in $(seq 1 12); do
    out="$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
      "${VAULT_BASE}/secrets/${name}?api-version=${KV_API}" || true)"
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    case "$code" in
      200) printf '%s' "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])'; return 0 ;;
      403) log "  secret '$name': 403, role propagating ($i/12) — sleeping 15s"; sleep 15 ;;
      401) log "  token expired — refreshing"; TOKEN="$(get_token)" ;;
      404) die "secret '$name' not in $KEY_VAULT_NAME. Set it:\n  az keyvault secret set --vault-name $KEY_VAULT_NAME --name $name --value <value>" ;;
      *)   log "  secret '$name': HTTP $code ($i/12) — sleeping 15s"; sleep 15 ;;
    esac
  done
  die "could not read secret '$name' after 12 attempts"
}

log "fetching operator secrets via managed identity"
OPENROUTER_API_KEY="$(kv_get model-api-key)"
VISION_API_KEY="$(kv_get vision-api-key)"
log "secrets fetched (model-api-key, vision-api-key)"

# Optional: a real Anthropic key (vault secret 'anthropic-api-key') enables direct
# web_search turns (chat-session.js WEB_DIRECT_MODEL/WEB_DIRECT_KEY path). Absent ->
# web research stays gateway-only best-effort. kv_get fails on a missing secret; the
# || true makes this fetch optional without weakening the required ones above.
ANTHROPIC_DIRECT_KEY="$(kv_get anthropic-api-key 2>/dev/null || true)"
case "$ANTHROPIC_DIRECT_KEY" in
  sk-ant-*) log "anthropic-api-key present -> WEB_DIRECT_KEY will be written (web-direct enabled)" ;;
  "")       log "anthropic-api-key not in vault -> web-direct disabled (gateway-only)" ;;
  *)        die "anthropic-api-key in $KEY_VAULT_NAME is not an Anthropic key (expected sk-ant- prefix)" ;;
esac

# --- 3a. key-shape guard (structural: refuse to stand up on a placeholder) ---
# The gateway is keyless and injects OPENROUTER_API_KEY per call as the ONLY
# upstream auth. A placeholder or wrong secret in the vault reaches OpenRouter as
# no auth header (401 "Missing Authentication header") and would surface only at
# the oracle skill lane. Fail here instead: before castor.env and before compose up.
case "$OPENROUTER_API_KEY" in
  sk-or-*) : ;;
  *) die "model-api-key in $KEY_VAULT_NAME is not an OpenRouter key (expected sk-or- prefix).\n  A placeholder or wrong secret was stored. Fix:\n  az keyvault secret set --vault-name $KEY_VAULT_NAME --name model-api-key --value sk-or-v1-REALKEY" ;;
esac

# App-TOTP removed (edge-only auth migration): Cloudflare Access is the gate; nothing generated.

# --- 5. write castor.env (0600, gitignored) ---
umask 077
cat > "$ENV_FILE" <<EOF
# Generated by bootstrap.sh — DO NOT COMMIT. Secrets fetched via managed identity.
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
VISION_API_KEY=${VISION_API_KEY}
ANTHROPIC_BASE_URL=http://gateway:4000
# The claude CLI refuses to run without a non-empty key ("Not logged in"). The
# gateway is keyless and injects OPENROUTER_API_KEY per call, so this value is
# inert upstream: a fixed placeholder satisfies the CLI login gate and is safe.
ANTHROPIC_API_KEY=sk-ant-placeholder-gateway-routed
${ANTHROPIC_DIRECT_KEY:+WEB_DIRECT_KEY=${ANTHROPIC_DIRECT_KEY}}
EOF
umask 022
log "wrote $ENV_FILE (0600)"

# --- 6. regenerate the gateway config from system/model-routing.yaml ---
# The compose bind-mount ./litellm shadows the image copy, so the host file must
# be present and current. Regenerate fresh; fall back loudly to the committed one.
if docker run --rm -w /app -e AGENT_ROOT=/app "$IMAGE" \
     node scripts/model-routing.js gateway-config > "${GATEWAY_CFG}.tmp" 2>/dev/null && [ -s "${GATEWAY_CFG}.tmp" ]; then
  mv "${GATEWAY_CFG}.tmp" "$GATEWAY_CFG"
  log "gateway config regenerated -> $GATEWAY_CFG"
else
  rm -f "${GATEWAY_CFG}.tmp"
  [ -s "$GATEWAY_CFG" ] || die "gateway-config regeneration failed and no committed openrouter.yaml is present"
  log "WARNING: gateway-config regeneration failed — using the committed $GATEWAY_CFG"
fi

# --- 7. seed the egress tripwire config (fails closed if absent; never clobber operator edits) ---
if [ ! -f "$NEVER_EGRESS" ]; then
  [ -f "$NEVER_EGRESS_EXAMPLE" ] || die "no never-egress.json and no example to seed from"
  cp "$NEVER_EGRESS_EXAMPLE" "$NEVER_EGRESS"
  log "seeded $NEVER_EGRESS from example"
else
  log "never-egress.json present — left as-is"
fi

# --- 8. bring the stack up (webchat + gateway) ---
log "starting compose (webchat + gateway profile)"
docker compose -f "$COMPOSE" --profile gateway up -d

# --- 9. smoke test: liveliness probe (HTTP 200), never docker inspect status ---
URL="http://127.0.0.1:${PUBLISH_PORT}/health/liveliness"
log "publishing webchat on 127.0.0.1:${PUBLISH_PORT} — probing $URL"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
  [ "$code" = "200" ] && { log "liveliness 200 — smoke test PASS"; log "bootstrap complete"; exit 0; }
  sleep 2
done
die "liveliness probe never returned 200 at $URL — inspect: docker compose -f $COMPOSE logs"
