#!/usr/bin/env node
/**
 * digest.js — daily and weekly digest.
 *
 * Deterministic aggregation (no model call): action-register deadlines,
 * pipeline snapshot, and intake activity including pending counts (admitted,
 * flagged, vision-pending, unscanned). Writes a dated file to
 * state/weekly-reports/ and, if an operator channel is enabled, pushes a short
 * summary via the notify helper.
 *
 * Usage:  node scripts/digest.js [--weekly]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENT_ROOT = process.env.AGENT_ROOT || path.join(process.env.HOME, 'castor');
const OUT_DIR = path.join(AGENT_ROOT, 'state', 'weekly-reports');
const INBOX = path.join(AGENT_ROOT, 'inbox');

function today() { return new Date().toISOString().slice(0, 10); }

function deadlines() {
  try {
    const reg = require('./register');
    const s = reg.schedule(reg.load(), today(), 7);
    return { overdue: s.overdue, dueSoon: s.dueSoon };
  } catch { return { overdue: [], dueSoon: [] }; }
}

function pipelineSnapshot() {
  const dir = path.join(AGENT_ROOT, 'state', 'pipeline');
  const counts = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') && f !== '_item-template.yaml'); } catch { return counts; }
  let yaml; try { yaml = require('js-yaml'); } catch { return { _files: files.length }; }
  for (const f of files) {
    try {
      const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
      const stage = (doc && doc.stage) || 'unknown';
      counts[stage] = (counts[stage] || 0) + 1;
    } catch { counts._unreadable = (counts._unreadable || 0) + 1; }
  }
  return counts;
}

// Pending counts from the intake flag sidecars.
function intakeActivity() {
  let files = [];
  try { files = fs.readdirSync(INBOX).filter(f => f.endsWith('.flags.json')); } catch { return { admitted: 0, flagged: 0, visionPending: 0, unscanned: 0 }; }
  let flagged = 0, visionPending = 0, unscanned = 0;
  for (const f of files) {
    try {
      const fl = JSON.parse(fs.readFileSync(path.join(INBOX, f), 'utf8'));
      if (fl.tripwire && fl.tripwire.flagged) flagged++;
      if (fl.has_vision_pending) visionPending++;
      if (fl.has_unscanned) unscanned++;
    } catch { /* skip */ }
  }
  return { admitted: files.length, flagged, visionPending, unscanned };
}

function build(weekly) {
  const d = deadlines();
  const pipe = pipelineSnapshot();
  const act = intakeActivity();
  const lines = [];
  lines.push(`# ${weekly ? 'Weekly' : 'Daily'} Digest — ${today()}`, '');
  lines.push('## Deadlines');
  lines.push(`- Overdue: ${d.overdue.length}`);
  for (const r of d.overdue) lines.push(`    ${r.id}  due ${r._due}  ${r.description}`);
  lines.push(`- Due within 7 days: ${d.dueSoon.length}`);
  for (const r of d.dueSoon) lines.push(`    ${r.id}  due ${r._due}  ${r.description}`);
  lines.push('', '## Pipeline');
  const stageLine = Object.entries(pipe).map(([k, v]) => `${k}: ${v}`).join(', ') || '(no items)';
  lines.push('- ' + stageLine);
  lines.push('', '## Intake (pending)');
  lines.push(`- Admitted: ${act.admitted}  |  Flagged: ${act.flagged}  |  Vision-pending: ${act.visionPending}  |  Unscanned: ${act.unscanned}`);
  return { text: lines.join('\n') + '\n', summary:
    `Digest ${today()}: ${d.overdue.length} overdue, ${d.dueSoon.length} due soon, ` +
    `${act.admitted} pending (${act.visionPending} need vision)` };
}

// Push a short summary if the notify helper exists (capability-gated inside it).
function push(summary) {
  try {
    const notify = path.join(AGENT_ROOT, 'scripts', 'notify.js');
    if (fs.existsSync(notify)) {
      execFileSync('node', [notify, 'digest', summary], { cwd: AGENT_ROOT, encoding: 'utf8', timeout: 20000 });
      return true;
    }
  } catch (_) { /* digest still written even if push fails */ }
  return false;
}

if (require.main === module) {
  const weekly = process.argv.includes('--weekly');
  const { text, summary } = build(weekly);
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(OUT_DIR, `${today()}-digest${weekly ? '-weekly' : ''}.md`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  console.log('wrote ' + file);
  const pushed = push(summary);
  console.log(pushed ? 'summary pushed' : 'notify.js not present — summary not pushed');
}

module.exports = { build };
