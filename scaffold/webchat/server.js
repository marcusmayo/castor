/**
 * server.js — Castor webchat (spine).
 *
 * Ported from the Keel webchat: TOTP auth, session, and the claude -p
 * stream-json core over a WebSocket. Adapted for Castor:
 *   - The model is resolved per tier via scripts/model-routing.js and passed to
 *     claude -p with --model, so every call follows the routing policy.
 *   - The typed prompt passes the egress tripwire before it is sent; a blocked
 *     prompt is not spawned (the egress boundary at the chat layer).
 *   - Keel's portfolio endpoints (export/apply/reconcile) are dropped. The
 *     pending panel and attested-vision interpret path are added in later
 *     stages.
 *
 * Binds to loopback behind the Cloudflare tunnel. TOTP_SECRET is required.
 */

try { require('dotenv').config(); } catch { /* env-first; no .env needed */ }
const express = require('express');
const session = require('express-session');
const speakeasy = require('speakeasy');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const AGENT_ROOT = process.env.AGENT_ROOT || path.join(process.env.HOME, 'castor');

const { checkTripwire } = require(path.join(AGENT_ROOT, 'gate', 'tripwire'));
const { record: auditRecord } = require(path.join(AGENT_ROOT, 'gate', 'audit'));
const modelRouting = require(path.join(AGENT_ROOT, 'scripts', 'model-routing'));

const TOTP_SECRET = process.env.TOTP_SECRET;
if (!TOTP_SECRET) { console.error('FATAL: TOTP_SECRET not set'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '1mb' }));

const sessionParser = session({
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000 },
});
app.use(sessionParser);

// --- rate-limited TOTP auth ------------------------------------------------
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; attempts.set(ip, rec);
  return rec.n > 10;
}
function requireAuth(req, res, next) {
  // Aegis (fleet control plane): Cloudflare Access validated a service token and set
  // this header; CF strips any client-supplied Cf-Access-* headers and the origin is
  // tunnel-only, so its presence == an authenticated machine call. agent-core will
  // harden this to full Cf-Access-Jwt-Assertion verification.
  if (req.headers['cf-access-jwt-assertion'] || req.headers['cf-access-client-id']) return next();
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ ok: false, error: 'auth required' });
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/verify', (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'too many attempts' });
  const token = (req.body && req.body.token || '').toString().trim();
  const ok = speakeasy.totp.verify({ secret: TOTP_SECRET, encoding: 'base32', token, window: 1 });
  if (ok) { req.session.authed = true; attempts.delete(ip); return res.json({ ok: true }); }
  return res.status(401).json({ ok: false, error: 'invalid code' });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// --- container liveness probe (unauthenticated, 200 only) ------------------
app.get('/health/liveliness', (req, res) => res.status(200).send('ok'));

// --- current model routing, for the UI to display the active model ---------
app.get('/model', requireAuth, (req, res) => {
  try { res.json({ ok: true, tiers: modelRouting.list() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// --- per-instance UI accent color (set via chat: /color <name|hex>) ----------
const fs = require('fs');
const UI_STATE = path.join(AGENT_ROOT, 'state', 'ui.json');
const ACCENT_DEFAULT = '#f59e0b'; // Castor default: amber
const PALETTE = { azure:'#3b82f6', cyan:'#22d3ee', emerald:'#10b981', lime:'#84cc16', amber:'#f59e0b', rose:'#f43f5e', violet:'#8b5cf6', fuchsia:'#d946ef' };
function readAccent() {
  try { const j = JSON.parse(fs.readFileSync(UI_STATE, 'utf8')); if (j && typeof j.accent === 'string') return j.accent; } catch {}
  return ACCENT_DEFAULT;
}
app.get('/color', requireAuth, (req, res) => res.json({ ok: true, accent: readAccent(), palette: PALETTE }));
app.post('/color', requireAuth, (req, res) => {
  const v = String((req.body && req.body.value) || '').trim().toLowerCase();
  const hex = PALETTE[v] || (/^#[0-9a-f]{6}$/.test(v) ? v : null);
  if (!hex) return res.json({ ok: false, error: 'unknown color', palette: PALETTE });
  try {
    fs.mkdirSync(path.dirname(UI_STATE), { recursive: true });
    fs.writeFileSync(UI_STATE, JSON.stringify({ accent: hex }) + '\n');
    res.json({ ok: true, accent: hex });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

const pending = require('./pending');

// Pending panel: intake items grouped by state.
app.get('/pending', requireAuth, (req, res) => {
  try { res.json({ ok: true, groups: pending.listPending(AGENT_ROOT) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
// Serve a vision-pending image for the attestation thumbnail (authed only).
app.get('/pending/image/:name', requireAuth, (req, res) => {
  const file = pending.imagePath(AGENT_ROOT, req.params.name);
  if (!file) return res.status(400).send('bad image');
  res.sendFile(file);
});
// Attested vision: the operator confirms the exact image (by hash) before its
// raw bytes leave the VM. pending.interpret audits the egress and verifies the
// hash before sending.
app.post('/pending/interpret', requireAuth, async (req, res) => {
  const { name, sha256 } = req.body || {};
  try {
    // Resolve the vision model/endpoint from model-routing (changeable via CLI,
    // same as the text tiers). Direct to Anthropic by default.
    const v = modelRouting.resolveVision();
    const r = await pending.interpret(AGENT_ROOT, name, sha256, { fetch: globalThis.fetch, audit: auditRecord, model: v.model, url: v.api_url });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => {
  if (req.session && req.session.authed) return res.sendFile(path.join(__dirname, 'chat.html'));
  return res.redirect('/login');
});

const server = http.createServer(app);

// --- claude -p streaming over WebSocket ------------------------------------
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    if (!req.session || !req.session.authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg = {};
    try { msg = JSON.parse(data); } catch { msg = { prompt: String(data) }; }
    const prompt = (msg.prompt || '').toString();
    const tier = (msg.tier || 'routine').toString();
    if (!prompt.trim()) { ws.send(JSON.stringify({ type: 'error', text: 'Empty prompt.' })); return; }

    // Egress boundary: a typed prompt containing a never-egress term is not sent.
    const trip = checkTripwire(prompt);
    if (trip.blocked) {
      const types = [...new Set(trip.hits.map(h => h.type))].join(', ');
      auditRecord({ action: 'WEBCHAT', status: 'EGRESS_BLOCKED', rule_types: types });
      ws.send(JSON.stringify({ type: 'error', text:
        `Egress blocked — the message matches a never-egress rule (${types}). Edit and resend, or use a skill that handles this locally.` }));
      ws.send(JSON.stringify({ type: 'done' }));
      return;
    }

    let model;
    try { model = modelRouting.resolve(tier); }
    catch (e) { ws.send(JSON.stringify({ type: 'error', text: 'Model routing error: ' + e.message })); ws.send(JSON.stringify({ type: 'done' })); return; }

    ws.send(JSON.stringify({ type: 'start' }));
    auditRecord({ action: 'WEBCHAT', status: 'MODEL_CALL', tier, model });

    const child = spawn('claude', ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose'],
      { cwd: AGENT_ROOT, env: process.env });

    const rl = readline.createInterface({ input: child.stdout });
    let finalText = '', errText = '';
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        ws.send(JSON.stringify({ type: 'step', text: `Session started (${model})` }));
      } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) { finalText += block.text; ws.send(JSON.stringify({ type: 'token', text: block.text })); }
          else if (block.type === 'tool_use') { ws.send(JSON.stringify({ type: 'step', text: 'Using: ' + (block.name || 'tool') })); }
        }
      } else if (ev.type === 'result' && ev.is_error) { errText = ev.result || 'Model reported an error'; }
    });
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && !finalText) ws.send(JSON.stringify({ type: 'error', text: (errText || 'Model call failed').trim().slice(0, 500) }));
      ws.send(JSON.stringify({ type: 'done' }));
    });
    child.on('error', (e) => {
      ws.send(JSON.stringify({ type: 'error', text: 'Failed to start claude: ' + e.message }));
      ws.send(JSON.stringify({ type: 'done' }));
    });
  });
});

const PORT = parseInt(process.env.CASTOR_PORT || '8443', 10);
const HOST = process.env.CASTOR_BIND || '127.0.0.1';
if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Castor webchat on http://${HOST}:${PORT}`));
}

module.exports = { app, server, requireAuth };
