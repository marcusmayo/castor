const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const GATE = require('path').join(__dirname, '..', 'gate');
let pass = 0; const fail = [];
function t(name, fn) { try { fn(); pass++; console.log('  PASS  ' + name); } catch (e) { fail.push(name); console.log('  FAIL  ' + name + ' :: ' + e.message); } }

// isolate the audit log
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'castor-'));
process.env.AGENT_ROOT = tmpRoot;

console.log('\n--- tripwire: fail closed ---');
const cfg = path.join(GATE, 'never-egress.json');
if (fs.existsSync(cfg)) fs.unlinkSync(cfg);
delete require.cache[require.resolve(GATE + '/tripwire')];
const { checkTripwire } = require(GATE + '/tripwire');
t('missing config blocks everything', () => {
  const r = checkTripwire('totally benign text');
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.hits[0].type, 'CONFIG_ERROR');
});

console.log('\n--- tripwire: with config ---');
fs.copyFileSync(path.join(GATE, 'never-egress.example.json'), cfg);
t('term hit blocks', () => {
  const r = checkTripwire('notes about REPLACE_WITH_CLIENT_NAME budget');
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.hits.some(h => h.type === 'TERM'), true);
});
t('pattern hit blocks (aws key)', () => {
  const r = checkTripwire('key AKIAIOSFODNN7EXAMPLE here');
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.hits.some(h => h.type === 'PATTERN'), true);
});
t('clean text passes', () => {
  assert.strictEqual(checkTripwire('quarterly roadmap review notes').blocked, false);
});

console.log('\n--- redact + rehydrate round-trip ---');
const { redact } = require(GATE + '/redact');
const { prepareForEgress, rehydrate } = require(GATE + '/gate');
t('email/phone/amount tokenized', () => {
  const r = redact('Contact sarah.chen@example.com or 555-123-4567 re $2.5 million');
  assert.ok(!r.redacted.includes('sarah.chen@example.com'), 'email leaked');
  assert.ok(!r.redacted.includes('555-123-4567'), 'phone leaked');
  assert.ok(!r.redacted.includes('$2.5 million'), 'amount leaked');
  assert.ok(/\[EMAIL_1\]/.test(r.redacted));
});
t('same value reuses one token', () => {
  const r = redact('a@b.com and again a@b.com');
  assert.strictEqual(r.counters.EMAIL, 1);
});
t('rehydrate restores exactly', () => {
  const src = 'Email sarah.chen@example.com about the $4,200,000 contract, call 555-987-6543.';
  const p = prepareForEgress(src, {}, {});
  assert.strictEqual(p.status, 'OK', 'expected OK, got ' + p.status);
  assert.strictEqual(rehydrate(p.redacted, p.mapState), src);
});
t('token collision order (PERSON_1 vs PERSON_10)', () => {
  const map = {}; const rev = {}; const counters = { PERSON:0, ORG:0, EMAIL:0, PHONE:0, AMOUNT:0 };
  for (let i = 1; i <= 11; i++) { map[`[EMAIL_${i}]`] = `u${i}@x.com`; }
  const out = rehydrate('[EMAIL_1] and [EMAIL_11]', { map });
  assert.strictEqual(out, 'u1@x.com and u11@x.com');
});
t('blocked text never reaches redaction', () => {
  const p = prepareForEgress('budget for REPLACE_WITH_CLIENT_NAME', {}, {});
  assert.strictEqual(p.status, 'BLOCKED');
  assert.strictEqual(p.redacted, undefined);
  assert.ok(p.notification.includes('EGRESS BLOCKED'));
});
t('override proceeds and is flagged', () => {
  const p = prepareForEgress('budget for REPLACE_WITH_CLIENT_NAME', {}, { allowOverride: true });
  assert.strictEqual(p.status, 'OVERRIDE');
  assert.ok(p.overrideHits.length > 0);
});

console.log('\n--- audit chain ---');
const audit = require(GATE + '/audit');
t('records and verifies', () => {
  audit.record({ action: 'TEST', status: 'OK', n: 1 });
  audit.record({ action: 'TEST', status: 'OK', n: 2 });
  audit.record({ action: 'TEST', status: 'OK', n: 3 });
  const v = audit.verify();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.length, 3);
});
t('creates log dir when absent', () => { assert.ok(fs.existsSync(audit.LOG)); });
t('detects tampering', () => {
  const lines = fs.readFileSync(audit.LOG, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[1]); e.n = 99; lines[1] = JSON.stringify(e);
  fs.writeFileSync(audit.LOG, lines.join('\n') + '\n');
  const v = audit.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 1);
});
t('no content stored, metadata only', () => {
  const raw = fs.readFileSync(audit.LOG, 'utf8');
  assert.ok(!raw.includes('sarah.chen@example.com'));
});

console.log(`\nSHARED CORE: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
