const assert = require('assert');
const path = require('path'), fs = require('fs');
const speakeasy = require(path.join(__dirname,'..','webchat','node_modules','speakeasy'));

const ROOT = path.join(__dirname,'..','root');
process.env.AGENT_ROOT = ROOT;
process.env.TOTP_SECRET = speakeasy.generateSecret().base32;
process.env.SESSION_SECRET = 'test-secret';
process.env.CASTOR_BIND = '127.0.0.1';

const { server } = require(path.join(__dirname,'..','webchat','server.js'));

let pass=0; const fail=[];
function t(n,fn){return Promise.resolve().then(fn).then(()=>{pass++;console.log('  PASS  '+n);}).catch(e=>{fail.push(n);console.log('  FAIL  '+n+' :: '+e.message);});}

(async () => {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const goodToken = () => speakeasy.totp({ secret: process.env.TOTP_SECRET, encoding: 'base32' });

  console.log('\n--- unauthenticated surface ---');
  await t('liveness probe is 200 without auth', async () => { const r=await fetch(base+'/health/liveliness'); assert.strictEqual(r.status,200); });
  await t('login page serves', async () => { const r=await fetch(base+'/login'); assert.strictEqual(r.status,200); assert.ok((await r.text()).includes('Enter your 6-digit code')); });
  await t('chat page blocked without auth (401)', async () => { const r=await fetch(base+'/'); assert.strictEqual(r.status,401); });
  await t('/model blocked without auth', async () => { const r=await fetch(base+'/model'); assert.strictEqual(r.status,401); });

  console.log('\n--- TOTP auth ---');
  await t('wrong code rejected 401', async () => { const r=await fetch(base+'/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'000000'})}); assert.strictEqual(r.status,401); });
  let cookie;
  await t('correct code authenticates and sets cookie', async () => {
    const r=await fetch(base+'/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:goodToken()})});
    assert.strictEqual(r.status,200); cookie=r.headers.get('set-cookie').split(';')[0]; assert.ok(cookie.startsWith('connect.sid'));
  });

  console.log('\n--- authenticated surface ---');
  await t('chat page serves once authed', async () => { const r=await fetch(base+'/',{headers:{Cookie:cookie}}); assert.strictEqual(r.status,200); assert.ok((await r.text()).includes('Ask Castor')); });
  await t('/model returns routing, default = Keel routine alias', async () => {
    const r=await fetch(base+'/model',{headers:{Cookie:cookie}}); const d=await r.json();
    assert.strictEqual(d.ok,true); assert.strictEqual(d.tiers.find(x=>x.default).model_name,'claude-sonnet-4-5');
  });

  console.log('\n--- UI content: chips + discoverability ---');
  await t('all six Castor chips present', async () => {
    const html=fs.readFileSync(path.join(__dirname,'..','webchat','chat.html'),'utf8');
    for (const c of ['/morning','/pipeline','/compliance-report','/triage','/people','/draft']) assert.ok(html.includes("ins('"+c),'missing '+c);
  });
  await t('model-change command shown to operator', async () => {
    const html=fs.readFileSync(path.join(__dirname,'..','webchat','chat.html'),'utf8');
    assert.ok(html.includes('model-routing.js set'));
  });
  await t('no Keel portfolio endpoints leaked in', async () => {
    const src=fs.readFileSync(path.join(__dirname,'..','webchat','server.js'),'utf8');
    for (const dead of ['/export','/run-apply','/run-reconcile','normalize-jira','WSJF']) assert.ok(!src.includes(dead),'leaked: '+dead);
  });

  console.log(`\nWEBCHAT SPINE: ${pass} passed, ${fail.length} failed`);
  server.close();
  if (fail.length){ console.log('failed: '+fail.join(', ')); process.exit(1); }
})();
