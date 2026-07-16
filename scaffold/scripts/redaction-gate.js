/**
 * redaction-gate.js — STUB (structural twin)
 * Intended function: Git pre-commit hook: block commits containing PII patterns.
 * Original pattern:  Scans staged content; exits non-zero on any match; installed via .git/hooks/pre-commit.
 * Secrets:           fetched at runtime from Key Vault via managed identity
 *                    (see /opt/twin-bootstrap/fetch-secret.sh) — never from disk.
 * Status:            NOT IMPLEMENTED. Logs invocation and exits.
 */
console.error('[stub] redaction-gate.js invoked — not implemented');
process.exit(0);
