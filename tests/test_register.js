const assert = require('assert');
const path = require('path');
const reg = require(path.join(__dirname, '..', 'scripts', 'register.js'));
let pass = 0; const fail = [];
function t(n, fn) { try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail.push(n); console.log('  FAIL  ' + n + ' :: ' + e.message); } }

console.log('\n--- id growth without breaking ---');
t('first id is zero-padded to six', () => assert.strictEqual(reg.nextId([]), 'ACT-000001'));
t('increments within width', () => assert.strictEqual(reg.nextId(['ACT-000001','ACT-000002']), 'ACT-000003'));
t('thousands do not break', () => assert.strictEqual(reg.nextId(['ACT-000999','ACT-001500','ACT-000004']), 'ACT-001501'));
t('grows past a million, widening cleanly', () => assert.strictEqual(reg.nextId(['ACT-999999']), 'ACT-1000000'));
t('keeps growing past seven digits', () => assert.strictEqual(reg.nextId(['ACT-1000000','ACT-1000001']), 'ACT-1000002'));
t('ordering is integer, not lexical (10 > 9)', () => {
  // lexical sort would place ACT-0000010 before ACT-0000009; integer must not
  const ids = ['ACT-000010','ACT-000009','ACT-000100'];
  const maxByInt = ids.reduce((a,b)=> reg.idInt(a) >= reg.idInt(b) ? a : b);
  assert.strictEqual(maxByInt, 'ACT-000100');
  assert.strictEqual(reg.nextId(ids), 'ACT-000101');
});
t('malformed ids ignored, not fatal', () => assert.strictEqual(reg.nextId(['ACT-000005','garbage','ACT-','']), 'ACT-000006'));

console.log('\n--- register parsing ---');
const sampleMd = [
  '# Action Register','',
  '| id | opened | description | owner | status | pipeline | estimate | due |',
  '|----|--------|-------------|-------|--------|----------|----------|-----|',
  '| ACT-000001 | 2026-07-20 | Score the epics | platform | open | triage | 2w | |',
  '| ACT-000002 | 2026-07-22 | Interlock evidence | safety | in-progress | in-progress | | 2026-08-15 |',
  '| ACT-000003 | 2026-07-01 | Overdue item | eng | open | review | 1w | |',
].join('\n');
t('parses only data rows, skips header/separator', () => {
  const rows = reg.parse(sampleMd);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].id, 'ACT-000001');
  assert.strictEqual(rows[1].due, '2026-08-15');
});
t('column mapping correct', () => {
  const r = reg.parse(sampleMd)[0];
  assert.strictEqual(r.owner, 'platform');
  assert.strictEqual(r.pipeline, 'triage');
  assert.strictEqual(r.estimate, '2w');
});

console.log('\n--- estimate parsing ---');
t('2w -> 14 days', () => assert.strictEqual(reg.estimateDays('2w'), 14));
t('3 days -> 3', () => assert.strictEqual(reg.estimateDays('3 days'), 3));
t('1m -> 30', () => assert.strictEqual(reg.estimateDays('1m'), 30));
t('weeks spelled out', () => assert.strictEqual(reg.estimateDays('2 weeks'), 14));
t('garbage -> null', () => assert.strictEqual(reg.estimateDays('soon'), null));
t('empty -> null', () => assert.strictEqual(reg.estimateDays(''), null));

console.log('\n--- due resolution ---');
t('explicit due wins over estimate', () => {
  assert.strictEqual(reg.resolveDue({ opened:'2026-07-01', estimate:'2w', due:'2026-09-01' }), '2026-09-01');
});
t('estimate resolves from opened', () => {
  assert.strictEqual(reg.resolveDue({ opened:'2026-07-20', estimate:'2w', due:'' }), '2026-08-03');
});
t('no due and no estimate -> null', () => {
  assert.strictEqual(reg.resolveDue({ opened:'2026-07-20', estimate:'', due:'' }), null);
});
t('month estimate resolves', () => {
  assert.strictEqual(reg.resolveDue({ opened:'2026-01-01', estimate:'1m', due:'' }), '2026-01-31');
});

console.log('\n--- schedule classification ---');
t('overdue and due-soon split correctly', () => {
  const rows = reg.parse(sampleMd);
  const s = reg.schedule(rows, '2026-07-25', 14);
  // ACT-000003: opened 07-01 + 1w = 07-08 -> overdue vs 07-25
  assert.ok(s.overdue.some(r => r.id === 'ACT-000003'), 'ACT-000003 should be overdue');
  // ACT-000001: opened 07-20 + 2w = 08-03 -> within 14d of 07-25 -> due soon
  assert.ok(s.dueSoon.some(r => r.id === 'ACT-000001'), 'ACT-000001 should be due soon');
  // ACT-000002: due 08-15 -> beyond 14d horizon from 07-25 (08-08) -> neither
  assert.ok(!s.overdue.concat(s.dueSoon).some(r => r.id === 'ACT-000002'), 'ACT-000002 outside horizon');
});
t('done items excluded from schedule', () => {
  const rows = reg.parse(sampleMd).map(r => ({ ...r, status: 'done' }));
  const s = reg.schedule(rows, '2026-07-25', 14);
  assert.strictEqual(s.overdue.length + s.dueSoon.length, 0);
});
t('overdue sorted earliest-first', () => {
  const rows = [
    { id:'ACT-000010', opened:'2026-07-01', estimate:'', due:'2026-07-10', status:'open' },
    { id:'ACT-000011', opened:'2026-07-01', estimate:'', due:'2026-07-05', status:'open' },
  ];
  const s = reg.schedule(rows, '2026-07-25');
  assert.strictEqual(s.overdue[0].id, 'ACT-000011');
});

console.log('\n--- new row construction ---');
t('newRow takes next id and defaults', () => {
  const rows = reg.parse(sampleMd);
  const nr = reg.newRow(rows, { description:'New task', owner:'eng', estimate:'2w' });
  assert.strictEqual(nr.id, 'ACT-000004');
  assert.strictEqual(nr.status, 'open');
  assert.strictEqual(nr.description, 'New task');
});
t('renderRow round-trips through parse', () => {
  const nr = reg.newRow([], { opened:'2026-07-25', description:'Roundtrip', owner:'x', status:'open', pipeline:'intake', estimate:'1w', due:'' });
  const md = '| id | opened | description | owner | status | pipeline | estimate | due |\n|-|-|-|-|-|-|-|-|\n' + reg.renderRow(nr);
  const back = reg.parse(md)[0];
  assert.strictEqual(back.id, nr.id);
  assert.strictEqual(back.description, 'Roundtrip');
  assert.strictEqual(back.estimate, '1w');
});

console.log(`\nREGISTER: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
