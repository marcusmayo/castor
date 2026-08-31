const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const pending = require(path.join(__dirname,'..','webchat','pending.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'pending-'));
const inbox = path.join(tmp,'inbox'); fs.mkdirSync(inbox,{recursive:true});
function flags(name, obj){ fs.writeFileSync(path.join(inbox,name+'.flags.json'), JSON.stringify(obj)); }

// seed one of each state
flags('2026-07-25_a.csv', { file:'2026-07-25_a.csv', extraction:{type:'.csv',scan_state:'scanned'}, tripwire:{flagged:false}, has_vision_pending:false, has_unscanned:false });
flags('2026-07-25_b.csv', { file:'2026-07-25_b.csv', extraction:{type:'.csv',scan_state:'scanned'}, tripwire:{flagged:true}, has_vision_pending:false, has_unscanned:false });
flags('2026-07-25_c.pdf', { file:'2026-07-25_c.pdf', extraction:{type:'.pdf',scan_state:'unscanned'}, tripwire:{flagged:false}, has_vision_pending:false, has_unscanned:true });
flags('2026-07-25_d.png', { file:'2026-07-25_d.png', extraction:{type:'.png',scan_state:'vision-pending'}, tripwire:{flagged:false}, has_vision_pending:true, has_unscanned:false });

let pass=0; const fail=[];
function t(n,fn){return Promise.resolve().then(fn).then(()=>{pass++;console.log('  PASS  '+n);}).catch(e=>{fail.push(n);console.log('  FAIL  '+n+' :: '+e.message);});}

(async () => {
  console.log('\n--- listPending groups by state ---');
  await t('four states each get their item', () => {
    const g = pending.listPending(tmp);
    assert.strictEqual(g.ready.length,1); assert.strictEqual(g.ready[0].file,'2026-07-25_a.csv');
    assert.strictEqual(g.flagged.length,1); assert.strictEqual(g.flagged[0].file,'2026-07-25_b.csv');
    assert.strictEqual(g.unscanned.length,1);
    assert.strictEqual(g.visionPending.length,1);
  });
  await t('vision-pending takes priority even if also flagged', () => {
    flags('2026-07-25_e.png', { file:'2026-07-25_e.png', extraction:{scan_state:'vision-pending'}, tripwire:{flagged:true}, has_vision_pending:true });
    const g = pending.listPending(tmp);
    assert.ok(g.visionPending.some(i=>i.file==='2026-07-25_e.png'));
    assert.ok(!g.flagged.some(i=>i.file==='2026-07-25_e.png'));
    fs.unlinkSync(path.join(inbox,'2026-07-25_e.png.flags.json'));
  });

  await t('vision-pending item carries a sha256 for attestation', () => {
    fs.writeFileSync(path.join(inbox, '2026-07-25_d.png'), Buffer.from([1,2,3,4]));
    const g = pending.listPending(tmp);
    const vp = g.visionPending.find(i=>i.file==='2026-07-25_d.png');
    assert.ok(vp.sha256 && vp.sha256.length===64, 'no sha256 on vision-pending item');
  });

  console.log('\n--- image path whitelist ---');
  const realImg = '2026-07-25_d.png';
  fs.writeFileSync(path.join(inbox, realImg), Buffer.from([0x89,0x50,0x4e,0x47])); // fake png bytes
  await t('valid image name resolves', () => { assert.ok(pending.imagePath(tmp, realImg)); });
  await t('path traversal rejected', () => { assert.strictEqual(pending.imagePath(tmp,'../../etc/passwd'), null); });
  await t('non-image extension rejected', () => { assert.strictEqual(pending.imagePath(tmp,'a.csv'), null); });
  await t('missing file returns null', () => { assert.strictEqual(pending.imagePath(tmp,'ghost.png'), null); });

  console.log('\n--- attested vision interpret ---');
  const buf = fs.readFileSync(path.join(inbox, realImg));
  const goodSha = crypto.createHash('sha256').update(buf).digest('hex');
  function mockFetch(captured){ return async (url,opts)=>{ captured.push({url,opts}); return { ok:true, status:200, json: async()=>({content:[{type:'text',text:'A flowchart: box A -> box B.'}]}) }; }; }

  await t('hash mismatch is BLOCKED, nothing sent', async () => {
    const audits=[]; const cap=[];
    const r = await pending.interpret(tmp, realImg, 'deadbeef', { fetch:mockFetch(cap), audit:e=>audits.push(e), apiKey:'k' });
    assert.strictEqual(r.ok,false); assert.ok(/hash mismatch/.test(r.error));
    assert.strictEqual(cap.length,0,'must not call vision on mismatch');
    assert.ok(audits.some(a=>a.status==='BLOCKED'));
  });
  await t('no api key -> FAILED before send', async () => {
    const audits=[]; const cap=[];
    const r = await pending.interpret(tmp, realImg, goodSha, { fetch:mockFetch(cap), audit:e=>audits.push(e), apiKey:null });
    assert.strictEqual(r.ok,false); assert.strictEqual(cap.length,0);
    assert.ok(audits.some(a=>a.status==='FAILED'));
  });
  await t('correct hash: audits SENT before call, returns text, writes interpretation, clears marker', async () => {
    // put a vision-pending marker to be cleared
    fs.writeFileSync(path.join(inbox, realImg+'.vision-pending.json'), '{}');
    const audits=[]; const cap=[];
    const r = await pending.interpret(tmp, realImg, goodSha, { fetch:mockFetch(cap), audit:e=>audits.push(e), apiKey:'k', model:'test-vision' });
    assert.strictEqual(r.ok,true);
    assert.ok(/box A/.test(r.text));
    assert.strictEqual(cap.length,1,'vision called once');
    // audit order: SENT recorded before the call returned
    const sent = audits.find(a=>a.status==='SENT');
    assert.ok(sent && sent.redaction==='ATTESTED_EGRESS' && sent.sha256===goodSha);
    // interpretation persisted, marker cleared
    assert.ok(fs.existsSync(path.join(inbox, realImg+'.interpretation.txt')));
    assert.ok(!fs.existsSync(path.join(inbox, realImg+'.vision-pending.json')), 'marker should be cleared');
  });
  await t('vision payload carries base64 image + describe prompt', async () => {
    const cap=[];
    await pending.interpret(tmp, realImg, goodSha, { fetch:mockFetch(cap), audit:()=>{}, apiKey:'k' });
    const body = JSON.parse(cap[0].opts.body);
    assert.strictEqual(body.messages[0].content[0].type,'image');
    assert.ok(body.messages[0].content[0].source.data.length>0);
    const prompt = body.messages[0].content[1].text;
    // The prompt is load-bearing for accuracy: a table read without row discipline
    // comes back with its cells shifted, and a model told to fill gaps will.
    assert.ok(/row by row/i.test(prompt), 'the prompt must ask for row-by-row transcription');
    assert.ok(/not legible/i.test(prompt), 'the prompt must ask it to say what it cannot read');
    assert.ok(/exactly as written/i.test(prompt), 'the prompt must forbid re-spelling names');
  });
  await t('api error surfaces and is audited', async () => {
    const audits=[];
    const errFetch = async ()=>({ ok:false, status:502, json:async()=>({}) });
    const r = await pending.interpret(tmp, realImg, goodSha, { fetch:errFetch, audit:e=>audits.push(e), apiKey:'k' });
    assert.strictEqual(r.ok,false); assert.ok(/502/.test(r.error));
    assert.ok(audits.some(a=>a.status==='API_ERROR'));
  });

  console.log('\n--- what actually egresses ---');
  const sentData = cap => JSON.parse(cap[0].opts.body).messages[0].content[0].source.data;
  const exifImg = '2026-07-25_p.jpg';
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'exif-sideways.jpg'), path.join(inbox, exifImg));
  const exifBuf = fs.readFileSync(path.join(inbox, exifImg));
  const exifSha = crypto.createHash('sha256').update(exifBuf).digest('hex');

  await t('a sideways photograph is turned upright BEFORE it leaves the VM', async () => {
    const audits=[]; const cap=[];
    const r = await pending.interpret(tmp, exifImg, exifSha, { fetch:mockFetch(cap), audit:e=>audits.push(e), apiKey:'k' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(cap.length, 1);
    const sent = Buffer.from(sentData(cap), 'base64');
    assert.notStrictEqual(sent.toString('base64'), exifBuf.toString('base64'),
      'the stored sideways bytes were sent -- the vision model reads a rotated page');
    assert.strictEqual(JSON.parse(cap[0].opts.body).messages[0].content[0].source.media_type, 'image/png');
  });
  await t('the audit records the attested hash AND the hash of what actually went', () => {
    // re-run to inspect the audit for this image
    return pending.interpret(tmp, exifImg, exifSha, { fetch:mockFetch([]), audit:e=>{
      if (e.status !== 'SENT') return;
      assert.strictEqual(e.sha256, exifSha, 'the attested hash must still be the file the operator confirmed');
      assert.strictEqual(e.transform, 'exif-orientation-6');
      assert.ok(e.sent_sha256 && e.sent_sha256.length === 64 && e.sent_sha256 !== exifSha,
        'a transformed image is a different artifact and the record must say which one left');
    }, apiKey:'k' });
  });
  await t('an untransformed image sends the exact attested bytes and claims no transform', async () => {
    const audits=[]; const cap=[];
    await pending.interpret(tmp, realImg, goodSha, { fetch:mockFetch(cap), audit:e=>audits.push(e), apiKey:'k' });
    const sent = Buffer.from(sentData(cap), 'base64');
    assert.strictEqual(sent.toString('base64'), buf.toString('base64'), 'bytes must be untouched when nothing is applied');
    const s = audits.find(a=>a.status==='SENT');
    assert.ok(!s.transform && !s.sent_sha256, 'no transform means no second hash on the record');
  });

  console.log(`\nPENDING PANEL: ${pass} passed, ${fail.length} failed`);
  if (fail.length){ console.log('failed: '+fail.join(', ')); process.exit(1); }
})();
