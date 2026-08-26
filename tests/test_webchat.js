const assert = require('assert');
const path = require('path'), fs = require('fs'), os = require('os');

// Rewritten with test_pending_http.js for the same reason: this pointed AGENT_ROOT at a `root/`
// directory that is not in the repo, and authenticated by minting a TOTP token against /verify.
// app-TOTP was removed fleet-wide when Cloudflare Access became the sole authenticator, so the
// auth half of this file asserted a mechanism that no longer exists -- against a tree that never
// did. The surface assertions were still worth keeping, so they were kept and re-pointed.
const REPO = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-'));
for (const d of ['gate', 'scripts', 'system']) fs.symlinkSync(path.join(REPO, d), path.join(ROOT, d), 'dir');
for (const d of ['state', 'inbox']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

// The routing this agent actually ships; the default tier is read, never pinned. The old
// assertion named a model the config had since been re-pointed away from.
const yaml = require(path.join(REPO, 'webchat', 'node_modules', 'js-yaml'));
const ROUTING = yaml.load(fs.readFileSync(path.join(REPO, 'system', 'model-routing.yaml'), 'utf8'));
const DEFAULT_TIER = ROUTING.default_tier || 'routine';

process.env.AGENT_ROOT = ROOT;
process.env.SESSION_SECRET = 'test-secret';
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

  console.log('\n--- unauthenticated surface ---');
  await t('liveness probe is 200 without auth', async () => { assert.strictEqual((await fetch(base + '/health/liveliness')).status, 200); });
  await t('chat page refused without an edge header (403)', async () => { assert.strictEqual((await fetch(base + '/')).status, 403); });
  await t('/model refused without an edge header (403)', async () => { assert.strictEqual((await fetch(base + '/model')).status, 403); });

  console.log('\n--- the removed login mechanism stays removed ---');
  await t('no /login page', async () => { assert.strictEqual((await fetch(base + '/login')).status, 404); });
  await t('no /verify endpoint', async () => { assert.strictEqual((await fetch(base + '/verify', { method: 'POST' })).status, 404); });
  await t('server.js carries no TOTP verification', async () => {
    const src = fs.readFileSync(path.join(REPO, 'webchat', 'server.js'), 'utf8');
    for (const dead of ['speakeasy', 'TOTP_SECRET']) assert.ok(!src.includes(dead), 'still references ' + dead);
  });

  console.log('\n--- authenticated surface ---');
  // Assert that branding SUBSTITUTES, not what it substitutes to. chat.html ships the
  // literal {{AGENT_NAME}} and serveBranded fills it at serve time from the deploy-time
  // overlay system/agent.local.yaml, falling back to agent.yaml's profile default. Pinning
  // "Ask Castor" only held where no overlay exists -- so it passed in a bare checkout and
  // failed on every real agent, which is named heimdall or smalt.
  await t('chat page serves branded with THIS agent name', async () => {
    const auth = require(path.join(REPO, 'scripts', 'auth.js'));
    const name = auth.readAgentName(REPO) || 'Agent';
    const r = await fetch(base + '/', { headers: AUTHED });
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Ask ' + name), 'page does not greet as ' + name);
    assert.ok(!html.includes('{{AGENT_NAME}}'), 'placeholder left unsubstituted in the served page');
  });
  await t('/model returns routing whose default is the tier default_tier names', async () => {
    const d = await (await fetch(base + '/model', { headers: AUTHED })).json();
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.tiers.find(x => x.default).model_name, ROUTING.tiers[DEFAULT_TIER].model_name);
  });

  console.log('\n--- UI content: chips + discoverability ---');
  await t('all six Castor chips present', async () => {
    const html = fs.readFileSync(path.join(REPO, 'webchat', 'chat.html'), 'utf8');
    for (const c of ['/morning', '/pipeline', '/compliance-report', '/triage', '/people', '/draft']) assert.ok(html.includes("ins('" + c), 'missing ' + c);
  });
  // The operator can still change the model; the affordance moved. This used to assert the
  // page told you to run `model-routing.js set` -- a CLI instruction that was replaced by a
  // picker single-sourced in fleet-core. Pinning the instruction rather than the capability
  // is how it went stale, so assert the capability: the bar the picker mounts into, and the
  // shared control module that mounts it.
  await t('the operator can change the model from the page', async () => {
    const html = fs.readFileSync(path.join(REPO, 'webchat', 'chat.html'), 'utf8');
    assert.ok(html.includes('id="modelbar"'), 'no model bar for the picker to mount into');
    assert.ok(html.includes('ChatControls.init'), 'shared controls not initialised');
    const ctl = fs.readFileSync(path.join(REPO, 'scripts', 'webchat-controls.js'), 'utf8');
    assert.ok(ctl.includes("/model/select"), 'the shared picker does not call /model/select');
  });
  await t('no Keel portfolio endpoints leaked in', async () => {
    const src = fs.readFileSync(path.join(REPO, 'webchat', 'server.js'), 'utf8');
    for (const dead of ['/export', '/run-apply', '/run-reconcile', 'normalize-jira', 'WSJF']) assert.ok(!src.includes(dead), 'leaked: ' + dead);
  });

  console.log(`\nWEBCHAT SPINE: ${pass} passed, ${fail.length} failed`);
  server.close();
  if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
})();
