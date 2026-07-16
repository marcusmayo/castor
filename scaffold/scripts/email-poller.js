/**
 * email-poller.js — STUB (structural twin)
 * Intended function: Poll a review mailbox for operator-authored notes; write scrubbed content to inbox/.
 * Original pattern:  IMAP poll every 5 min; every write passes through redact.js ingest gate; processed mail archived; triage-tier model per System/model-routing.yaml.
 * Secrets:           fetched at runtime from Key Vault via managed identity
 *                    (see /opt/twin-bootstrap/fetch-secret.sh) — never from disk.
 * Status:            NOT IMPLEMENTED. Logs invocation and exits.
 */
console.error('[stub] email-poller.js invoked — not implemented');
process.exit(0);
