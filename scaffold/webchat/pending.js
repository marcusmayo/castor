/**
 * pending.js — pending-panel logic for the webchat.
 *
 * Reads the intake lane's inbox/ sidecars and groups admitted items by state
 * (ready / flagged / unscanned / vision-pending). Also owns the attested-vision
 * interpret path: the ONE place raw image bytes leave the VM, gated per-image by
 * the operator confirming the exact SHA-256. Ported from Keel's /interpret, but
 * operating on inbox/ where the intake lane already placed the image and its
 * vision-pending marker.
 *
 * The HTTP layer for the vision call is injectable so this is unit-testable
 * without network; production passes global fetch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMG_RE = /^[0-9a-zA-Z._-]+\.(png|jpg|jpeg|webp|gif|tif|tiff|bmp)$/i;

function inboxDir(agentRoot) { return path.join(agentRoot, 'inbox'); }

// Group admitted items by state, reading the .flags.json sidecars.
function listPending(agentRoot) {
  const dir = inboxDir(agentRoot);
  const groups = { ready: [], flagged: [], unscanned: [], visionPending: [] };
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.flags.json')); } catch { return groups; }
  for (const f of files) {
    let fl;
    try { fl = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const item = {
      file: fl.file,
      type: fl.extraction && fl.extraction.type,
      scan_state: fl.extraction && fl.extraction.scan_state,
      flagged: !!(fl.tripwire && fl.tripwire.flagged),
      has_vision_pending: !!fl.has_vision_pending,
      has_unscanned: !!fl.has_unscanned,
    };
    // A file can appear in more than one lens (e.g. flagged AND ready). Bucket
    // by the most action-relevant state, in priority order.
    if (item.has_vision_pending) {
      // Provide the current image hash so the panel can attest the exact bytes.
      try {
        const img = path.join(dir, item.file);
        if (IMG_RE.test(item.file) && fs.existsSync(img)) {
          item.sha256 = crypto.createHash('sha256').update(fs.readFileSync(img)).digest('hex');
        }
      } catch (_) {}
      groups.visionPending.push(item);
    }
    else if (item.scan_state === 'unscanned') groups.unscanned.push(item);
    else if (item.flagged) groups.flagged.push(item);
    else groups.ready.push(item);
  }
  return groups;
}

// Resolve a validated image path inside inbox/. Rejects traversal and any name
// that isn't an admitted image. Returns null if invalid or absent.
function imagePath(agentRoot, name) {
  const raw = String(name || '');
  if (!IMG_RE.test(raw)) return null;
  const dir = inboxDir(agentRoot);
  const file = path.join(dir, path.basename(raw));
  // basename already strips traversal; confirm containment defensively.
  if (path.dirname(file) !== dir) return null;
  if (!fs.existsSync(file)) return null;
  return file;
}

// Attested vision interpretation of an inbox image. deps.fetch is the HTTP impl;
// deps.audit records the egress. Returns { ok, text } or { ok:false, error }.
async function interpret(agentRoot, name, attestedSha, deps) {
  const audit = deps.audit || (() => {});
  const file = imagePath(agentRoot, name);
  if (!file) { audit({ action: 'RAW_IMAGE', status: 'BLOCKED', redaction: 'ATTESTED_EGRESS', reason: 'bad or missing image' }); return { ok: false, error: 'bad or missing image' }; }

  const buf = fs.readFileSync(file);
  const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
  // The operator confirmed THIS image by hash. A mismatch means the bytes
  // changed since the panel showed them — do not send.
  if (attestedSha && actualSha !== attestedSha) {
    audit({ action: 'RAW_IMAGE', status: 'BLOCKED', redaction: 'ATTESTED_EGRESS', sha256: attestedSha, reason: 'hash mismatch' });
    return { ok: false, error: 'image hash mismatch — not sending' };
  }

  const apiKey = deps.apiKey || process.env.VISION_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    audit({ action: 'RAW_IMAGE', status: 'FAILED', redaction: 'ATTESTED_EGRESS', sha256: actualSha, reason: 'no vision api key' });
    return { ok: false, error: 'vision API key not configured (set VISION_API_KEY)' };
  }

  const ext = path.extname(file).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png'
    : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif' : 'image/png';
  const model = deps.model || process.env.VISION_MODEL || 'claude-sonnet-4-6';
  const url = deps.url || process.env.VISION_API_URL || 'https://api.anthropic.com/v1/messages';

  // Audit the egress BEFORE the call — the attempt is recorded whether or not
  // it returns.
  audit({ action: 'RAW_IMAGE', status: 'SENT', redaction: 'ATTESTED_EGRESS', model, sha256: actualSha, attestation: 'operator-confirmed' });

  let resp;
  try {
    resp = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 1500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
          { type: 'text', text: 'Describe the structure of this diagram or image in plain text. If it shows a flow, process, hierarchy, or relationships, lay out the components and how they connect. Be concise and factual; do not invent labels that are not legible.' },
        ] }],
      }),
    });
  } catch (e) {
    audit({ action: 'RAW_IMAGE', status: 'ERROR', redaction: 'ATTESTED_EGRESS', sha256: actualSha, reason: (e.message || '').slice(0, 120) });
    return { ok: false, error: 'vision call failed: ' + (e.message || '').slice(0, 120) };
  }
  if (!resp.ok) {
    audit({ action: 'RAW_IMAGE', status: 'API_ERROR', redaction: 'ATTESTED_EGRESS', sha256: actualSha, http: resp.status });
    return { ok: false, error: 'vision API error ' + resp.status };
  }
  const data = await resp.json();
  const text = Array.isArray(data.content) ? data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() : '';

  // Persist the interpretation next to the image and clear the vision-pending
  // marker so the item leaves the pending queue.
  const dir = inboxDir(agentRoot);
  fs.writeFileSync(path.join(dir, path.basename(name) + '.interpretation.txt'), (text || '(vision returned no text)') + '\n', { mode: 0o600 });
  try { fs.unlinkSync(path.join(dir, path.basename(name) + '.vision-pending.json')); } catch (_) {}

  return { ok: true, text: text || '(vision returned no text)', sha256: actualSha };
}

module.exports = { listPending, imagePath, interpret, IMG_RE };
