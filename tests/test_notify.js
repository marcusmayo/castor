const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname,'..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'notify-'));
fs.mkdirSync(path.join(tmp,'System'),{recursive:true});
fs.mkdirSync(path.join(tmp,'state'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'System','capabilities.yaml'), path.join(tmp,'System','capabilities.yaml'));
process.env.AGENT_ROOT = tmp;

const notify = require(path.join(ROOT,'scripts','notify.js'));

let pass=0; const fail=[];
function t(n,fn){return Promise.resolve().then(fn).then(()=>{pass++;console.log('  PASS  '+n);}).catch(e=>{fail.push(n);console.log('  FAIL  '+n+' :: '+e.message);});}

function setCaps(obj){ fs.writeFileSync(path.join(tmp,'state','capabilities.json'), JSON.stringify(obj)); }
function mockFetch(captured){ return async (url,opts)=>{ captured.push({url,body:JSON.parse(opts.body),headers:opts.headers}); return { ok:true, status:200 }; }; }
const secretsPresent = (name)=>({ 'telegram-bot-token':'BOT123','telegram-chat-id':'99','resend-api-key':'re_KEY','review-email-address':'me@example.com' }[name]||null);
const secretsMissing = ()=>null;

(async () => {
  console.log('\n--- capability gating ---');
  await t('nothing enabled -> clean no-op, no fetch', async () => {
    setCaps({});
    const cap=[]; const r=await notify.notify('test','msg',{fetch:mockFetch(cap),getSecret:secretsPresent});
    assert.strictEqual(r.sent.length,0);
    assert.strictEqual(cap.length,0,'no channel should be contacted');
    assert.ok(r.results.every(x=>x.status==='skipped'));
  });
  await t('telegram declined is skipped', async () => {
    setCaps({ telegram:{status:'declined'} });
    const cap=[]; const r=await notify.notify('t','m',{fetch:mockFetch(cap),getSecret:secretsPresent});
    assert.ok(r.results.find(x=>x.channel==='telegram').status==='skipped');
    assert.strictEqual(cap.length,0);
  });

  console.log('\n--- telegram send ---');
  await t('enabled telegram posts to sendMessage with chat_id + text', async () => {
    setCaps({ telegram:{status:'enabled'} });
    const cap=[]; const r=await notify.notify('digest','3 overdue',{fetch:mockFetch(cap),getSecret:secretsPresent});
    assert.ok(r.sent.includes('telegram'));
    assert.strictEqual(cap.length,1);
    assert.ok(cap[0].url.includes('/botBOT123/sendMessage'));
    assert.strictEqual(cap[0].body.chat_id,'99');
    assert.ok(cap[0].body.text.includes('3 overdue'));
  });
  await t('enabled but secret unresolved -> skipped, no send', async () => {
    setCaps({ telegram:{status:'enabled'} });
    const cap=[]; const r=await notify.notify('t','m',{fetch:mockFetch(cap),getSecret:secretsMissing});
    assert.ok(r.results.find(x=>x.channel==='telegram').reason==='secret unresolved');
    assert.strictEqual(cap.length,0);
  });

  console.log('\n--- resend send ---');
  await t('enabled resend posts to /emails, recipient = review address only', async () => {
    setCaps({ resend:{status:'enabled'} });
    const cap=[]; const r=await notify.notify('alert','disk 90%',{fetch:mockFetch(cap),getSecret:secretsPresent});
    assert.ok(r.sent.includes('resend'));
    assert.ok(cap[0].url.includes('api.resend.com/emails'));
    assert.deepStrictEqual(cap[0].body.to,['me@example.com']);
    assert.ok(cap[0].headers.Authorization==='Bearer re_KEY');
    assert.ok(cap[0].body.subject.includes('alert'));
  });
  await t('resend never sends to a non-review recipient', async () => {
    setCaps({ resend:{status:'enabled'} });
    const cap=[]; await notify.notify('t','m',{fetch:mockFetch(cap),getSecret:secretsPresent});
    assert.deepStrictEqual(cap[0].body.to,['me@example.com'],'recipient must be exactly the review address');
  });

  console.log('\n--- both enabled ---');
  await t('both channels enabled -> both sent', async () => {
    setCaps({ telegram:{status:'enabled'}, resend:{status:'enabled'} });
    const cap=[]; const r=await notify.notify('digest','summary',{fetch:mockFetch(cap),getSecret:secretsPresent});
    assert.deepStrictEqual(r.sent.sort(),['resend','telegram']);
    assert.strictEqual(cap.length,2);
  });

  console.log('\n--- never throws into caller ---');
  await t('a throwing fetch is caught, reported as failed, does not reject', async () => {
    setCaps({ telegram:{status:'enabled'} });
    const throwFetch = async ()=>{ throw new Error('network down'); };
    const r = await notify.notify('t','m',{fetch:throwFetch,getSecret:secretsPresent});
    assert.ok(r.results.find(x=>x.channel==='telegram').status==='failed');
    assert.strictEqual(r.sent.length,0);
  });

  console.log(`\nNOTIFY: ${pass} passed, ${fail.length} failed`);
  if (fail.length){ console.log('failed: '+fail.join(', ')); process.exit(1); }
})();
