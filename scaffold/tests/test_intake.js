const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
process.env.AGENT_ROOT = tmp;
process.env.INTAKE_STABILITY_MS = '5';

fs.copyFileSync(path.join(ROOT, 'gate', 'never-egress.example.json'), path.join(ROOT, 'gate', 'never-egress.json'));

const intake = require(path.join(ROOT, 'scripts', 'intake.js'));
const audit = require(path.join(ROOT, 'gate', 'audit.js'));

let pass = 0; const fail = [];
function t(n, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  PASS  ' + n); }).catch(e => { fail.push(n); console.log('  FAIL  ' + n + ' :: ' + e.message); }); }

const drop = f => path.join(intake.DROP, f);
function putFile(name, srcAbs) { fs.mkdirSync(intake.DROP, { recursive: true }); fs.copyFileSync(srcAbs, drop(name)); }
function putText(name, content) { fs.mkdirSync(intake.DROP, { recursive: true }); fs.writeFileSync(drop(name), content); }
const inboxFiles = () => fs.readdirSync(intake.INBOX).filter(f => fs.statSync(path.join(intake.INBOX, f)).isFile());
const admittedFiles = () => inboxFiles().filter(f => !f.endsWith('.flags.json') && !f.endsWith('.vision-pending.json'));
const quar = () => fs.readdirSync(intake.QUARANTINE).filter(f => !f.endsWith('.reason.txt'));
function flagsFor(destSuffix) { const f = inboxFiles().find(x => x.endsWith(destSuffix + '.flags.json')); return f ? JSON.parse(fs.readFileSync(path.join(intake.INBOX, f), 'utf8')) : null; }
function silent(fn) { const o = console.log; console.log = () => {}; const r = fn(); if (r && r.then) return r.finally(() => { console.log = o; }); console.log = o; return r; }
const run = () => silent(() => intake.runOnce());

(async () => {
  console.log('\n--- admits every supported type with correct scan state ---');
  await t('all supported types admitted; scan states correct', async () => {
    putText('a.csv', 'id,title\n1,Roadmap\n');
    putText('b.md', '# Notes\ngreen\n');
    putFile('c.xlsx', path.join(FIX, 'backlog.xlsx'));
    putFile('text.pdf', path.join(FIX, 'report.pdf'));
    putFile('scan.pdf', path.join(FIX, 'scanned.pdf'));
    putFile('s.png', path.join(FIX, 'status.png'));
    putFile('diag.png', path.join(FIX, 'diagram.png'));
    putFile('e.docx', path.join(FIX, 'brief.docx'));
    const r = await run();
    assert.strictEqual(r.length, 8, JSON.stringify(r.map(x => [x.file, x.outcome])));
    assert.ok(r.every(x => x.outcome === 'admitted'), 'all should admit');
    assert.strictEqual(flagsFor('text.pdf').extraction.scan_state, 'scanned');
    assert.strictEqual(flagsFor('scan.pdf').extraction.scan_state, 'unscanned');
    assert.strictEqual(flagsFor('scan.pdf').has_unscanned, true);
    assert.strictEqual(flagsFor('s.png').extraction.scan_state, 'scanned');
    assert.strictEqual(flagsFor('diag.png').extraction.scan_state, 'vision-pending');
    assert.strictEqual(flagsFor('diag.png').has_vision_pending, true);
    assert.strictEqual(flagsFor('c.xlsx').extraction.extractor, 'sheetjs');
    assert.strictEqual(flagsFor('e.docx').extraction.scan_state, 'scanned');
  });
  await t('diagram image writes a vision-pending marker', () => {
    const marker = inboxFiles().find(f => f.endsWith('diag.png.vision-pending.json'));
    assert.ok(marker, 'no vision-pending marker written');
    const m = JSON.parse(fs.readFileSync(path.join(intake.INBOX, marker), 'utf8'));
    assert.ok(m.targets.includes('<self>'));
    assert.ok(/attested vision/i.test(m.instructions));
  });


  console.log('\n--- email recursion ---');
  await t('eml admitted, body + attachments in flags', async () => {
    putFile('mail.eml', path.join(FIX, 'message.eml'));
    await run();
    const fl = flagsFor('mail.eml');
    assert.strictEqual(fl.extraction.extractor, 'mailparser');
    assert.strictEqual(fl.attachments.length, 2);
    assert.ok(fl.attachments.find(a => a.name === 'rows.csv' && a.scan_state === 'scanned'));
    assert.ok(fl.attachments.find(a => a.name === 'chart.png' && a.scan_state === 'vision-pending'));
    assert.strictEqual(fl.has_vision_pending, true, 'attachment vision-pending should propagate');
  });

  console.log('\n--- tripwire FLAGS, does not refuse ---');
  await t('term in csv is admitted and flagged', async () => {
    putText('leak.csv', 'id,note\n1,budget for REPLACE_WITH_CLIENT_NAME\n');
    const r = await run();
    assert.strictEqual(r[0].outcome, 'admitted', 'must not quarantine on tripwire');
    assert.ok(admittedFiles().some(f => f.endsWith('leak.csv')), 'flagged file must reach inbox');
    const fl = flagsFor('leak.csv');
    assert.strictEqual(fl.tripwire.flagged, true);
    assert.strictEqual(fl.tripwire.hits[0].type, 'TERM');
    assert.strictEqual(fl.tripwire.hits[0].unit, 'body');
  });
  await t('term inside email attachment is flagged with unit', async () => {
    const b = '=_b_=';
    const att = Buffer.from('id,note\n1,contains REPLACE_WITH_EMPLOYER_NAME\n').toString('base64');
    const eml = ['From: a@b.com','To: c@d.com','Subject: rollup','MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${b}"`,'',`--${b}`,'Content-Type: text/plain','','clean body','',
      `--${b}`,'Content-Type: text/csv','Content-Disposition: attachment; filename="x.csv"','Content-Transfer-Encoding: base64','',att,'',`--${b}--`,''].join('\r\n');
    putText('leaky.eml', eml);
    await run();
    const fl = flagsFor('leaky.eml');
    assert.strictEqual(fl.tripwire.flagged, true);
    assert.ok(fl.tripwire.hits.some(h => h.unit === 'attachment:x.csv'), 'hit must be attributed to the attachment');
  });
  await t('secret pattern flagged not refused', async () => {
    putText('creds.md', 'key AKIAIOSFODNN7EXAMPLE\n');
    const r = await run();
    assert.strictEqual(r[0].outcome, 'admitted');
    assert.strictEqual(flagsFor('creds.md').tripwire.hits.some(h => h.type === 'PATTERN'), true);
  });
  await t('clean file admitted, not flagged', async () => {
    putText('clean.md', '# Roadmap\nAll items green.\n');
    await run();
    const fl = flagsFor('clean.md');
    assert.strictEqual(fl.tripwire.flagged, false);
    assert.strictEqual(fl.tripwire.scanned, true);
  });

  console.log('\n--- structural quarantine only ---');
  await t('unsupported type quarantined', async () => { putText('x.exe', 'MZ'); const r = await run(); assert.strictEqual(r[0].outcome, 'quarantined'); assert.ok(quar().some(f => f.endsWith('x.exe'))); });
  await t('empty file quarantined', async () => { putText('empty.csv', ''); const r = await run(); assert.strictEqual(r[0].outcome, 'quarantined'); assert.strictEqual(r[0].reason, 'empty file'); });
  await t('unparseable but supported (.msg) admitted unscanned, not quarantined', async () => {
    putFile('bad.msg', path.join(FIX, 'bogus.msg'));
    const r = await run();
    assert.strictEqual(r[0].outcome, 'admitted');
    assert.strictEqual(flagsFor('bad.msg').extraction.scan_state, 'unscanned');
  });

  console.log('\n--- idempotence ---');
  await t('identical content not re-admitted', async () => {
    const before = admittedFiles().length;
    putText('dup.csv', 'id,title\n1,Roadmap\n');   // same bytes as a.csv
    const r = await run();
    assert.strictEqual(r[0].outcome, 'duplicate', JSON.stringify(r[0]));
    assert.strictEqual(admittedFiles().length, before);
  });

  console.log('\n--- fail-closed config is explicit, not silent-clean ---');
  await t('missing tripwire config -> admitted but scanned=false', async () => {
    fs.unlinkSync(path.join(ROOT, 'gate', 'never-egress.json'));
    delete require.cache[require.resolve(path.join(ROOT, 'gate', 'tripwire.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'intake.js'))];
    const fresh = require(path.join(ROOT, 'scripts', 'intake.js'));
    fs.mkdirSync(fresh.DROP, { recursive: true });
    fs.writeFileSync(path.join(fresh.DROP, 'noconfig.md'), '# anything\n');
    await silent(() => fresh.runOnce());
    const f = fs.readdirSync(fresh.INBOX).find(x => x.endsWith('noconfig.md.flags.json'));
    const fl = JSON.parse(fs.readFileSync(path.join(fresh.INBOX, f), 'utf8'));
    assert.strictEqual(fl.tripwire.config_error, true);
    assert.strictEqual(fl.tripwire.scanned, false, 'must not claim a clean scan when config is missing');
    assert.strictEqual(fl.tripwire.flagged, false);
    fs.copyFileSync(path.join(ROOT, 'gate', 'never-egress.example.json'), path.join(ROOT, 'gate', 'never-egress.json'));
  });

  console.log('\n--- audit + no-content guarantees ---');
  await t('audit chain verifies', () => { const v = audit.verify(); assert.strictEqual(v.ok, true, 'broken at ' + v.brokenAt); assert.ok(v.length >= 12); });
  await t('admissions and quarantines both recorded', () => { const raw = fs.readFileSync(audit.LOG, 'utf8'); assert.ok(raw.includes('"status":"ADMITTED"')); assert.ok(raw.includes('"status":"QUARANTINED"')); });
  await t('audit stores no file content', () => { const raw = fs.readFileSync(audit.LOG, 'utf8'); assert.ok(!raw.includes('Roadmap')); assert.ok(!raw.includes('AKIAIOSFODNN7EXAMPLE')); });
  await t('flag sidecars store no content, only rule ids + locations', () => {
    for (const f of inboxFiles().filter(x => x.endsWith('.flags.json'))) {
      const raw = fs.readFileSync(path.join(intake.INBOX, f), 'utf8');
      assert.ok(!raw.includes('Roadmap review') && !raw.includes('AKIAIOSFODNN7EXAMPLE'), 'content leaked into ' + f);
    }
    const leak = flagsFor('leak.csv');
    assert.ok(typeof leak.tripwire.hits[0].location === 'number');
    assert.ok(!JSON.stringify(leak).includes('budget for'), 'matched text must not be stored');
  });

  console.log(`\nINTAKE LANE: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
})();
