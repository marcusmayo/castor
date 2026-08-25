const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
process.env.AGENT_ROOT = tmp;
fs.copyFileSync(path.join(ROOT, 'gate', 'never-egress.example.json'), path.join(ROOT, 'gate', 'never-egress.json'));
// mirror the agent dirs the jobs expect
for (const d of ['state','state/pipeline','state/weekly-reports','knowledge','inbox','inbox/archive','logs','gate']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'gate', 'never-egress.json'), path.join(tmp, 'gate', 'never-egress.json'));
// the jobs resolve modules from AGENT_ROOT/scripts — point those at our scripts
fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(tmp, 'scripts'));
fs.symlinkSync(path.join(ROOT, 'gate'), path.join(tmp, 'gate2')); // keep a ref; audit uses AGENT_ROOT/logs anyway

let pass = 0; const fail = [];
function t(n, fn) { try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail.push(n); console.log('  FAIL  ' + n + ' :: ' + e.message); } }
function sh(cmd, args, opts={}) { try { return { code:0, out: execFileSync(cmd,args,{encoding:'utf8',...opts}) }; } catch(e){ return { code:e.status, out:(e.stdout||'')+(e.stderr||'') }; } }
const env = { ...process.env, AGENT_ROOT: tmp };

console.log('\n--- scan-tree (reuses gate patterns) ---');
t('detects an email and a secret in the tree', () => {
  fs.writeFileSync(path.join(tmp,'state','leak.md'), 'contact a@b.com and key AKIAIOSFODNN7EXAMPLE\n');
  const r = sh('node', [path.join(ROOT,'scripts','scan-tree.js'), path.join(tmp,'state')]);
  assert.strictEqual(r.code, 1);
  assert.ok(/finding/.test(r.out));
});
t('clean subtree exits 0', () => {
  const r = sh('node', [path.join(ROOT,'scripts','scan-tree.js'), path.join(tmp,'knowledge')]);
  assert.strictEqual(r.code, 0);
});
t('sample only truncated, full match not printed', () => {
  const r = sh('node', [path.join(ROOT,'scripts','scan-tree.js'), path.join(tmp,'state')]);
  assert.ok(!r.out.includes('AKIAIOSFODNN7EXAMPLE'), 'full secret leaked to output');
});
fs.unlinkSync(path.join(tmp,'state','leak.md'));

console.log('\n--- health-check ---');
t('healthy tree: exit 0, silent', () => {
  const r = sh('node', [path.join(ROOT,'scripts','health-check.js')], { env });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '', 'should be silent on success');
});
t('missing tripwire config fails', () => {
  const gone = path.join(tmp,'gate','never-egress.json');
  fs.renameSync(gone, gone+'.bak');
  const r = sh('node', [path.join(ROOT,'scripts','health-check.js')], { env });
  assert.strictEqual(r.code, 1);
  assert.ok(/tripwire-config/.test(r.out));
  fs.renameSync(gone+'.bak', gone);
});
t('broken audit chain fails', () => {
  fs.writeFileSync(path.join(tmp,'logs','audit.jsonl'),
    '{"ts":"x","prev_hash":"GENESIS","hash":"deadbeef"}\n{"ts":"y","prev_hash":"WRONG","hash":"abc"}\n');
  const r = sh('node', [path.join(ROOT,'scripts','health-check.js')], { env });
  assert.strictEqual(r.code, 1);
  assert.ok(/audit-chain/.test(r.out));
  fs.unlinkSync(path.join(tmp,'logs','audit.jsonl'));
});

console.log('\n--- digest (pending counts) ---');
t('digest aggregates deadlines, pipeline, and intake pending', () => {
  fs.writeFileSync(path.join(tmp,'state','action-register.md'),
    '# Action Register\n\n| id | opened | description | owner | status | pipeline | estimate | due |\n|-|-|-|-|-|-|-|-|\n| ACT-000001 | 2026-07-01 | Overdue thing | eng | open | review | 1w | |\n');
  fs.writeFileSync(path.join(tmp,'state','pipeline','p1.yaml'), 'id: EP-1\nname: Thing\nstage: in-progress\n');
  // two intake sidecars: one flagged, one vision-pending
  fs.writeFileSync(path.join(tmp,'inbox','a.csv.flags.json'), JSON.stringify({ tripwire:{flagged:true}, has_vision_pending:false, has_unscanned:false }));
  fs.writeFileSync(path.join(tmp,'inbox','b.png.flags.json'), JSON.stringify({ tripwire:{flagged:false}, has_vision_pending:true, has_unscanned:false }));
  const r = sh('node', [path.join(ROOT,'scripts','digest.js')], { env });
  assert.strictEqual(r.code, 0);
  const files = fs.readdirSync(path.join(tmp,'state','weekly-reports')).filter(f=>f.endsWith('.md'));
  assert.strictEqual(files.length, 1);
  const txt = fs.readFileSync(path.join(tmp,'state','weekly-reports',files[0]),'utf8');
  assert.ok(/Overdue: 1/.test(txt), 'overdue not counted');
  assert.ok(/in-progress: 1/.test(txt), 'pipeline stage not counted');
  assert.ok(/Flagged: 1/.test(txt) && /Vision-pending: 1/.test(txt), 'intake pending counts wrong:\n'+txt);
});

console.log('\n--- log-rotate: audit chain preservation (critical) ---');
t('small audit.jsonl is NOT rotated', () => {
  const a = path.join(tmp,'logs','audit.jsonl');
  fs.writeFileSync(a, '{"ts":"x","hash":"h1"}\n');
  const before = fs.readFileSync(a,'utf8');
  sh('bash', [path.join(ROOT,'scripts','log-rotate.sh')], { env });
  assert.strictEqual(fs.readFileSync(a,'utf8'), before, 'small audit file must be untouched');
  fs.unlinkSync(a);
});
t('oversized audit.jsonl is ARCHIVED before a fresh chain starts', () => {
  const a = path.join(tmp,'logs','audit.jsonl');
  const big = '{"ts":"x","hash":"h","pad":"' + 'y'.repeat(200) + '"}\n';
  fs.writeFileSync(a, big.repeat(60000)); // > 10MB
  const origBytes = fs.statSync(a).size;
  const r = sh('bash', [path.join(ROOT,'scripts','log-rotate.sh')], { env: { ...env, LOG_ROTATE_MAX_BYTES: '1048576' } });
  // archived copy exists and holds the original content
  const arch = fs.readdirSync(path.join(tmp,'logs','archive')).filter(f=>f.startsWith('audit-')&&f.endsWith('.gz'));
  assert.strictEqual(arch.length, 1, 'no archived audit segment');
  const gunzipped = execFileSync('gunzip', ['-c', path.join(tmp,'logs','archive',arch[0])], { maxBuffer: 64*1024*1024 });
  assert.ok(gunzipped.length >= origBytes - 100, 'archived chain is truncated — provenance lost');
  // fresh chain references the archive and did not delete the old data
  const fresh = fs.readFileSync(a,'utf8');
  assert.ok(/CHAIN_ROTATED/.test(fresh) && new RegExp(arch[0]).test(fresh), 'fresh chain does not reference the archive');
  fs.unlinkSync(a); fs.rmSync(path.join(tmp,'logs','archive'), {recursive:true, force:true});
});

console.log('\n--- azure-backup: capability gating ---');
t('declined capability -> skip, exit 0', () => {
  fs.writeFileSync(path.join(tmp,'state','capabilities.json'), JSON.stringify({ azure_backup:{status:'declined'} }));
  const r = sh('bash', [path.join(ROOT,'scripts','azure-backup.sh')], { env });
  assert.strictEqual(r.code, 0);
  assert.ok(/not enabled|skipping/.test(r.out));
});
t('enabled but azcopy absent -> exit 1 with reason', () => {
  fs.writeFileSync(path.join(tmp,'state','capabilities.json'), JSON.stringify({ azure_backup:{status:'enabled'} }));
  const r = sh('bash', [path.join(ROOT,'scripts','azure-backup.sh')], { env: { ...env, BACKUP_STORAGE_ACCOUNT:'acct', BACKUP_CONTAINER:'c', PATH:'/usr/bin:/bin' } });
  assert.strictEqual(r.code, 1);
  assert.ok(/azcopy/.test(r.out));
  fs.unlinkSync(path.join(tmp,'state','capabilities.json'));
});

console.log('\n--- pii-weekly-scan ---');
t('findings -> exit 1 and logged', () => {
  fs.writeFileSync(path.join(tmp,'knowledge','pii.md'), 'ssn 123-45-6789\n');
  const r = sh('bash', [path.join(ROOT,'scripts','pii-weekly-scan.sh')], { env });
  assert.strictEqual(r.code, 1);
  assert.ok(fs.existsSync(path.join(tmp,'logs','pii-scan.log')));
  fs.unlinkSync(path.join(tmp,'knowledge','pii.md'));
});
t('clean tree -> exit 0', () => {
  const r = sh('bash', [path.join(ROOT,'scripts','pii-weekly-scan.sh')], { env });
  assert.strictEqual(r.code, 0);
});

console.log('\n--- sunday-maintenance: MEMORY.md sole writer ---');
t('writes MEMORY.md with deterministic snapshot', () => {
  fs.writeFileSync(path.join(tmp,'state','pipeline','p2.yaml'), 'id: EP-2\nname: Two\nstage: blocked\n');
  const r = sh('python3', [path.join(ROOT,'scripts','sunday-maintenance.py')], { env });
  assert.strictEqual(r.code, 0);
  const mem = fs.readFileSync(path.join(tmp,'MEMORY.md'),'utf8');
  assert.ok(/Written only by the weekly maintenance path/.test(mem));
  assert.ok(/blocked: 1/.test(mem) && /in-progress: 1/.test(mem), 'pipeline snapshot wrong:\n'+mem);
});
t('dry-run does not write MEMORY.md', () => {
  fs.rmSync(path.join(tmp,'MEMORY.md'), {force:true});
  const r = sh('python3', [path.join(ROOT,'scripts','sunday-maintenance.py'), '--dry-run'], { env });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(tmp,'MEMORY.md')), 'dry-run must not write');
});
t('prunes old archive entries only', () => {
  const oldF = path.join(tmp,'inbox','archive','old.csv');
  const newF = path.join(tmp,'inbox','archive','new.csv');
  fs.writeFileSync(oldF,'x'); fs.writeFileSync(newF,'y');
  const old = Date.now()/1000 - 100*86400;
  fs.utimesSync(oldF, old, old);
  sh('python3', [path.join(ROOT,'scripts','sunday-maintenance.py')], { env });
  assert.ok(!fs.existsSync(oldF), 'old archive entry should be pruned');
  assert.ok(fs.existsSync(newF), 'recent archive entry must be kept');
});

console.log(`\nSCHEDULED JOBS: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
