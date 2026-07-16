/**
 * audit-log.js — STUB (structural twin)
 * Intended function: Append-only JSONL audit trail for every model API call.
 * Original pattern:  timestamp, model, routing tier, token counts, redaction status per entry; written to logs/audit.jsonl.
 * Secrets:           fetched at runtime from Key Vault via managed identity
 *                    (see /opt/twin-bootstrap/fetch-secret.sh) — never from disk.
 * Status:            NOT IMPLEMENTED. Logs invocation and exits.
 */
console.error('[stub] audit-log.js invoked — not implemented');
process.exit(0);
