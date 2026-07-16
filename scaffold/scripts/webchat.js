/**
 * webchat.js — STUB (structural twin)
 * Intended function: Browser chat interface AND interactive web terminal (Express + WebSocket + TOTP) on localhost:3000, exposed only via tunnel.
 * Original pattern:  TOTP-gated UI; chat and a PTY-backed terminal served from the same process; backend shells to the coding agent in print mode; heartbeat keepalive during long runs; filter keepalive pings out of the PTY stream (JSON corruption risk); reconnect cache for mobile lock/wake.
 * Secrets:           fetched at runtime from Key Vault via managed identity
 *                    (see /opt/twin-bootstrap/fetch-secret.sh) — never from disk.
 * Status:            NOT IMPLEMENTED. Logs invocation and exits.
 */
console.error('[stub] webchat.js invoked — not implemented');
process.exit(0);
