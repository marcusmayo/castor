const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
process.env.AGENT_ROOT = tmp;
process.env.INTAKE_STABILITY_MS = '5';

fs.copyFileSync(path.join(ROOT, 'gate', 'never-egress.example.json'), path.join(ROOT, 'gate', 'never-egress.json'));

const intake = require(path.join(ROOT, 'scripts', 'intake.js'));
const audit = require(path.join(ROOT, 'gate', 'audit.js'));

let pass = 0; const fail = [];
function t(n, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  PASS  ' + n); }).catch(e => { fail.push(n); console.log('  FAIL  ' + n + ' :: ' + e.message); }); }

const drop = f => path.join(intake.DROP, f);
function putFile(name, srcAbs) { fs.mkdirSync(intake.DROP, { recursive: true }); fs.copyFileSync(srcAbs, drop(name)); }
function putText(name, content) { fs.mkdirSync(intake.DROP, { recursive: true }); fs.writeFileSync(drop(name), content); }
const inboxFiles = () => fs.readdirSync(intake.INBOX).filter(f => fs.statSync(path.join(intake.INBOX, f)).isFile());
const admittedFiles = () => inboxFiles().filter(f => !f.startsWith('.') && !f.endsWith('.flags.json') && !f.endsWith('.vision-pending.json'));
const quar = () => fs.readdirSync(intake.QUARANTINE).filter(f => !f.endsWith('.reason.txt'));
function flagsFor(destSuffix) { const f = inboxFiles().find(x => x.endsWith(destSuffix + '.flags.json')); return f ? JSON.parse(fs.readFileSync(path.join(intake.INBOX, f), 'utf8')) : null; }
function silent(fn) { const o = console.log; console.log = () => {}; let r;
  // A synchronous throw used to leave console.log muted for the rest of the run,
  // so a later failure printed nothing and the suite ended with no summary line.
  try { r = fn(); } catch (e) { console.log = o; throw e; }
  if (r && r.then) return r.finally(() => { console.log = o; }); console.log = o; return r; }
const run = () => silent(() => intake.runOnce());

(async () => {
  console.log('\n--- admits every supported type with correct scan state ---');
  await t('all supported types admitted; scan states correct', async () => {
    putText('a.csv', 'id,title\n1,Roadmap\n');
    putText('b.md', '# Notes\ngreen\n');
    putFile('c.xlsx', path.join(FIX, 'backlog.xlsx'));
    putFile('text.pdf', path.join(FIX, 'report.pdf'));
    putFile('scan.pdf', path.join(FIX, 'scanned.pdf'));
    putFile('s.png', path.join(FIX, 'status.png'));
    putFile('diag.png', path.join(FIX, 'diagram.png'));
    putFile('e.docx', path.join(FIX, 'brief.docx'));
    const r = await run();
    assert.strictEqual(r.length, 8, JSON.stringify(r.map(x => [x.file, x.outcome])));
    assert.ok(r.every(x => x.outcome === 'admitted'), 'all should admit');
    assert.strictEqual(flagsFor('text.pdf').extraction.scan_state, 'scanned');
    assert.strictEqual(flagsFor('scan.pdf').extraction.scan_state, 'unscanned');
    assert.strictEqual(flagsFor('scan.pdf').has_unscanned, true);
    assert.strictEqual(flagsFor('s.png').extraction.scan_state, 'scanned');
    assert.strictEqual(flagsFor('diag.png').extraction.scan_state, 'vision-pending');
    assert.strictEqual(flagsFor('diag.png').has_vision_pending, true);
    assert.strictEqual(flagsFor('c.xlsx').extraction.extractor, 'sheetjs');
    assert.strictEqual(flagsFor('e.docx').extraction.scan_state, 'scanned');
  });
  await t('diagram image writes a vision-pending marker', () => {
    const marker = inboxFiles().find(f => f.endsWith('diag.png.vision-pending.json'));
    assert.ok(marker, 'no vision-pending marker written');
    const m = JSON.parse(fs.readFileSync(path.join(intake.INBOX, marker), 'utf8'));
    assert.ok(m.targets.includes('<self>'));
    assert.ok(/attested vision/i.test(m.instructions));
  });

  console.log('\n--- OCR orientation and legibility: character count is not content ---');
  const textOf = suffix => {
    const fl = flagsFor(suffix);
    assert.ok(fl && fl.extraction.text_file, suffix + ': no extraction was persisted');
    return fs.readFileSync(path.join(intake.INBOX, fl.extraction.text_file), 'utf8');
  };
  await t('a photograph is read the way the camera says it is oriented', async () => {
    putFile('phone.jpg', path.join(FIX, 'exif-sideways.jpg'));
    putFile('rot.png',   path.join(FIX, 'rotated.png'));
    putFile('bad.png',   path.join(FIX, 'unreadable.png'));
    const r = await run();
    assert.strictEqual(r.length, 3, JSON.stringify(r.map(x => [x.file, x.outcome])));
    const lg = flagsFor('phone.jpg').extraction.legibility;
    assert.strictEqual(flagsFor('phone.jpg').extraction.scan_state, 'scanned');
    assert.strictEqual(lg.transform, 'exif-orientation-6', 'the EXIF tag was not applied');
    assert.ok(!lg.orientations_tried,
      'the tag is a statement, not a hint -- believing it must cost no orientation search');
    assert.ok(/Outline of Coverage/i.test(textOf('phone.jpg')),
      'the sideways reading was kept -- the extraction is not the upright one');
  });
  await t('with no EXIF tag the orientation is searched, not guessed at once', () => {
    const fl = flagsFor('rot.png');
    assert.strictEqual(fl.extraction.scan_state, 'scanned');
    assert.ok(/^rotate-\d+$/.test(fl.extraction.legibility.transform),
      'expected a searched rotation, got ' + JSON.stringify(fl.extraction.legibility.transform));
    assert.ok(fl.extraction.legibility.orientations_tried >= 2);
    assert.ok(/Outline of Coverage/i.test(textOf('rot.png')));
  });
  await t('plenty of characters with no words is refused, not admitted as content', () => {
    const fl = flagsFor('bad.png');
    const extract = require(path.join(ROOT, 'scripts', 'extract.js'));
    assert.strictEqual(fl.extraction.scan_state, 'vision-pending');
    assert.strictEqual(fl.has_vision_pending, true);
    // The point of the test: this file is NOT caught by the old length gate,
    // and no orientation rescues it -- it is unreadable, not misoriented.
    assert.ok(fl.extraction.chars > extract.OCR_MIN_ALNUM * 5,
      'fixture no longer has abundant characters -- it would be caught by the length gate and prove nothing');
    assert.strictEqual(fl.extraction.legibility.orientations_tried, 4, 'every orientation must be tried before refusing');
    assert.ok(fl.extraction.legibility.ratio < extract.OCR_MIN_WORD_RATIO);
    assert.ok(/read as words/i.test(fl.extraction.note), 'the reason must name legibility, not length');
  });
  await t('a legible image is read once -- the search costs nothing on the good path', () => {
    const fl = flagsFor('s.png');
    assert.strictEqual(fl.extraction.scan_state, 'scanned');
    assert.ok(!fl.extraction.legibility.transform, 'an upright image must not be transformed');
    assert.ok(!fl.extraction.legibility.orientations_tried, 'a readable image must not pay for extra OCR passes');
  });
  await t('every image sidecar records the legibility measure', () => {
    const imgs = inboxFiles().filter(f => f.endsWith('.flags.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(intake.INBOX, f), 'utf8')))
      .filter(fl => fl.extraction && fl.extraction.extractor === 'tesseract');
    assert.ok(imgs.length >= 5, 'expected at least five image items, saw ' + imgs.length);
    for (const fl of imgs) {
      const lg = fl.extraction.legibility;
      assert.ok(lg && typeof lg.tokens === 'number' && typeof lg.words === 'number' && typeof lg.ratio === 'number',
        fl.file + ': scanned no longer has to mean legible, so the measure must be on the record');
    }
  });


  await t('a table keeps its rows -- a label and its own cell land on one line', async () => {
    putFile('grid.png', path.join(FIX, 'table.png'));
    const r = await run();
    assert.strictEqual(r.length, 1, JSON.stringify(r.map(x => [x.file, x.outcome])));
    const fl = flagsFor('grid.png');
    assert.strictEqual(fl.extraction.scan_state, 'scanned');
    assert.strictEqual(fl.extraction.legibility.mode, 'psm6-grid',
      'the linear read wins on word count while dissolving every row -- structure has to decide');
    assert.ok(fl.extraction.legibility.columns >= 2, 'the column signal did not see a table');
    const text = fs.readFileSync(path.join(intake.INBOX, fl.extraction.text_file), 'utf8');
    assert.ok(text.split('\n').some(l => /AMS/.test(l) && /Agent\s+License/.test(l)),
      'the label and its own cell are on different lines -- the association a linear read destroys');
    assert.ok(!/^Acronyms\nAMS\.?\n\nNESSY/m.test(text),
      'the extraction is column-major -- every label first, then every cell, which is the failure mode');
  });
  await t('a cell whose first line sits ABOVE its label still belongs to that label', () => {
    const text = fs.readFileSync(path.join(intake.INBOX, flagsFor('grid.png').extraction.text_file), 'utf8');
    const lines = text.split('\n');
    const at = re => lines.findIndex(l => re.test(l));
    // In the image "Eligibility check" is drawn above the CPS label, so reading
    // top to bottom attaches it to the row before. That is the one-row shift.
    const cps = at(/^cps\b/i), elig = at(/Eligibility check/), cust = at(/Customer\s+attestation/), nessy = at(/^NESSY\b/);
    assert.ok(cps >= 0 && elig >= 0 && cust >= 0 && nessy >= 0, 'fixture rows not found: ' + JSON.stringify({ cps, elig, cust, nessy }));
    assert.ok(elig > cps, 'Eligibility check landed on the row above CPS -- the shift is back');
    assert.ok(cust > nessy, 'Customer attestation landed on the row above NESSY');
    assert.strictEqual(flagsFor('grid.png').extraction.legibility.rows_bound, true);
  });
  await t('laying garbage out in columns must not make it legible', () => {
    // Padding a garbled read into a grid drops its token count and RAISES its word
    // ratio -- 0.588 linear became 0.692 gridded, which cleared the floor. The
    // floor is judged on the linear reading for exactly this reason.
    const fl = flagsFor('bad.png');
    const extract = require(path.join(ROOT, 'scripts', 'extract.js'));
    assert.strictEqual(fl.extraction.scan_state, 'vision-pending',
      'the grid reading promoted an unreadable image past the floor');
    assert.ok(fl.extraction.legibility.ratio < extract.OCR_MIN_WORD_RATIO,
      'the recorded ratio is the gridded one, not the reading the floor judged');
  });

  await t('a change that only reorders the text is still a change', async () => {
    // Binding a cell to its own row leaves the character count identical. A
    // detector that compares only length reports "unchanged" and the improved
    // reading never reaches the store -- which is exactly what happened.
    const fl = flagsFor('grid.png');
    const abs = path.join(intake.INBOX, fl.extraction.text_file);
    const real = fs.readFileSync(abs, 'utf8');
    const lines = real.split('\n');
    assert.ok(lines.length > 3, 'fixture extraction is too short to reorder');
    const shuffled = [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n');
    assert.strictEqual(shuffled.length, real.length, 'the reorder must not change the length');
    fs.writeFileSync(abs, shuffled);

    const plan = await silent(() => intake.backfill(false));
    const mine = plan.find(x => x.file === fl.file);
    assert.ok(mine, 'the item was not seen');
    assert.strictEqual(mine.outcome, 'would-rewrite',
      'a reordered extraction was reported unchanged -- length is not content');

    await silent(() => intake.backfill(true));
    assert.strictEqual(fs.readFileSync(abs, 'utf8'), real, 'the re-read did not restore the correct order');
  });

  await t('the label column comes from where lines START, not from the widest line', () => {
    // Deriving the boundary from the widest first cluster on any line put it past
    // the notes column: one full-width chat line and every line counted as a
    // label, so nothing was ever a continuation and almost nothing rebound. The
    // fixture's header line spans the width for exactly this reason.
    const fl = flagsFor('grid.png');
    assert.strictEqual(fl.extraction.legibility.rows_bound, true,
      'no rows were bound -- the label column boundary swallowed the notes column');
    const lines = fs.readFileSync(path.join(intake.INBOX, fl.extraction.text_file), 'utf8').split('\n');
    const startOf = re => { const l = lines.find(x => re.test(x)); return l === undefined ? -1 : l.search(/\S/); };
    const label = startOf(/^\s*NESSY/), note = startOf(/Customer\s+attestation/);
    assert.ok(label >= 0 && note >= 0, 'fixture rows not found');
    assert.ok(note > label + 8,
      'a label and a continuation start at nearly the same column -- the split found no channel');
  });

  console.log('\n--- backfill: an already-admitted item can be re-read ---');
  let staleDest = null, staleAdmittedAt = null, ledgerBefore = null, archiveBefore = null;
  await t('setup: degrade a record to what the pre-orientation pipeline left behind', () => {
    // Deliberately NOT a fresh drop: identical bytes bounce off the ledger as a
    // duplicate, which is the whole reason this pass has to exist.
    const fl = flagsFor('phone.jpg');
    assert.ok(fl, 'no admitted item to degrade');
    staleDest = fl.file; staleAdmittedAt = fl.admitted_at;
    try { fs.unlinkSync(path.join(intake.INBOX, fl.extraction.text_file)); } catch (_) {}
    delete fl.extraction.text_file; delete fl.extraction.text_chars;
    fl.extraction.scan_state = 'vision-pending';
    fl.extraction.chars = 704;
    fl.extraction.legibility = { tokens: 125, words: 73, ratio: 0.584 };
    fl.extraction.note = 'OCR recovered 468 characters but only 73 of 125 tokens read as words';
    fl.has_vision_pending = true;
    fs.writeFileSync(path.join(intake.INBOX, staleDest + '.flags.json'), JSON.stringify(fl, null, 2) + '\n');
    fs.writeFileSync(path.join(intake.INBOX, staleDest + '.vision-pending.json'),
      JSON.stringify({ file: staleDest, targets: ['<self>'], reason: 'stale' }, null, 2) + '\n');
    ledgerBefore = fs.readFileSync(intake.LEDGER, 'utf8');
    archiveBefore = fs.readdirSync(intake.ARCHIVE).sort().join('|');
  });
  await t('the plan writes nothing', async () => {
    const r = await silent(() => intake.backfill(false));
    const mine = r.find(x => x.file === staleDest);
    assert.ok(mine, 'the stale item was not seen by the plan');
    assert.strictEqual(mine.outcome, 'would-rewrite');
    const fl = JSON.parse(fs.readFileSync(path.join(intake.INBOX, staleDest + '.flags.json'), 'utf8'));
    assert.strictEqual(fl.extraction.scan_state, 'vision-pending', 'the plan rewrote the sidecar');
    assert.ok(!fl.extraction.text_file, 'the plan wrote an extraction');
    assert.ok(!fl.backfilled_at, 'the plan stamped the record');
  });
  await t('--go re-reads it, and the record says it was re-read', async () => {
    await silent(() => intake.backfill(true));
    const fl = JSON.parse(fs.readFileSync(path.join(intake.INBOX, staleDest + '.flags.json'), 'utf8'));
    assert.strictEqual(fl.extraction.scan_state, 'scanned');
    assert.strictEqual(fl.extraction.legibility.transform, 'exif-orientation-6');
    assert.strictEqual(fl.admitted_at, staleAdmittedAt, 'arrival time must survive a re-read');
    assert.ok(fl.backfilled_at, 'a re-read must be stamped, not passed off as the original reading');
    assert.strictEqual(fl.backfill.was.scan_state, 'vision-pending', 'the record must keep what it said before');
    assert.ok(fl.extraction.text_file, 'no extraction was produced');
    assert.ok(/Outline of Coverage/i.test(fs.readFileSync(path.join(intake.INBOX, fl.extraction.text_file), 'utf8')));
  });
  await t('the item leaves the vision queue when it no longer needs it', () => {
    assert.ok(!fs.existsSync(path.join(intake.INBOX, staleDest + '.vision-pending.json')),
      'the marker survived a re-read that made the image readable');
  });
  await t('the ledger and the archive are not touched', () => {
    assert.strictEqual(fs.readFileSync(intake.LEDGER, 'utf8'), ledgerBefore,
      'backfill must never edit the ledger -- that is the thing it exists to avoid');
    assert.strictEqual(fs.readdirSync(intake.ARCHIVE).sort().join('|'), archiveBefore, 'archive was modified');
  });
  await t('the re-read text is scanned by the tripwire, not carried over', () => {
    const fl = JSON.parse(fs.readFileSync(path.join(intake.INBOX, staleDest + '.flags.json'), 'utf8'));
    assert.strictEqual(fl.tripwire.scanned, true,
      'text recovered for the first time has never been through the tripwire and must be');
  });
  await t('a second backfill is a no-op', async () => {
    const r = await silent(() => intake.backfill(true));
    assert.strictEqual(r.find(x => x.file === staleDest).outcome, 'unchanged');
  });
  await t('a CLEARED item is out of reach by default and reachable with --archive', async () => {
    // queue-clear moves the file AND its sidecar into archive, so a cleared item
    // is self-contained there. Reproduce that, then degrade its record.
    const fl = flagsFor('rot.png');
    const dest = fl.file;
    for (const n of [dest, dest + '.flags.json']) fs.renameSync(path.join(intake.INBOX, n), path.join(intake.ARCHIVE, n));
    const moved = JSON.parse(fs.readFileSync(path.join(intake.ARCHIVE, dest + '.flags.json'), 'utf8'));
    delete moved.extraction.text_file; delete moved.extraction.text_chars;
    moved.extraction.scan_state = 'vision-pending'; moved.extraction.chars = 1;
    fs.writeFileSync(path.join(intake.ARCHIVE, dest + '.flags.json'), JSON.stringify(moved, null, 2) + '\n');

    const plain = await silent(() => intake.backfill(false));
    assert.ok(!plain.some(x => x.file === dest && /rewrite/.test(x.outcome)),
      'an archived item must not be re-read without --archive');
    // Clearing moved the item but left its extraction behind, which is the thing
    // that put a stale copy of an item's text in the queue's own .text.
    assert.ok(plain.some(x => x.outcome === 'would-prune' && x.file.includes(dest)),
      'the stranded extraction was not seen');

    const withArchive = await silent(() => intake.backfill(true, { archive: true }));
    const hit = withArchive.find(x => x.file === 'archive/' + dest);
    assert.ok(hit, 'the cleared item was not reached with --archive');
    assert.strictEqual(hit.outcome, 'rewritten');

    const after = JSON.parse(fs.readFileSync(path.join(intake.ARCHIVE, dest + '.flags.json'), 'utf8'));
    assert.strictEqual(after.extraction.scan_state, 'scanned');
    assert.ok(after.extraction.text_file, 'no extraction was written beside the archived item');
    assert.ok(fs.existsSync(path.join(intake.ARCHIVE, after.extraction.text_file)),
      'the extraction must live beside its sidecar, not back in the review queue');
    assert.ok(/Outline of Coverage/i.test(fs.readFileSync(path.join(intake.ARCHIVE, after.extraction.text_file), 'utf8')));
  });
  await t('re-reading a cleared item does not put it back in the queue', () => {
    assert.ok(!admittedFiles().some(f => /rot\.png$/.test(f)),
      'a cleared item reappeared in the review queue -- the operator cleared it and that decision stands');
  });
  await t('a sidecar renamed on collision is updated in place, not duplicated', async () => {
    // queue-clear renames on collision and moves the sidecar under the new name
    // WITHOUT rewriting the file field inside it. Reproduce that exactly.
    const src = flagsFor('bad.png');
    const orig = src.file;
    const renamed = '1788208950090-' + orig;
    for (const [a, b] of [[orig, renamed], [orig + '.flags.json', renamed + '.flags.json']]) {
      fs.renameSync(path.join(intake.INBOX, a), path.join(intake.ARCHIVE, b));
    }
    const moved = JSON.parse(fs.readFileSync(path.join(intake.ARCHIVE, renamed + '.flags.json'), 'utf8'));
    assert.strictEqual(moved.file, orig, 'fixture setup: the field must still name the OLD name');
    moved.extraction.chars = 1;                       // make it look stale so a rewrite is due
    fs.writeFileSync(path.join(intake.ARCHIVE, renamed + '.flags.json'), JSON.stringify(moved, null, 2) + '\n');

    const before = fs.readdirSync(intake.ARCHIVE).filter(x => x.endsWith('.flags.json')).length;
    const r = await silent(() => intake.backfill(true, { archive: true }));
    const after = fs.readdirSync(intake.ARCHIVE).filter(x => x.endsWith('.flags.json')).length;

    assert.strictEqual(after, before, 'the re-read created a second record instead of updating the one it read');
    assert.ok(!fs.existsSync(path.join(intake.ARCHIVE, orig + '.flags.json')),
      'a sidecar was written under the name the stale field claimed');
    const fixed = JSON.parse(fs.readFileSync(path.join(intake.ARCHIVE, renamed + '.flags.json'), 'utf8'));
    assert.ok(fixed.backfilled_at, 'the sidecar that was read was not the one that was written');
    assert.strictEqual(fixed.file, renamed, 'the record must name itself correctly after the repair');
    assert.strictEqual(fixed.backfill.named_itself, orig, 'the repair must be on the record, not silent');
    assert.ok(r.some(x => x.file === 'archive/' + renamed));
  });

  await t('an extraction whose item is gone is pruned, one whose item is present is not', async () => {
    const keep = flagsFor('s.png');                       // still in the review queue
    const strandedName = '2026-01-01_gone.png.txt';
    fs.writeFileSync(path.join(intake.INBOX, '.text', strandedName), 'text for an item that is not here');
    const plan = await silent(() => intake.backfill(false));
    assert.ok(plan.some(x => x.outcome === 'would-prune' && x.file.endsWith(strandedName)));
    assert.ok(fs.existsSync(path.join(intake.INBOX, '.text', strandedName)), 'the plan deleted something');

    await silent(() => intake.backfill(true));
    assert.ok(!fs.existsSync(path.join(intake.INBOX, '.text', strandedName)), 'the stranded extraction survived --go');
    assert.ok(fs.existsSync(path.join(intake.INBOX, keep.extraction.text_file)),
      'an extraction whose item is still present must never be pruned');
  });

  console.log('\n--- email recursion ---');
  await t('eml admitted, body + attachments in flags', async () => {
    putFile('mail.eml', path.join(FIX, 'message.eml'));
    await run();
    const fl = flagsFor('mail.eml');
    assert.strictEqual(fl.extraction.extractor, 'mailparser');
    assert.strictEqual(fl.attachments.length, 2);
    assert.ok(fl.attachments.find(a => a.name === 'rows.csv' && a.scan_state === 'scanned'));
    assert.ok(fl.attachments.find(a => a.name === 'chart.png' && a.scan_state === 'vision-pending'));
    assert.strictEqual(fl.has_vision_pending, true, 'attachment vision-pending should propagate');
  });

  console.log('\n--- tripwire FLAGS, does not refuse ---');
  await t('term in csv is admitted and flagged', async () => {
    putText('leak.csv', 'id,note\n1,budget for REPLACE_WITH_CLIENT_NAME\n');
    const r = await run();
    assert.strictEqual(r[0].outcome, 'admitted', 'must not quarantine on tripwire');
    assert.ok(admittedFiles().some(f => f.endsWith('leak.csv')), 'flagged file must reach inbox');
    const fl = flagsFor('leak.csv');
    assert.strictEqual(fl.tripwire.flagged, true);
    assert.strictEqual(fl.tripwire.hits[0].type, 'TERM');
    assert.strictEqual(fl.tripwire.hits[0].unit, 'body');
  });
  await t('term inside email attachment is flagged with unit', async () => {
    const b = '=_b_=';
    const att = Buffer.from('id,note\n1,contains REPLACE_WITH_EMPLOYER_NAME\n').toString('base64');
    const eml = ['From: a@b.com','To: c@d.com','Subject: rollup','MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${b}"`,'',`--${b}`,'Content-Type: text/plain','','clean body','',
      `--${b}`,'Content-Type: text/csv','Content-Disposition: attachment; filename="x.csv"','Content-Transfer-Encoding: base64','',att,'',`--${b}--`,''].join('\r\n');
    putText('leaky.eml', eml);
    await run();
    const fl = flagsFor('leaky.eml');
    assert.strictEqual(fl.tripwire.flagged, true);
    assert.ok(fl.tripwire.hits.some(h => h.unit === 'attachment:x.csv'), 'hit must be attributed to the attachment');
  });
  await t('secret pattern flagged not refused', async () => {
    putText('creds.md', 'key AKIAIOSFODNN7EXAMPLE\n');
    const r = await run();
    assert.strictEqual(r[0].outcome, 'admitted');
    assert.strictEqual(flagsFor('creds.md').tripwire.hits.some(h => h.type === 'PATTERN'), true);
  });
  await t('clean file admitted, not flagged', async () => {
    putText('clean.md', '# Roadmap\nAll items green.\n');
    await run();
    const fl = flagsFor('clean.md');
    assert.strictEqual(fl.tripwire.flagged, false);
    assert.strictEqual(fl.tripwire.scanned, true);
  });

  console.log('\n--- structural quarantine only ---');
  await t('unsupported type quarantined', async () => { putText('x.exe', 'MZ'); const r = await run(); assert.strictEqual(r[0].outcome, 'quarantined'); assert.ok(quar().some(f => f.endsWith('x.exe'))); });
  await t('empty file quarantined', async () => { putText('empty.csv', ''); const r = await run(); assert.strictEqual(r[0].outcome, 'quarantined'); assert.strictEqual(r[0].reason, 'empty file'); });
  await t('unparseable but supported (.msg) admitted unscanned, not quarantined', async () => {
    putFile('bad.msg', path.join(FIX, 'bogus.msg'));
    const r = await run();
    assert.strictEqual(r[0].outcome, 'admitted');
    assert.strictEqual(flagsFor('bad.msg').extraction.scan_state, 'unscanned');
  });

  console.log('\n--- idempotence ---');
  await t('identical content not re-admitted', async () => {
    const before = admittedFiles().length;
    putText('dup.csv', 'id,title\n1,Roadmap\n');   // same bytes as a.csv
    const r = await run();
    assert.strictEqual(r[0].outcome, 'duplicate', JSON.stringify(r[0]));
    assert.strictEqual(admittedFiles().length, before);
  });

  console.log('\n--- fail-closed config is explicit, not silent-clean ---');
  await t('missing tripwire config -> admitted but scanned=false', async () => {
    fs.unlinkSync(path.join(ROOT, 'gate', 'never-egress.json'));
    delete require.cache[require.resolve(path.join(ROOT, 'gate', 'tripwire.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'intake.js'))];
    const fresh = require(path.join(ROOT, 'scripts', 'intake.js'));
    fs.mkdirSync(fresh.DROP, { recursive: true });
    fs.writeFileSync(path.join(fresh.DROP, 'noconfig.md'), '# anything\n');
    await silent(() => fresh.runOnce());
    const f = fs.readdirSync(fresh.INBOX).find(x => x.endsWith('noconfig.md.flags.json'));
    const fl = JSON.parse(fs.readFileSync(path.join(fresh.INBOX, f), 'utf8'));
    assert.strictEqual(fl.tripwire.config_error, true);
    assert.strictEqual(fl.tripwire.scanned, false, 'must not claim a clean scan when config is missing');
    assert.strictEqual(fl.tripwire.flagged, false);
    fs.copyFileSync(path.join(ROOT, 'gate', 'never-egress.example.json'), path.join(ROOT, 'gate', 'never-egress.json'));
  });

  console.log('\n--- audit + no-content guarantees ---');
  await t('audit chain verifies', () => { const v = audit.verify(); assert.strictEqual(v.ok, true, 'broken at ' + v.brokenAt); assert.ok(v.length >= 12); });
  await t('admissions and quarantines both recorded', () => { const raw = fs.readFileSync(audit.LOG, 'utf8'); assert.ok(raw.includes('"status":"ADMITTED"')); assert.ok(raw.includes('"status":"QUARANTINED"')); });
  await t('audit stores no file content', () => { const raw = fs.readFileSync(audit.LOG, 'utf8'); assert.ok(!raw.includes('Roadmap')); assert.ok(!raw.includes('AKIAIOSFODNN7EXAMPLE')); });
  await t('flag sidecars store no content, only rule ids + locations', () => {
    for (const f of inboxFiles().filter(x => x.endsWith('.flags.json'))) {
      const raw = fs.readFileSync(path.join(intake.INBOX, f), 'utf8');
      assert.ok(!raw.includes('Roadmap review') && !raw.includes('AKIAIOSFODNN7EXAMPLE'), 'content leaked into ' + f);
    }
    const leak = flagsFor('leak.csv');
    assert.ok(typeof leak.tripwire.hits[0].location === 'number');
    assert.ok(!JSON.stringify(leak).includes('budget for'), 'matched text must not be stored');
  });

  console.log('\n--- the extraction survives intake ---');
  await t('every SCANNED item carries a readable extraction', () => {
    const scanned = inboxFiles().filter(f => f.endsWith('.flags.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(intake.INBOX, f), 'utf8')))
      .filter(fl => fl.extraction && fl.extraction.scan_state === 'scanned');
    assert.ok(scanned.length > 0, 'no scanned items to check -- the fixture set changed');
    for (const fl of scanned) {
      assert.ok(fl.extraction.text_file, fl.file + ': text was extracted and thrown away');
      const abs = path.join(intake.INBOX, fl.extraction.text_file);
      assert.ok(fs.existsSync(abs), fl.file + ': sidecar points at a file that is not there');
      assert.ok(fs.readFileSync(abs, 'utf8').length > 0, fl.file + ': the extraction is empty');
    }
  });
  await t('the extraction is invisible to the review queue', () => {
    assert.ok(!admittedFiles().some(f => f.startsWith('.')),
      'a dot entry in the admitted listing would be counted as a second item by fleet-core queue.js');
    const fl = inboxFiles().filter(f => f.endsWith('.flags.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(intake.INBOX, f), 'utf8')))
      .find(x => x.extraction && x.extraction.text_file);
    assert.ok(fl.extraction.text_file.startsWith('.'), 'the extraction must live in a dot directory');
  });
  await t('the extraction is 0600, like every other sidecar', () => {
    const fl = inboxFiles().filter(f => f.endsWith('.flags.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(intake.INBOX, f), 'utf8')))
      .find(x => x.extraction && x.extraction.text_file);
    const mode = fs.statSync(path.join(intake.INBOX, fl.extraction.text_file)).mode & 0o777;
    assert.strictEqual(mode.toString(8), '600');
  });
  await t('the sidecar gains a POINTER, never the content', () => {
    for (const f of inboxFiles().filter(x => x.endsWith('.flags.json'))) {
      const raw = fs.readFileSync(path.join(intake.INBOX, f), 'utf8');
      assert.ok(!raw.includes('Roadmap review') && !raw.includes('AKIAIOSFODNN7EXAMPLE'),
        'content leaked into ' + f + ' via the extraction change');
    }
  });

  console.log(`\nINTAKE LANE: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log('failed: ' + fail.join(', ')); process.exit(1); }
})();
