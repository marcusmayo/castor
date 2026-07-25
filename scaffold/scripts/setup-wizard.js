#!/usr/bin/env node
/**
 * setup-wizard.js — walks a new operator through every external integration.
 *
 * For each capability it states what the integration enables, what is lost
 * without it, and the exact steps to set it up. The operator enables or
 * declines. Declining is a first-class, recorded outcome — not a failure —
 * and every decline prints how to reverse it later.
 *
 * Secrets are never prompted for, echoed, or written by this tool. It prints
 * the `az keyvault secret set` command for you to run, then verifies the
 * secret resolves through the managed identity. The value never passes
 * through this process.
 *
 * Usage:
 *   node scripts/setup-wizard.js              walk undecided capabilities
 *   node scripts/setup-wizard.js --all        walk every capability again
 *   node scripts/setup-wizard.js --status     show current state
 *   node scripts/setup-wizard.js --enable  <id>
 *   node scripts/setup-wizard.js --disable <id>
 */

const readline = require('readline');
const { execFileSync } = require('child_process');
const fs = require('fs');
const cap = require('./capability');

const FETCH_SECRET = process.env.FETCH_SECRET || '/opt/twin-bootstrap/fetch-secret.sh';

function hr() { console.log('─'.repeat(72)); }

function wrap(text, indent = '  ', contIndent = null) {
  const cont = contIndent === null ? indent + '  ' : contIndent;
  const words = String(text).trim().replace(/\s+/g, ' ').split(' ');
  const lines = []; let cur = indent; let first = true;
  for (const w of words) {
    if ((cur + ' ' + w).length > 76 && cur.trim()) {
      lines.push(cur); cur = cont; first = true;
    }
    cur += (first ? '' : ' ') + w; first = false;
  }
  if (cur.trim()) lines.push(cur);
  return lines.join('\n');
}

function describe(c) {
  hr();
  console.log(`${c.name}${c.required ? '   [REQUIRED]' : '   [optional]'}`);
  hr();
  console.log(wrap(c.summary));
  console.log('');
  console.log('  Enables:');
  for (const e of c.enables || []) console.log(wrap('- ' + e, '    ', '      '));
  console.log('');
  console.log('  Without it:');
  for (const w of c.without || []) console.log(wrap('- ' + w, '    ', '      '));
  if ((c.secrets || []).length) {
    console.log('');
    console.log('  Secrets required (created by you, never by this tool):');
    for (const s of c.secrets) console.log(wrap(`- ${s.name} — ${s.description}`, '    ', '      '));
  }
  console.log('');
  console.log('  Setup steps:');
  let n = 1;
  for (const s of c.setup || []) {
    const body = String(s).trim();
    // Preserve command lines verbatim; wrap prose.
    if (body.includes('\n')) {
      const [head, ...rest] = body.split('\n');
      console.log(wrap(`${n}. ${head.trim()}`, '    ', '       '));
      for (const ln of rest) if (ln.trim()) console.log('       ' + ln.trim());
    } else {
      console.log(wrap(`${n}. ${body}`, '    ', '       '));
    }
    n++;
  }
  console.log('');
}

// Verify without ever revealing a value: run fetch-secret and report only
// whether it resolved.
function verifySecret(name) {
  if (!fs.existsSync(FETCH_SECRET)) {
    return { ok: null, detail: `fetch-secret helper not present at ${FETCH_SECRET} (expected off-VM)` };
  }
  try {
    const out = execFileSync(FETCH_SECRET, [name], { encoding: 'utf8', timeout: 30000 });
    return { ok: out.trim().length > 0, detail: out.trim().length > 0 ? 'resolved' : 'empty value' };
  } catch (e) {
    return { ok: false, detail: (e.stderr || e.message || '').toString().split('\n')[0].slice(0, 120) };
  }
}

function runVerify(c) {
  const names = (c.secrets || []).map(s => s.name);
  if (names.length === 0) {
    console.log('  Verification: no secret required for this capability.');
    return true;
  }
  let allOk = true;
  for (const nm of names) {
    const r = verifySecret(nm);
    const mark = r.ok === true ? 'OK' : r.ok === null ? 'SKIPPED' : 'FAILED';
    console.log(`  Verification: ${nm} — ${mark} (${r.detail})`);
    if (r.ok === false) allOk = false;
  }
  return allOk;
}

function showStatus() {
  const caps = cap.loadRegistry();
  console.log('');
  console.log('  CAPABILITY            REQUIRED   STATE');
  console.log('  ' + '─'.repeat(52));
  for (const c of caps) {
    const s = cap.status(c.id);
    const label = s === 'enabled' ? 'enabled' : s === 'declined' ? 'declined' : 'not configured';
    const warn = (c.required && s !== 'enabled') ? '  <-- required, agent will not function' : '';
    console.log(`  ${c.id.padEnd(20)}  ${(c.required ? 'yes' : 'no').padEnd(8)}   ${label}${warn}`);
  }
  console.log('');
  console.log('  Enable:  node scripts/setup-wizard.js --enable <id>');
  console.log('  Disable: node scripts/setup-wizard.js --disable <id>');
  console.log('');
}

function enable(id, quiet) {
  const c = cap.get(id);
  if (!quiet) describe(c);
  const ok = runVerify(c);
  cap.setStatus(id, 'enabled', ok ? undefined : 'enabled with verification not confirmed');
  console.log('');
  if (ok) {
    console.log(`  ${c.name}: ENABLED.`);
  } else {
    console.log(`  ${c.name}: recorded as enabled, but verification did not confirm.`);
    console.log('  Complete the setup steps above, then re-run:');
    console.log(`    node scripts/setup-wizard.js --enable ${id}`);
  }
  console.log('');
}

function disable(id) {
  const c = cap.get(id);
  cap.setStatus(id, 'declined');
  console.log('');
  console.log(`  ${c.name}: DECLINED.`);
  console.log('');
  console.log('  What you will not have:');
  for (const w of c.without || []) console.log(wrap('- ' + w, '    ', '      '));
  if (c.required) {
    console.log('');
    console.log('  WARNING: this capability is marked required. Castor cannot');
    console.log('  operate as an agent without it.');
  }
  console.log('');
  console.log('  To re-enable at any time:');
  console.log(`    node scripts/setup-wizard.js --enable ${id}`);
  console.log('');
}

function ask(rl, q) {
  return new Promise(res => rl.question(q, a => res(a.trim().toLowerCase())));
}

async function walk(all) {
  const caps = cap.loadRegistry();
  const todo = caps.filter(c => all || cap.status(c.id) === 'unset');

  if (todo.length === 0) {
    console.log('\n  All capabilities have been decided. Use --status to review, or --all to revisit.\n');
    return;
  }

  if (!process.stdin.isTTY) {
    console.error('\n  Not an interactive terminal. Use --enable <id> / --disable <id> instead.\n');
    process.exit(1);
  }

  console.log('');
  console.log('  Castor setup — external integrations');
  console.log('');
  console.log(wrap('Each integration below is optional unless marked REQUIRED. '
    + 'Declining is fine and is recorded; you can enable anything later. '
    + 'This tool never asks for a credential — it prints the command for you to run.'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (const c of todo) {
    describe(c);
    let a = '';
    while (!['e', 'd', 's'].includes(a)) {
      a = await ask(rl, '  [e]nable  [d]ecline  [s]kip for now > ');
      if (!['e', 'd', 's'].includes(a)) console.log('  Answer e, d, or s.');
    }
    if (a === 'e') enable(c.id, true);
    else if (a === 'd') disable(c.id);
    else console.log(`\n  Skipped. ${c.name} remains not configured.\n`);
  }
  rl.close();

  console.log('');
  showStatus();
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = argv[0];

  try {
    if (flag === '--status') return showStatus();
    if (flag === '--enable') {
      if (!argv[1]) { console.error('Usage: --enable <id>'); process.exit(1); }
      return enable(argv[1], false);
    }
    if (flag === '--disable') {
      if (!argv[1]) { console.error('Usage: --disable <id>'); process.exit(1); }
      return disable(argv[1]);
    }
    if (flag === '--all') return await walk(true);
    if (!flag) return await walk(false);
    console.error(`Unknown option: ${flag}`);
    process.exit(1);
  } catch (e) {
    console.error('setup-wizard: ' + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { enable, disable, showStatus };
