/**
 * health-check.js — STUB (structural twin)
 * Intended function: Hourly system health probe (services, disk, tunnel, mailbox reachability).
 * Original pattern:  Alert on failure via operator notification channel; silent success.
 * Secrets:           fetched at runtime from Key Vault via managed identity
 *                    (see /opt/twin-bootstrap/fetch-secret.sh) — never from disk.
 * Status:            NOT IMPLEMENTED. Logs invocation and exits.
 */
console.error('[stub] health-check.js invoked — not implemented');
process.exit(0);
