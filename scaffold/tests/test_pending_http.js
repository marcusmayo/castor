const assert = require('assert');
const path = require('path'), crypto = require('crypto'), fs = require('fs');
const speakeasy = require(path.join(__dirname,'..','webchat','node_modules','speakeasy'));
const ROOT = path.join(__dirname,'..','root');
process.env.AGENT_ROOT = ROOT;
process.env.TOTP_SECRET = speakeasy.generateSecret().base32;
process.env.CASTOR_BIND='127.0.0.1';
const { server } = require(path.join(__dirname,'..','webchat','server.js'));
let pass=0; const fail=[];
function t(n,fn){return Promise.resolve().then(fn).then(()=>{pass++;console.log('  PASS  '+n);}).catch(e=>{fail.push(n);console.log('  FAIL  '+n+' :: '+e.message);});}
(async () => {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const tok=()=>speakeasy.totp({secret:process.env.TOTP_SECRET,encoding:'base32'});
  console.log('\n--- auth gate ---');
  await t('/pending blocked without auth', async()=>{assert.strictEqual((await fetch(base+'/pending')).status,401);});
  const vr=await fetch(base+'/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:tok()})});
  const cookie=vr.headers.get('set-cookie').split(';')[0];
  console.log('\n--- /pending listing ---');
  await t('groups returned; vision-pending item has sha256', async()=>{
    const d=await (await fetch(base+'/pending',{headers:{Cookie:cookie}})).json();
    assert.strictEqual(d.ok,true); assert.strictEqual(d.groups.ready.length,1); assert.strictEqual(d.groups.visionPending.length,1);
    assert.ok(d.groups.visionPending[0].sha256 && d.groups.visionPending[0].sha256.length===64);
  });
  console.log('\n--- /pending/image whitelist ---');
  await t('valid image 200', async()=>{assert.strictEqual((await fetch(base+'/pending/image/2026-07-25_d.png',{headers:{Cookie:cookie}})).status,200);});
  await t('non-image 400', async()=>{assert.strictEqual((await fetch(base+'/pending/image/2026-07-25_a.csv',{headers:{Cookie:cookie}})).status,400);});
  console.log('\n--- /pending/interpret route wiring (no network) ---');
  await t('matching hash, no vision key -> key error', async()=>{
    const sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'inbox','2026-07-25_d.png'))).digest('hex');
    delete process.env.VISION_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r=await (await fetch(base+'/pending/interpret',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({name:'2026-07-25_d.png',sha256:sha})})).json();
    assert.strictEqual(r.ok,false); assert.ok(/key/.test(r.error),'got: '+r.error);
  });
  await t('wrong hash blocked', async()=>{
    const r=await (await fetch(base+'/pending/interpret',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({name:'2026-07-25_d.png',sha256:'deadbeef'})})).json();
    assert.strictEqual(r.ok,false); assert.ok(/mismatch/.test(r.error));
  });
  await t('chat.html has pending panel + interpret', async()=>{
    const html=fs.readFileSync(path.join(__dirname,'..','webchat','chat.html'),'utf8');
    assert.ok(html.includes('togglePending')&&html.includes('/pending/interpret'));
  });
  console.log(`\nPENDING HTTP: ${pass} passed, ${fail.length} failed`);
  server.close();
  if (fail.length){console.log('failed: '+fail.join(', '));process.exit(1);}
})();
