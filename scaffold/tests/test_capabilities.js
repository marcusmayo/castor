const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
fs.mkdirSync(path.join(tmp, 'System'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'System', 'capabilities.yaml'), path.join(tmp, 'System', 'capabilities.yaml'));
process.env.AGENT_ROOT = tmp;

let pass = 0; const fail = [];
function t(n, fn) { try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail.push(n); console.log('  FAIL  ' + n + ' :: ' + e.message); } }

const cap = require(path.join(ROOT, 'scripts', 'capability.js'));

console.log('\n--- registry ---');
t('loads six capabilities', () => assert.strictEqual(cap.loadRegistry().length, 6));
t('ids are unique', () => {
  const ids = cap.loadRegistry().map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});
t('calendar is optional with an ics-url secret', () => {
  const cal = cap.loadRegistry().find(c => c.id === 'calendar');
  assert.ok(cal); assert.strictEqual(cal.required, false);
  assert.strictEqual(cal.secrets[0].name, 'calendar-ics-url');
});
t('exactly one required capability (model)', () => {
  const req = cap.loadRegistry().filter(c => c.required);
  assert.strictEqual(req.length, 1); assert.strictEqual(req[0].id, 'model');
});
t('every capability documents what is lost', () => {
  for (const c of cap.loadRegistry()) assert.ok((c.without || []).length > 0, c.id + ' has no without[]');
});
t('every capability has setup steps', () => {
  for (const c of cap.loadRegistry()) assert.ok((c.setup || []).length > 0, c.id + ' has no setup[]');
});
t('registry contains no secret values', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'System', 'capabilities.yaml'), 'utf8');
  for (const re of [/\bsk-[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}/, /\bghp_[A-Za-z0-9]{36}/, /\b\d{9,}:[A-Za-z0-9_-]{30,}/]) {
    assert.ok(!re.test(raw), 'possible credential in registry: ' + re);
  }
});
t('unknown id rejected', () => assert.throws(() => cap.get('nope'), /unknown capability/));

console.log('\n--- state transitions ---');
t('starts unset', () => assert.strictEqual(cap.status('telegram'), 'unset'));
t('decline persists', () => {
  cap.setStatus('telegram', 'declined');
  assert.strictEqual(cap.status('telegram'), 'declined');
});
t('re-enable persists', () => {
  cap.setStatus('telegram', 'enabled');
  assert.strictEqual(cap.status('telegram'), 'enabled');
});
t('state file is 0600 and gitignore-shaped path', () => {
  const mode = fs.statSync(cap.STATE).mode & 0o777;
  assert.strictEqual(mode, 0o600);
  assert.ok(cap.STATE.includes(path.join('state', 'capabilities.json')));
});
t('invalid status rejected', () => assert.throws(() => cap.setStatus('telegram', 'maybe'), /invalid status/));

console.log('\n--- guard behaviour ---');
function runGuard(id) {
  const script = `process.env.AGENT_ROOT=${JSON.stringify(tmp)};` +
    `require(${JSON.stringify(path.join(ROOT, 'scripts', 'capability.js'))}).requireCapability(${JSON.stringify(id)});` +
    `console.log('STARTED');`;
  try {
    const out = execFileSync('node', ['-e', script], { encoding: 'utf8' });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}
t('enabled capability allows start', () => {
  cap.setStatus('resend', 'enabled');
  const r = runGuard('resend');
  assert.strictEqual(r.code, 0); assert.ok(r.out.includes('STARTED'));
});
t('declined capability blocks start with EX_CONFIG', () => {
  cap.setStatus('resend', 'declined');
  const r = runGuard('resend');
  assert.strictEqual(r.code, 78);
  assert.ok(!r.out.includes('STARTED'), 'process must not proceed');
});
t('block message names the capability and the fix', () => {
  const r = runGuard('resend');
  assert.ok(r.err.includes('Outbound email'), 'missing capability name');
  assert.ok(r.err.includes('--enable resend'), 'missing re-enable command');
  assert.ok(r.err.includes('What is unavailable'), 'missing loss description');
});
t('unset capability also blocks', () => {
  const r = runGuard('cloudflare_tunnel');
  assert.strictEqual(r.code, 78);
});

console.log('\n--- wizard CLI ---');
function wiz(args) {
  try {
    return { code: 0, out: execFileSync('node', [path.join(ROOT, 'scripts', 'setup-wizard.js'), ...args],
      { encoding: 'utf8', env: { ...process.env, AGENT_ROOT: tmp, FETCH_SECRET: '/nonexistent' } }) };
  } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
t('--status lists all and flags missing required', () => {
  const r = wiz(['--status']);
  assert.strictEqual(r.code, 0);
  for (const id of ['model', 'telegram', 'resend', 'azure_backup', 'cloudflare_tunnel', 'calendar']) assert.ok(r.out.includes(id), 'missing ' + id);
  assert.ok(r.out.includes('agent will not function'), 'required warning absent');
});
t('--disable states losses and re-enable path', () => {
  const r = wiz(['--disable', 'azure_backup']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('DECLINED'));
  assert.ok(r.out.includes('--enable azure_backup'));
  assert.ok(/no off-box copy/i.test(r.out), 'loss text absent');
});
t('--disable on required capability warns', () => {
  const r = wiz(['--disable', 'model']);
  assert.ok(r.out.includes('WARNING'));
  assert.ok(r.out.includes('cannot'));
});
t('--enable with no secret required verifies clean', () => {
  const r = wiz(['--enable', 'azure_backup']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('no secret required'));
  assert.ok(r.out.includes('ENABLED'));
});
t('--enable with missing fetch-secret does not claim success', () => {
  const r = wiz(['--enable', 'telegram']);
  assert.ok(r.out.includes('SKIPPED'), 'should report verification skipped');
});
t('wizard prints az command, never a value', () => {
  const r = wiz(['--enable', 'telegram']);
  assert.ok(r.out.includes('az keyvault secret set'));
  assert.ok(!/--value\s+\S*[A-Za-z0-9]{25,}/.test(r.out), 'a real-looking value appeared in output');
});
t('unknown flag exits non-zero', () => assert.notStrictEqual(wiz(['--bogus']).code, 0));

console.log(`\nCAPABILITY REGISTRY: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
