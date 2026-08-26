const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const yaml = require(path.join(__dirname,'..','node_modules','js-yaml'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
fs.mkdirSync(path.join(tmp,'system'), { recursive: true });
fs.copyFileSync(path.join(__dirname,'..','system','model-routing.yaml'), path.join(tmp,'system','model-routing.yaml'));
process.env.AGENT_ROOT = tmp;
const mr = require(path.join(__dirname,'..','scripts','model-routing.js'));

let pass=0; const fail=[];
function t(n,fn){try{fn();pass++;console.log('  PASS  '+n);}catch(e){fail.push(n);console.log('  FAIL  '+n+' :: '+e.message);}}

// Read the routing, do not mirror it. These assertions used to pin three literal model
// names; the tiers were later re-pointed and five more were added, and the test stayed
// wrong for months because nothing ran it. What is worth pinning is the MECHANISM --
// every declared tier resolves to the model_name IT declares, the default is the tier
// named by default_tier, and an undeclared tier is refused. The values are the agent's.
const ROUTING = yaml.load(fs.readFileSync(path.join(__dirname,'..','system','model-routing.yaml'),'utf8'));
const TIERS = ROUTING.tiers;
const TIER_NAMES = Object.keys(TIERS);

console.log('\n--- tier resolution, read from this agent\'s own routing ---');
t('every declared tier resolves to the model_name it declares', () => {
  assert.ok(TIER_NAMES.length >= 1, 'model-routing.yaml declares no tiers');
  for (const tier of TIER_NAMES) {
    assert.strictEqual(mr.resolve(tier), TIERS[tier].model_name, 'tier ' + tier);
  }
});
t('no tier resolves to the tier named by default_tier', () => {
  const d = ROUTING.default_tier || 'routine';
  assert.ok(TIERS[d], 'default_tier ' + d + ' is not a declared tier');
  assert.strictEqual(mr.resolve(), TIERS[d].model_name);
});
t('unknown tier errors', () => assert.throws(() => mr.resolve('frontier'), /unknown tier/));

console.log('\n--- gateway config generated from routing ---');
t('gateway maps every declared tier to the slug that tier declares', () => {
  const cfg = yaml.load(mr.gatewayConfig());
  const byName = Object.fromEntries(cfg.model_list.map(m => [m.model_name, m.litellm_params.model]));
  for (const tier of TIER_NAMES) {
    assert.strictEqual(byName[TIERS[tier].model_name], TIERS[tier].openrouter_slug, 'tier ' + tier);
  }
});
t('one deployment per model_name -- a cooled-down slug cannot take the others down', () => {
  const names = yaml.load(mr.gatewayConfig()).model_list.map(m => m.model_name);
  assert.strictEqual(new Set(names).size, names.length, 'a duplicate model_name would pool deployments');
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
t('set writes the persistent state copy, not the image default', () => {
  // after the sets above, the state copy exists and the image default is untouched
  assert.ok(fs.existsSync(path.join(tmp,'state','model-routing.yaml')), 'state copy not written');
  const stateRaw = fs.readFileSync(path.join(tmp,'state','model-routing.yaml'), 'utf8');
  assert.ok(stateRaw.startsWith('# Model routing'), 'header comment lost in state copy');
  assert.ok(yaml.load(stateRaw).tiers, 'state copy no longer valid yaml');
  const defaultRaw = fs.readFileSync(path.join(tmp,'system','model-routing.yaml'), 'utf8');
  assert.strictEqual(yaml.load(defaultRaw).tiers.complex.openrouter_slug, TIERS.complex.openrouter_slug,
    'image default must be untouched by set');
});
t('reads prefer the state copy once it exists', () => {
  delete require.cache[require.resolve(path.join(__dirname,'..','scripts','model-routing.js'))];
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  // complex was set to the 3.7 slug earlier; the state copy carries it
  assert.strictEqual(mr2.list().find(r=>r.tier==='complex').slug, 'openrouter/anthropic/claude-3.7-sonnet');
});

console.log('\n--- vision model (changeable like text tiers) ---');
t('vision resolves to the default direct-Anthropic model', () => {
  const v = mr.resolveVision();
  assert.strictEqual(v.model, 'claude-sonnet-4-6');
  assert.ok(v.api_url.includes('api.anthropic.com'));
});
t('set-vision changes the model and persists', () => {
  mr.setVision({ model: 'claude-opus-4-8' });
  delete require.cache[require.resolve(path.join(__dirname,'..','scripts','model-routing.js'))];
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  assert.strictEqual(mr2.resolveVision().model, 'claude-opus-4-8');
});
t('set-vision can change the endpoint too', () => {
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  mr2.setVision({ url: 'https://api.anthropic.com/v1/messages?beta=1' });
  assert.ok(mr2.resolveVision().api_url.includes('beta=1'));
});
t('vision change does not disturb the text tiers', () => {
  const mr2 = require(path.join(__dirname,'..','scripts','model-routing.js'));
  // routine has not been touched by any set above, so it must still read as shipped
  assert.strictEqual(mr2.resolve('routine'), TIERS.routine.model_name);
});

console.log('\n--- CLI surface ---');
const { execFileSync } = require('child_process');
function cli(args){ try { return { code:0, out: execFileSync('node',[path.join(__dirname,'..','scripts','model-routing.js'),...args],{encoding:'utf8',env:{...process.env,AGENT_ROOT:tmp}}) }; } catch(e){ return { code:e.status, out:(e.stdout||'')+(e.stderr||'') }; } }
t('resolve CLI prints a bare model name', () => { const r=cli(['resolve','routine']); assert.strictEqual(r.code,0); assert.strictEqual(r.out.trim(), TIERS.routine.model_name); });
t('list CLI marks the default tier', () => { const r=cli(['list']); assert.ok(/routine\*/.test(r.out)); });
t('gateway-config CLI emits valid yaml, one entry per declared tier', () => { const r=cli(['gateway-config']); assert.strictEqual(yaml.load(r.out).model_list.length, TIER_NAMES.length); });
t('vision CLI prints the current vision model', () => { const r=cli(['vision']); assert.ok(/vision model:/.test(r.out)); });
t('set-vision CLI persists', () => { const r=cli(['set-vision','--model','claude-3-5-haiku-20241022']); assert.strictEqual(r.code,0); assert.ok(cli(['vision']).out.includes('claude-3-5-haiku-20241022')); });
t('unknown command exits non-zero', () => { assert.notStrictEqual(cli(['bogus']).code,0); });

console.log(`\nMODEL ROUTING: ${pass} passed, ${fail.length} failed`);
if (fail.length){ console.log('failed: '+fail.join(', ')); process.exit(1); }
