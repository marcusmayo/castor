/**
 * register.js — action-register read/write authority and date logic.
 *
 * The action register (state/action-register.md) is a human-readable markdown
 * table, but this module is the authority for parsing it, generating IDs, and
 * resolving due dates. The morning and triage skills rely on this logic; it is
 * unit-tested here because the skills themselves (claude -p procedures) can
 * only be exercised on a deployment with a model key.
 *
 * ID contract: `ACT-` + zero-padded integer, minimum six digits. The next ID
 * is derived by parsing the integer of the current maximum and adding one —
 * never by string comparison — so the ledger grows past 999999 to ACT-1000000
 * and beyond without the numbering or ordering breaking. All ordering is done
 * on the parsed integer.
 */

const fs = require('fs');
const path = require('path');

const AGENT_ROOT = process.env.AGENT_ROOT || path.join(process.env.HOME, 'castor');
const REGISTER = process.env.ACTION_REGISTER || path.join(AGENT_ROOT, 'state', 'action-register.md');

const ID_RE = /^ACT-(\d+)$/;
const ID_MIN_WIDTH = 6;

const COLS = ['id', 'opened', 'description', 'owner', 'status', 'pipeline', 'estimate', 'due'];

function idInt(id) {
  const m = ID_RE.exec((id || '').trim());
  return m ? parseInt(m[1], 10) : null;
}

function formatId(n) {
  return 'ACT-' + String(n).padStart(ID_MIN_WIDTH, '0');
}

// Next ID from a list of existing IDs. Parses integers; ignores malformed.
function nextId(ids) {
  let max = 0;
  for (const id of ids) { const n = idInt(id); if (n !== null && n > max) max = n; }
  return formatId(max + 1);
}

// Parse a markdown table register into row objects. Tolerant of blank lines and
// the separator row; a row is any line with the right pipe structure whose
// first cell matches an ACT id.
function parse(md) {
  const rows = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length !== COLS.length) continue;
    if (!ID_RE.test(cells[0])) continue; // skips header + separator
    const row = {};
    COLS.forEach((c, i) => { row[c] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

function load() {
  let md; try { md = fs.readFileSync(REGISTER, 'utf8'); } catch { return []; }
  return parse(md);
}

// Relative estimate -> days. Accepts "2w", "3 days", "1m", etc. null if unparseable.
function estimateDays(s) {
  if (!s) return null;
  const m = /^(\d+)\s*(d|day|days|w|wk|wks|week|weeks|m|mo|mos|month|months)$/i.exec(String(s).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u[0] === 'd') return n;
  if (u[0] === 'w') return n * 7;
  return n * 30; // month approximated at 30 days
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Resolve a row's effective due date: explicit `due` wins; otherwise
// opened + estimate. Returns YYYY-MM-DD or null.
function resolveDue(row) {
  if (row.due && /^\d{4}-\d{2}-\d{2}$/.test(row.due)) return row.due;
  const days = estimateDays(row.estimate);
  if (days === null || !/^\d{4}-\d{2}-\d{2}$/.test(row.opened || '')) return null;
  return addDays(row.opened, days);
}

// Classify open rows against a reference date (default today, UTC).
//   overdue:  due < ref and not done
//   dueSoon:  ref <= due <= ref + horizonDays and not done
function schedule(rows, refDate, horizonDays = 7) {
  const ref = refDate || new Date().toISOString().slice(0, 10);
  const overdue = [], dueSoon = [], undated = [];
  for (const r of rows) {
    if (r.status === 'done') continue;
    const due = resolveDue(r);
    if (!due) { undated.push(r); continue; }
    if (due < ref) overdue.push({ ...r, _due: due });
    else if (due <= addDays(ref, horizonDays)) dueSoon.push({ ...r, _due: due });
  }
  const byDue = (a, b) => a._due < b._due ? -1 : a._due > b._due ? 1 : idInt(a.id) - idInt(b.id);
  overdue.sort(byDue); dueSoon.sort(byDue);
  return { overdue, dueSoon, undated, ref };
}

// Render a single register row in canonical table format.
function renderRow(row) {
  return '| ' + COLS.map(c => row[c] || '').join(' | ') + ' |';
}

// Build a new row object with the next ID. `fields` supplies the rest.
function newRow(existingRows, fields) {
  const id = nextId(existingRows.map(r => r.id));
  const row = { id, opened: fields.opened || new Date().toISOString().slice(0, 10),
                description: fields.description || '', owner: fields.owner || '',
                status: fields.status || 'open', pipeline: fields.pipeline || '',
                estimate: fields.estimate || '', due: fields.due || '' };
  return row;
}

module.exports = {
  REGISTER, COLS, idInt, formatId, nextId, parse, load,
  estimateDays, addDays, resolveDue, schedule, renderRow, newRow,
};

// ---------------------------------------------------------------------------
// CLI — the deterministic surface the skills shell out to. The LLM skills do
// judgment; id generation, date math, and scheduling are done here so they are
// exact and reproducible.
//
//   node scripts/register.js next-id
//   node scripts/register.js schedule [refDate] [horizonDays]
//   node scripts/register.js list [status]
//   node scripts/register.js add "<description>" [--owner X] [--status open]
//        [--pipeline intake] [--estimate 2w] [--due YYYY-MM-DD] [--opened YYYY-MM-DD]
//
// `add` is the write primitive. Per propose-don't-mutate, the triage skill
// PROPOSES the row and calls this only after explicit operator confirmation.
// ---------------------------------------------------------------------------
function appendRow(row) {
  let md; try { md = fs.readFileSync(REGISTER, 'utf8'); } catch { md = ''; }
  if (!md.trim()) {
    md = '# Action Register\n\n| ' + COLS.join(' | ') + ' |\n|' + COLS.map(() => '---').join('|') + '|\n';
  }
  if (!md.endsWith('\n')) md += '\n';
  fs.mkdirSync(path.dirname(REGISTER), { recursive: true, mode: 0o700 });
  fs.appendFileSync(REGISTER, renderRow(row) + '\n', { mode: 0o600 });
  return row;
}

function parseFlags(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'next-id') {
      console.log(nextId(load().map(r => r.id)));
    } else if (cmd === 'list') {
      const status = args[0];
      const rows = load().filter(r => !status || r.status === status);
      for (const r of rows) console.log(`${r.id}  ${(r.status || '').padEnd(11)} ${resolveDue(r) || '(no due)'}  ${r.description}`);
      if (rows.length === 0) console.log('(no matching actions)');
    } else if (cmd === 'schedule') {
      const s = schedule(load(), args[0], args[1] ? Number(args[1]) : 7);
      console.log(`schedule as of ${s.ref}:`);
      console.log(`  OVERDUE (${s.overdue.length})`);
      for (const r of s.overdue) console.log(`    ${r.id}  due ${r._due}  ${r.description}`);
      console.log(`  DUE SOON (${s.dueSoon.length})`);
      for (const r of s.dueSoon) console.log(`    ${r.id}  due ${r._due}  ${r.description}`);
    } else if (cmd === 'add') {
      const { flags, rest } = parseFlags(args);
      const description = rest.join(' ').trim();
      if (!description) { console.error('usage: add "<description>" [--owner X --estimate 2w --pipeline intake --due YYYY-MM-DD]'); process.exit(1); }
      const row = newRow(load(), { description, owner: flags.owner, status: flags.status, pipeline: flags.pipeline, estimate: flags.estimate, due: flags.due, opened: flags.opened });
      appendRow(row);
      console.log('added ' + row.id + (resolveDue(row) ? ' (due ' + resolveDue(row) + ')' : ''));
    } else {
      console.error('commands: next-id | schedule [ref] [horizon] | list [status] | add "<desc>" [flags]');
      process.exit(1);
    }
  } catch (e) { console.error('register: ' + e.message); process.exit(1); }
}
