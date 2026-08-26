const assert = require('assert');
const path = require('path'), crypto = require('crypto'), fs = require('fs'), os = require('os');

// This test used to point AGENT_ROOT at a `root/` fixture directory that is not in the repo,
// and authenticate by minting a TOTP token against /verify. Both were gone: the fixture was
// never committed, and app-TOTP was removed fleet-wide when Cloudflare Access became the sole
// authenticator. It asserted a deleted mechanism against a missing tree, and nothing noticed
// because nothing ran it. It now builds its own root the way test_pending.js does, and
// authenticates the way the fleet actually does -- a Cf-Access header, which is what
// fleet-core auth.requireAuth reads.
const REPO = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendinghttp-'));
// server.js requires gate/ and scripts/ from AGENT_ROOT; link the real ones rather than copy,
// so the test exercises the vendored core actually shipped in this image.
for (const d of ['gate', 'scripts', 'system']) fs.symlinkSync(path.join(REPO, d), path.join(ROOT, d), 'dir');
for (const d of ['state', 'inbox']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const inbox = path.join(ROOT, 'inbox');
function flags(name, obj) { fs.writeFileSync(path.join(inbox, name + '.flags.json'), JSON.stringify(obj)); }
fs.copyFileSync(path.join(__dirname, 'fixtures', 'diagram.png'), path.join(inbox, '2026-07-25_d.png'));
fs.writeFileSync(path.join(inbox, '2026-07-25_a.csv'), 'col\n1\n');
const PNG_SHA = crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, '2026-07-25_d.png'))).digest('hex');
flags('2026-07-25_a.csv', { file: '2026-07-25_a.csv', extraction: { type: '.csv', scan_state: 'scanned' }, tripwire: { flagged: false }, has_vision_pending: false, has_unscanned: false });
flags('2026-07-25_d.png', { file: '2026-07-25_d.png', extraction: { type: '.png', scan_state: 'vision-pending' }, tripwire: { flagged: false }, has_vision_pending: true, has_unscanned: false, sha256: PNG_SHA });

process.env.AGENT_ROOT = ROOT;
process.env.CASTOR_BIND = '127.0.0.1';
delete process.env.AUTH_MODE;              // never let a local-mode env turn the gate off
const { server } = require(path.join(REPO, 'webchat', 'server.js'));

// The one way to be authenticated: an edge header. There is no login page and no token.
const AUTHED = { 'cf-access-client-id': 'test-service-token' };

let pass = 0; const fail = [];
function t(n, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  PASS  ' + n); }).catch(e => { fail.push(n); console.log('  FAIL  ' + n + ' :: ' + e.message); }); }

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n--- auth gate (edge-only) ---');
  await t('/pending refused without an edge header (403)', async () => {
    assert.strictEqual((await fetch(base + '/pending')).status, 403);
  });
  await t('the removed login mechanism stays removed', async () => {
    for (const p of ['/login', '/verify']) {
      const r = await fetch(base + p, { method: p === '/verify' ? 'POST' : 'GET' });
      assert.strictEqual(r.status, 404, p + ' answered ' + r.status + ' -- app-TOTP was removed; nothing should mount it');
    }
  });

  console.log('\n--- /pending listing ---');
  await t('groups returned; vision-pending item has sha256', async () => {
    const d = await (await fetch(base + '/pending', { headers: AUTHED })).json();
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.groups.ready.length, 1);
    assert.strictEqual(d.groups.visionPending.length, 1);
    assert.ok(d.groups.visionPending[0].sha256 && d.groups.visionPending[0].sha256.length === 64);
  });

  console.log('\n--- /pending/image whitelist ---');
  await t('valid image 200', async () => { assert.strictEqual((await fetch(base + '/pending/image/2026-07-25_d.png', { headers: AUTHED })).status, 200); });
  await t('non-image 400', async () => { assert.strictEqual((await fetch(base + '/pending/image/2026-07-25_a.csv', { headers: AUTHED })).status, 400); });

  console.log('\n--- /pending/interpret route wiring (no network) ---');
  await t('matching hash, no vision key -> key error', async () => {
    delete process.env.VISION_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r = await (await fetch(base + '/pending/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTHED }, body: JSON.stringify({ name: '2026-07-25_d.png', sha256: PNG_SHA }) })).json();
    assert.strictEqual(r.ok, false); assert.ok(/key/.test(r.error), 'got: ' + r.error);
  });
  await t('wrong hash blocked', async () => {
    const r = await (await fetch(base + '/pending/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTHED }, body: JSON.stringify({ name: '2026-07-25_d.png', sha256: 'deadbeef' }) })).json();
    assert.strictEqual(r.ok, false); assert.ok(/mismatch/.test(r.error));
  });
  await t('chat.html has pending panel + interpret', async () => {
    const html = fs.readFileSync(path.join(REPO, 'webchat', 'chat.html'), 'utf8');
    assert.ok(html.includes('togglePending') && html.includes('/pending/interpret'));
  });

  console.log(`\nPENDING HTTP: ${pass} passed, ${fail.length} failed`);
  server.close();
  if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
})();
