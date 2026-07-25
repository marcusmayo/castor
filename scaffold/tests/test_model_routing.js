const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const yaml = require(path.join(__dirname,'..','node_modules','js-yaml'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
fs.mkdirSync(path.join(tmp,'System'), { recursive: true });
fs.copyFileSync(path.join(__dirname,'..','System','model-routing.yaml'), path.join(tmp,'System','model-routing.yaml'));
process.env.AGENT_ROOT = tmp;
const mr = require(path.join(__dirname,'..','scripts','model-routing.js'));

let pass=0; const fail=[];
function t(n,fn){try{fn();pass++;console.log('  PASS  '+n);}catch(e){fail.push(n);console.log('  FAIL  '+n+' :: '+e.message);}}

console.log('\n--- pinned to Keel\'s three ---');
t('routine resolves to the sonnet alias (kimi-k3 lane)', () => assert.strictEqual(mr.resolve('routine'), 'claude-sonnet-4-5'));
t('triage resolves to the haiku alias (glm-5.2 lane)', () => assert.strictEqual(mr.resolve('triage'), 'claude-3-5-haiku-20241022'));
t('complex resolves to deepseek', () => assert.strictEqual(mr.resolve('complex'), 'deepseek-v4-pro'));
t('no tier -> default (routine)', () => assert.strictEqual(mr.resolve(), 'claude-sonnet-4-5'));
t('unknown tier errors', () => assert.throws(() => mr.resolve('frontier'), /unknown tier/));

console.log('\n--- gateway config generated from routing ---');
t('gateway maps all three names to OpenRouter slugs', () => {
  const cfg = yaml.load(mr.gatewayConfig());
  const byName = Object.fromEntries(cfg.model_list.map(m => [m.model_name, m.litellm_params.model]));
  assert.strictEqual(byName['claude-sonnet-4-5'], 'openrouter/moonshotai/kimi-k3');
  assert.strictEqual(byName['claude-3-5-haiku-20241022'], 'openrouter/z-ai/glm-5.2');
  assert.strictEqual(byName['deepseek-v4-pro'], 'openrouter/deepseek/deepseek-v4-pro');
});
t('gateway uses env key, not a literal', () => {
  const cfg = yaml.load(mr.gatewayConfig());
  for (const m of cfg.model_list) assert.strictEqual(m.litellm_params.api_key, 'os.environ/OPENROUTER_API_KEY');
});
t('gateway sets drop_params (matches Keel)', () => {
  const cfg = yaml.load(mr.gatewayConfig());
  assert.strictEqual(cfg.litellm_settings.drop_params, true);
});

console.log('\n--- change a model with one command ---');
t('set changes the slug and persists', () => {
  mr.set('complex', { slug: 'openrouter/anthropic/claude-3.7-sonnet' });
  // fresh read from disk proves persistence
  delete require.cache[require.resolve(path.join(__dirname,'..','scripts','model-routing.js'))];
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  const rows = Object.fromEntries(mr2.list().map(r => [r.tier, r.slug]));
  assert.strictEqual(rows.complex, 'openrouter/anthropic/claude-3.7-sonnet');
});
t('set can change model_name too', () => {
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  mr2.set('triage', { name: 'claude-3-5-haiku-latest', slug: 'openrouter/z-ai/glm-6' });
  const rows = Object.fromEntries(mr2.list().map(r => [r.tier, r.model_name]));
  assert.strictEqual(rows.triage, 'claude-3-5-haiku-latest');
});
t('change flows through to the generated gateway config', () => {
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  const cfg = yaml.load(mr2.gatewayConfig());
  const byName = Object.fromEntries(cfg.model_list.map(m => [m.model_name, m.litellm_params.model]));
  assert.strictEqual(byName['claude-3-5-haiku-latest'], 'openrouter/z-ai/glm-6', 'gateway did not follow the routing change');
});
t('set on unknown tier errors', () => {
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  assert.throws(() => mr2.set('nope', { slug: 'x' }), /unknown tier/);
});
t('file still parses and keeps comments header after set', () => {
  const raw = fs.readFileSync(path.join(tmp,'System','model-routing.yaml'), 'utf8');
  assert.ok(raw.startsWith('# Model routing'), 'header comment lost');
  assert.ok(yaml.load(raw).tiers, 'file no longer valid yaml');
});

console.log('\n--- CLI surface ---');
const { execFileSync } = require('child_process');
function cli(args){ try { return { code:0, out: execFileSync('node',[path.join(__dirname,'..','scripts','model-routing.js'),...args],{encoding:'utf8',env:{...process.env,AGENT_ROOT:tmp}}) }; } catch(e){ return { code:e.status, out:(e.stdout||'')+(e.stderr||'') }; } }
t('resolve CLI prints a bare model name', () => { const r=cli(['resolve','routine']); assert.strictEqual(r.code,0); assert.strictEqual(r.out.trim(),'claude-sonnet-4-5'); });
t('list CLI marks the default tier', () => { const r=cli(['list']); assert.ok(/routine\*/.test(r.out)); });
t('gateway-config CLI emits valid yaml', () => { const r=cli(['gateway-config']); assert.ok(yaml.load(r.out).model_list.length===3); });
t('unknown command exits non-zero', () => { assert.notStrictEqual(cli(['bogus']).code,0); });

console.log(`\nMODEL ROUTING: ${pass} passed, ${fail.length} failed`);
if (fail.length){ console.log('failed: '+fail.join(', ')); process.exit(1); }
