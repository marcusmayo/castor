#!/usr/bin/env node
/**
 * intake.js — file-drop intake lane (flag, don't refuse).
 *
 * Replaces the original IMAP poller. The operator drops files into
 * inbox/drop/; supported files are ADMITTED to inbox/, flagged, and processed.
 * No mailbox credential lives on the agent — per the fleet email-architecture
 * ruling, inbound mail arrives via a separate intake service delivering into
 * this same drop path.
 *
 * Gate posture — matches Keel. The tripwire runs at ingest on the EXTRACTED
 * text of each file (and each email attachment), but it FLAGS rather than
 * refuses: hits are written to a per-file sidecar and an audit entry, and the
 * file is still admitted. The redaction boundary is at model egress
 * (gate/gate.js), where a flagged item is caught again before anything leaves.
 * Admitting real values to inbox/ is safe because state/ and knowledge/ are
 * gitignored and the pre-commit gate blocks anything reaching history.
 *
 * Quarantine is reserved for STRUCTURAL failures only: unsupported type,
 * empty, or oversized. A supported file that cannot be parsed is admitted and
 * marked scan_state=unscanned — visible, not hidden.
 *
 * Types: .csv .xlsx .md .txt .pdf .docx .eml .msg and images
 * (.png .jpg .jpeg .gif .webp .tif .tiff .bmp). PDFs use pdftotext; images use
 * Tesseract OCR. An image whose OCR recovers little text is admitted and
 * marked scan_state=vision-pending with a marker file — the operator triggers
 * attested vision interpretation from the webchat (intake proposes the
 * raw-image egress; the operator commits it).
 *
 * Usage:
 *   node scripts/intake.js --once     single pass (cron)
 *   node scripts/intake.js --watch    poll loop
 *   node scripts/intake.js --status   counts and queues
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { checkTripwire } = require('../gate/tripwire');
const { record } = require('../gate/audit');
const { extract, SUPPORTED } = require('./extract');

const AGENT_ROOT = process.env.AGENT_ROOT || path.join(process.env.HOME, 'castor');
const DROP       = process.env.INTAKE_DROP       || path.join(AGENT_ROOT, 'inbox', 'drop');
const INBOX      = process.env.INTAKE_INBOX      || path.join(AGENT_ROOT, 'inbox');
const ARCHIVE    = process.env.INTAKE_ARCHIVE    || path.join(AGENT_ROOT, 'inbox', 'archive');
const QUARANTINE = process.env.INTAKE_QUARANTINE || path.join(AGENT_ROOT, 'inbox', 'quarantine');
const LEDGER     = process.env.INTAKE_LEDGER     || path.join(AGENT_ROOT, 'state', 'intake-ledger.json');

const POLL_MS      = Number(process.env.INTAKE_POLL_MS || 30000);
const STABILITY_MS = Number(process.env.INTAKE_STABILITY_MS || 2000);
const MAX_BYTES    = Number(process.env.INTAKE_MAX_BYTES || 50 * 1024 * 1024);

function ensureDirs() {
  for (const d of [DROP, INBOX, ARCHIVE, QUARANTINE, path.dirname(LEDGER)]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { processed: {} }; } }
function saveLedger(l) { fs.mkdirSync(path.dirname(LEDGER), { recursive: true, mode: 0o700 }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n', { mode: 0o600 }); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function stamp() { return new Date().toISOString().slice(0, 10); }
function safeName(name) { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

function isStable(file) {
  let a; try { a = fs.statSync(file); } catch { return false; }
  const start = Date.now(); while (Date.now() - start < STABILITY_MS) { /* short */ }
  let b; try { b = fs.statSync(file); } catch { return false; }
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// Collect (unitLabel, text) pairs — the body plus any email attachments.
function textUnits(ex) {
  const units = [['body', ex.text || '']];
  for (const a of ex.attachments || []) units.push(['attachment:' + a.name, a.text || '']);
  return units;
}

// Run the tripwire per unit and classify. CONFIG_ERROR means the config is
// missing, so scanning did not happen — reported explicitly, not as "clean".
function classifyTripwire(ex) {
  const hits = []; let configError = false;
  for (const [unit, text] of textUnits(ex)) {
    if (!text) continue;
    const r = checkTripwire(text);
    for (const h of r.hits) {
      if (h.type === 'CONFIG_ERROR') configError = true;
      else hits.push({ unit, type: h.type, rule: h.rule, location: h.location });
    }
  }
  return { flagged: hits.length > 0, configError, hits };
}

function anyVisionPending(ex) {
  if (ex.scanState === 'vision-pending') return true;
  return (ex.attachments || []).some(a => a.scanState === 'vision-pending');
}
function anyUnscanned(ex) {
  if (ex.scanState === 'unscanned') return true;
  return (ex.attachments || []).some(a => a.scanState === 'unscanned');
}

function writeSidecar(destBase, obj) {
  fs.writeFileSync(path.join(INBOX, destBase), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}

// The extracted text was scanned for tripwires and then DISCARDED. An admitted pdf, docx, xlsx,
// eml or image therefore left the agent holding a binary it may not open and no text to read --
// while the sidecar recorded chars:N, stating that the content had been recovered and thrown
// away. Persist it. Nothing egresses: tesseract and pdftotext already ran on this machine, and
// this file never leaves it.
//
// It lives in a DOT directory because inbox/ is enumerated as the review queue: fleet-core
// queue.js skips dot-prefixed entries, so a sibling .txt would have been counted as a second
// admitted item for every file. -> the sidecar-relative path, or null
const TEXT_DIR = '.text';
const TEXT_MAX = 2 * 1024 * 1024;
function writeExtractedText(destName, ex) {
  const parts = [];
  if (ex.text) parts.push(String(ex.text));
  for (const a of ex.attachments || []) {
    if (a.text) parts.push('\n\n----- attachment: ' + a.name + ' -----\n' + String(a.text));
  }
  let body = parts.join('');
  if (!body.trim()) return null;
  let truncated = false;
  if (body.length > TEXT_MAX) { body = body.slice(0, TEXT_MAX); truncated = true; }
  const dir = path.join(INBOX, TEXT_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rel = TEXT_DIR + '/' + destName + '.txt';
  fs.writeFileSync(path.join(INBOX, rel), body + (truncated ? '\n\n[truncated at ' + TEXT_MAX + ' characters]\n' : ''), { mode: 0o600 });
  return { rel, truncated, chars: body.length };
}

function quarantine(file, reason, detail) {
  const base = safeName(path.basename(file));
  const dest = path.join(QUARANTINE, `${stamp()}_${base}`);
  fs.renameSync(file, dest);
  fs.writeFileSync(dest + '.reason.txt', `refused: ${reason}\n${detail || ''}\nat: ${new Date().toISOString()}\n`, { mode: 0o600 });
  record({ action: 'INTAKE', status: 'QUARANTINED', reason, file: base });
  return { file: path.basename(file), outcome: 'quarantined', reason };
}

function admit(file, ex, tw) {
  const base = safeName(path.basename(file));
  const destName = `${stamp()}_${base}`;
  fs.copyFileSync(file, path.join(INBOX, destName));
  fs.chmodSync(path.join(INBOX, destName), 0o600);
  fs.renameSync(file, path.join(ARCHIVE, destName));

  const visionPending = anyVisionPending(ex);
  const flags = {
    file: destName,
    admitted_at: new Date().toISOString(),
    extraction: { type: path.extname(base).toLowerCase(), extractor: ex.extractor, chars: ex.chars, scan_state: ex.scanState, ...(ex.legibility ? { legibility: ex.legibility } : {}), ...(ex.note ? { note: ex.note } : {}) },
    has_vision_pending: visionPending,
    has_unscanned: anyUnscanned(ex),
    attachments: (ex.attachments || []).map(a => ({ name: a.name, scan_state: a.scanState, extractor: a.extractor, chars: a.chars, ...(a.legibility ? { legibility: a.legibility } : {}), ...(a.note ? { note: a.note } : {}) })),
    tripwire: { flagged: tw.flagged, config_error: tw.configError, scanned: !tw.configError, hits: tw.hits },
  };
  // Written BEFORE the sidecar is finalised so the sidecar can point at it, and so a file with
  // no recoverable text simply carries no pointer rather than a pointer to nothing.
  const txt = writeExtractedText(destName, ex);
  if (txt) { flags.extraction.text_file = txt.rel; flags.extraction.text_chars = txt.chars; if (txt.truncated) flags.extraction.text_truncated = true; }
  writeSidecar(destName + '.flags.json', flags);

  if (visionPending) {
    const targets = [];
    if (ex.scanState === 'vision-pending') targets.push('<self>');
    for (const a of ex.attachments || []) if (a.scanState === 'vision-pending') targets.push(a.name);
    writeSidecar(destName + '.vision-pending.json', {
      file: destName,
      targets,
      reason: ex.note || 'image OCR recovered little text; contents not scannable as text',
      instructions: 'Trigger attested vision interpretation from the webchat. Raw-image egress to the vision model requires explicit operator confirmation.',
    });
  }

  record({
    action: 'INTAKE', status: 'ADMITTED', file: destName,
    extractor: ex.extractor, scan_state: ex.scanState,
    flagged: tw.flagged, config_error: tw.configError,
    vision_pending: visionPending, attachments: (ex.attachments || []).length,
  });

  return {
    file: path.basename(file), outcome: 'admitted', dest: destName,
    scan: ex.scanState, flagged: tw.flagged, vision: visionPending, configError: tw.configError,
  };
}

async function processOne(file, ledger) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);

  if (!SUPPORTED.has(ext)) return quarantine(file, 'unsupported file type', `extension "${ext || '(none)'}"`);

  let st; try { st = fs.statSync(file); } catch { return null; }
  if (st.size === 0) return quarantine(file, 'empty file', 'zero bytes');
  if (st.size > MAX_BYTES) return quarantine(file, 'file too large', `${st.size} bytes exceeds ${MAX_BYTES}`);

  if (!isStable(file)) return { file: base, outcome: 'deferred', reason: 'still being written' };

  const digest = sha256(fs.readFileSync(file));
  if (ledger.processed[digest]) {
    fs.renameSync(file, path.join(ARCHIVE, `${stamp()}_dup_${safeName(base)}`));
    record({ action: 'INTAKE', status: 'DUPLICATE', file: safeName(base) });
    return { file: base, outcome: 'duplicate', reason: 'content already admitted' };
  }

  let ex;
  try { ex = await extract(file); }
  catch (e) { ex = { text: '', scanState: 'unscanned', extractor: 'error', chars: 0, note: 'extractor threw: ' + (e.message || '').slice(0, 120) }; }

  const tw = classifyTripwire(ex);
  const res = admit(file, ex, tw);
  ledger.processed[digest] = { file: res.dest, admitted_at: new Date().toISOString() };
  return res;
}

async function runOnce() {
  ensureDirs();
  const ledger = loadLedger();
  let entries = []; try { entries = fs.readdirSync(DROP); } catch { entries = []; }

  const results = [];
  for (const name of entries) {
    const full = path.join(DROP, name);
    let s; try { s = fs.statSync(full); } catch { continue; }
    if (!s.isFile()) continue;
    const r = await processOne(full, ledger);
    if (r) results.push(r);
  }
  saveLedger(ledger);

  console.log(`=== intake: ${results.length} file(s) seen ===`);
  for (const r of results) {
    if (r.outcome === 'admitted') {
      const tags = [`scan=${r.scan}`];
      if (r.flagged) tags.push('FLAGGED');
      if (r.vision) tags.push('vision-pending');
      if (r.configError) tags.push('tripwire-config-missing');
      console.log(`  admitted     ${r.file}  [${tags.join(' ')}] -> inbox/${r.dest}`);
    } else {
      console.log(`  ${r.outcome.padEnd(11)} ${r.file}${r.reason ? ' — ' + r.reason : ''}`);
    }
  }
  if (results.length === 0) console.log('  nothing to do');
  return results;
}

function status() {
  ensureDirs();
  const countFiles = (d, suffix) => { try { return fs.readdirSync(d).filter(f => (suffix ? f.endsWith(suffix) : true) && fs.statSync(path.join(d, f)).isFile()).length; } catch { return 0; } };
  const ledger = loadLedger();
  const inboxFiles = (() => { try { return fs.readdirSync(INBOX).filter(f => fs.statSync(path.join(INBOX, f)).isFile()); } catch { return []; } })();
  const admitted = inboxFiles.filter(f => !f.startsWith('.') && !f.endsWith('.flags.json') && !f.endsWith('.vision-pending.json')).length;
  const flagged = inboxFiles.filter(f => f.endsWith('.flags.json')).reduce((n, f) => { try { return n + (JSON.parse(fs.readFileSync(path.join(INBOX, f), 'utf8')).tripwire.flagged ? 1 : 0); } catch { return n; } }, 0);
  const vision = inboxFiles.filter(f => f.endsWith('.vision-pending.json')).length;
  console.log('');
  console.log(`  drop                ${countFiles(DROP)}`);
  console.log(`  inbox (admitted)    ${admitted}`);
  console.log(`  flagged             ${flagged}`);
  console.log(`  vision-pending      ${vision}`);
  console.log(`  archive             ${countFiles(ARCHIVE)}`);
  console.log(`  quarantine          ${countFiles(QUARANTINE) - countFiles(QUARANTINE, '.reason.txt')}`);
  console.log(`  admitted (ledger)   ${Object.keys(ledger.processed).length}`);
  console.log('');
}

async function main() {
  const arg = process.argv[2] || '--once';
  if (arg === '--status') return status();
  if (arg === '--once') return void await runOnce();
  if (arg === '--watch') {
    console.log(`intake: watching ${DROP} every ${POLL_MS}ms`);
    let running = false;
    const tick = async () => { if (running) return; running = true; try { await runOnce(); } finally { running = false; } };
    await tick();
    setInterval(tick, POLL_MS);
    return;
  }
  console.error('Usage: intake.js [--once|--watch|--status]'); process.exit(1);
}

if (require.main === module) main();

module.exports = { runOnce, status, DROP, INBOX, ARCHIVE, QUARANTINE, LEDGER, SUPPORTED };
