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
 * Binds to loopback behind the Cloudflare tunnel. Auth is edge-only (Cloudflare Access).
 */

try { require('dotenv').config(); } catch { /* env-first; no .env needed */ }
const express = require('express');
const session = require('express-session');
const auth = require('../scripts/auth.js');
const chatSession = require('../scripts/chat-session.js');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');

const AGENT_ROOT = process.env.AGENT_ROOT || path.join(process.env.HOME, 'castor');

const { checkTripwire } = require(path.join(AGENT_ROOT, 'gate', 'tripwire'));
const { record: auditRecord } = require(path.join(AGENT_ROOT, 'gate', 'audit'));
const modelRouting = require(path.join(AGENT_ROOT, 'scripts', 'model-routing'));

// app-TOTP removed: Cloudflare Access is the sole authenticator (edge-only).

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
// --- shared auth contract (fleet-core: scripts/auth.js) --------------------
// requireAuth + /login + /verify + /logout + a guarded GET / are single-sourced so the
// post-Access behavior cannot diverge between agents. Aegis service token bypasses;
// a human after Cloudflare Access gets no redundant app-TOTP (standardize-on-2).
const requireAuth = auth.requireAuth;
let AGENT_NAME = 'Agent';
try {
  const _m = require('fs').readFileSync(require('path').join(require('path').dirname(__dirname), 'system', 'agent.yaml'), 'utf8').match(/^\s*agent_name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (_m) AGENT_NAME = _m[1].trim();
} catch (e) { /* default */ }
auth.mountAuth(app, { webchatDir: __dirname, agentName: AGENT_NAME });

// --- container liveness probe (unauthenticated, 200 only) ------------------
app.get('/health/liveliness', (req, res) => res.status(200).send('ok'));

// --- current model routing, for the UI to display the active model ---------
const MODEL_LABELS = {
  'openrouter/deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'openrouter/z-ai/glm-5.2': 'GLM 5.2',
  'openrouter/moonshotai/kimi-k3': 'Kimi K3',
  'openrouter/anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
  'openrouter/anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'openrouter/anthropic/claude-opus-4.8': 'Claude Opus 4.8',
};
function modelLabel(slug) { return MODEL_LABELS[slug] || String(slug).split('/').pop(); }
app.get('/model', requireAuth, (req, res) => {
  try {
    const tiers = modelRouting.list();
    // active = routine tier's slug; options = distinct loaded model slugs
    let routineSlug = null; const seen = {}; const options = [];
    for (const t of tiers) {
      const slug = t.openrouter_slug || t.slug;
      if (t.tier === 'routine' || t.name === 'routine') routineSlug = slug;
      if (slug && !seen[slug]) { seen[slug] = 1; options.push({ slug: slug, label: modelLabel(slug) }); }
    }
    const active = modelRouting.getSelected() || routineSlug;
    res.json({ ok: true, tiers: tiers, active: active, options: options });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/model/select', requireAuth, (req, res) => {
  try {
    const slug = (req.body && req.body.slug) || '';
    if (!MODEL_LABELS[slug]) return res.status(400).json({ ok: false, error: 'model not in allowed set' });
    const name = String(slug).split('/').pop();
    execFileSync('node', ['scripts/model-routing.js', 'set-selected', '--slug', slug], { cwd: AGENT_ROOT, encoding: 'utf8', timeout: 15000 });
    try { auditRecord({ action: 'MODEL_SELECT', status: 'OK', tier: 'routine', slug: slug }); } catch (e) {}
    res.json({ ok: true, active: slug });
  } catch (e) { res.status(500).json({ ok: false, error: (e.stdout||'') + (e.stderr||'') + String(e) }); }
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
// New conversation: rotate the session so the next turn starts fresh (agent forgets the current chat).
app.post('/session/reset', requireAuth, (req, res) => {
  try { chatSession.clearSessionId(path.join(AGENT_ROOT, 'state')); res.json({ ok: true, message: 'New conversation started.' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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

// GET / is registered by auth.mountAuth (guarded + brand-injected)

const server = http.createServer(app);

// --- claude -p streaming over WebSocket ------------------------------------
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    // Mirror requireAuth: Cloudflare Access validated the request at the edge
    // (Cf-Access-* header present == authenticated), OR a direct session is authed.
    const cfAuthed = req.headers['cf-access-jwt-assertion'] || req.headers['cf-access-client-id'];
    if (!cfAuthed && (!req.session || !req.session.authed)) {
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
    try { model = msg.tier ? modelRouting.resolve(tier) : modelRouting.resolveSelected(); }
    catch (e) { ws.send(JSON.stringify({ type: 'error', text: 'Model routing error: ' + e.message })); ws.send(JSON.stringify({ type: 'done' })); return; }

    ws.send(JSON.stringify({ type: 'start' }));
    auditRecord({ action: 'WEBCHAT', status: 'MODEL_CALL', tier, model });

    // /compliance-report: refresh governance evidence server-side (deterministic,
    // execFileSync) before the skill reads state/compliance/*.json. Keeps the LLM
    // out of the execution path; the skill only aggregates.
    const _rcmd = prompt.trim();
    if (_rcmd === '/compliance-report' || _rcmd.startsWith('/compliance-report ')) {
      writeCompliance('audit-verify', 'node', ['scripts/audit-log.js', 'verify'], 30000);
      writeCompliance('capability-status', 'node', ['scripts/setup-wizard.js', '--status'], 30000);
    }

    let finalText = '', errText = '', done = false;
    const finish = () => { if (done) return; done = true; ws.send(JSON.stringify({ type: 'done' })); };
    const child = chatSession.runChatTurn(
      { prompt, model, cwd: AGENT_ROOT, stateDir: path.join(AGENT_ROOT, 'state'), env: process.env },
      (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init') {
          ws.send(JSON.stringify({ type: 'step', text: `Session ready (${model}) — conversation memory on` }));
        } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) { finalText += block.text; ws.send(JSON.stringify({ type: 'token', text: block.text })); }
            else if (block.type === 'tool_use') { ws.send(JSON.stringify({ type: 'step', text: 'Using: ' + (block.name || 'tool') })); }
          }
        } else if (ev.type === 'result' && ev.is_error) { errText = ev.result || 'Model reported an error'; }
      },
      (code, stderr) => {
        if (stderr) errText += stderr;
        if (code !== 0 && !finalText) ws.send(JSON.stringify({ type: 'error', text: (errText || 'Model call failed').trim().slice(0, 500) }));
        finish();
      }
    );
    child.on('error', (e) => {
      ws.send(JSON.stringify({ type: 'error', text: 'Failed to start claude: ' + e.message }));
      finish();
    });
  });
});

// Deterministic governance evidence writer (module-level; hoisted, used by the
// /compliance-report WS pre-step above and the two routes below). Runs a
// read-only script via execFileSync and persists {ok, output, ranAt} to
// state/compliance/<name>.json. Never throws: a broken audit chain (audit-log
// exits 1) is captured as ok:false with the real output, not a route failure.
function writeCompliance(name, bin, args, timeoutMs) {
  const dir = path.join(AGENT_ROOT, 'state', 'compliance');
  let rec;
  try {
    const out = execFileSync(bin, args, { cwd: AGENT_ROOT, encoding: 'utf8', timeout: timeoutMs });
    rec = { ok: true, output: out, ranAt: new Date().toISOString() };
  } catch (e) {
    rec = { ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e), ranAt: new Date().toISOString() };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(rec, null, 2));
  } catch (e) {
    rec.persistError = String(e);
  }
  return rec;
}

// Governance: refresh + return the audit-chain verification (scripts/audit-log.js).
app.get('/run-audit-verify', requireAuth, (req, res) => {
  res.json(writeCompliance('audit-verify', 'node', ['scripts/audit-log.js', 'verify'], 30000));
});

// Governance: refresh + return capability status (scripts/setup-wizard.js --status).
app.get('/run-capability-status', requireAuth, (req, res) => {
  res.json(writeCompliance('capability-status', 'node', ['scripts/setup-wizard.js', '--status'], 30000));
});

const PORT = parseInt(process.env.CASTOR_PORT || '8443', 10);
const HOST = process.env.CASTOR_BIND || '127.0.0.1';
if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Castor webchat on http://${HOST}:${PORT}`));
}

module.exports = { app, server, requireAuth };
