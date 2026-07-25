/**
 * extract.js — text extraction per file type, with an explicit scan state.
 *
 * Returns for every file:
 *   {
 *     text:       string,        // extracted text ('' when none)
 *     scanState:  'scanned' | 'unscanned' | 'vision-pending',
 *     extractor:  string,        // which tool produced it
 *     chars:      number,
 *     note:       string?,       // reason when not 'scanned'
 *     attachments: [ { name, ...same shape } ]   // .eml / .msg only
 *   }
 *
 * scanState is the load-bearing field. The intake tripwire can only see what
 * was extracted, so a type admitted without usable text must be marked
 * 'unscanned' (no text to scan) or 'vision-pending' (an image whose meaning
 * needs the operator-attested vision path). A missing flag must never be
 * confused with a clean scan — that is the silent-wrong this guards against.
 *
 * System binaries (pdftotext, tesseract) are shelled out to, matching the
 * pattern proven in the Keel webchat. When a binary is absent the file is
 * still admitted, marked 'unscanned' with a reason — never refused.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TEXT_EXT  = new Set(['.md', '.markdown', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp']);

// Below this many alphanumeric characters, OCR output is treated as a failed
// read of a diagram rather than a text scan — routed to the vision path.
const OCR_MIN_ALNUM = Number(process.env.OCR_MIN_ALNUM || 12);

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
function alnumCount(s) { return (s.match(/[A-Za-z0-9]/g) || []).length; }

function result(text, scanState, extractor, note) {
  const t = text || '';
  return { text: t, scanState, extractor, chars: t.length, ...(note ? { note } : {}) };
}

// Run a system binary against a buffer by staging a temp file.
function runBinaryOnBuffer(buf, ext, fn) {
  const tmp = path.join(os.tmpdir(), 'castor-x-' + crypto.randomBytes(6).toString('hex') + ext);
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  try { return fn(tmp); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

function extractPdf(buf) {
  try {
    const text = runBinaryOnBuffer(buf, '.pdf', tmp =>
      execFileSync('pdftotext', ['-q', '-enc', 'UTF-8', tmp, '-'],
                   { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 }));
    if (text.trim().length === 0) {
      return result('', 'unscanned', 'pdftotext',
        'no embedded text (likely a scanned PDF); PDF-image OCR is not wired');
    }
    return result(text, 'scanned', 'pdftotext');
  } catch (e) {
    if (e.code === 'ENOENT') return result('', 'unscanned', 'pdftotext', 'pdftotext (poppler-utils) not installed');
    return result('', 'unscanned', 'pdftotext', 'pdftotext failed: ' + (e.message || '').slice(0, 120));
  }
}

function extractImage(buf, ext) {
  try {
    const text = runBinaryOnBuffer(buf, ext, tmp =>
      execFileSync('tesseract', [tmp, 'stdout', '-l', 'eng'],
                   { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
    if (alnumCount(text) < OCR_MIN_ALNUM) {
      // Little or no text recovered — the diagram case. Admit the image and
      // mark it for the operator-attested vision path, carrying whatever OCR
      // did find so a partial read is not lost.
      return result(text.trim(), 'vision-pending', 'tesseract',
        'OCR recovered little text; queue for attested vision interpretation');
    }
    return result(text, 'scanned', 'tesseract');
  } catch (e) {
    if (e.code === 'ENOENT') return result('', 'unscanned', 'tesseract', 'tesseract-ocr not installed');
    return result('', 'unscanned', 'tesseract', 'tesseract failed: ' + (e.message || '').slice(0, 120));
  }
}

function extractXlsx(buf) {
  let XLSX;
  try { XLSX = require('xlsx'); }
  catch { return result('', 'unscanned', 'sheetjs', 'xlsx parser not installed'); }
  try {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const text = wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
    return result(text, 'scanned', 'sheetjs');
  } catch (e) {
    return result('', 'unscanned', 'sheetjs', 'xlsx parse failed: ' + (e.message || '').slice(0, 120));
  }
}

function extractDocx(buf) {
  let mammoth;
  try { mammoth = require('mammoth'); }
  catch { return result('', 'unscanned', 'mammoth', 'mammoth not installed'); }
  return mammoth.extractRawText({ buffer: buf })
    .then(r => result(r.value, 'scanned', 'mammoth'))
    .catch(e => result('', 'unscanned', 'mammoth', 'docx parse failed: ' + (e.message || '').slice(0, 120)));
}

async function extractEml(buf) {
  let simpleParser;
  try { ({ simpleParser } = require('mailparser')); }
  catch { return result('', 'unscanned', 'mailparser', 'mailparser not installed'); }
  let parsed;
  try { parsed = await simpleParser(buf); }
  catch (e) { return result('', 'unscanned', 'mailparser', 'eml parse failed: ' + (e.message || '').slice(0, 120)); }

  const header = [parsed.subject ? 'Subject: ' + parsed.subject : '',
                  parsed.from && parsed.from.text ? 'From: ' + parsed.from.text : ''].filter(Boolean).join('\n');
  const body = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '');
  const out = result([header, body].filter(Boolean).join('\n\n'), 'scanned', 'mailparser');

  out.attachments = [];
  for (const att of parsed.attachments || []) {
    const name = att.filename || 'attachment';
    const childExt = path.extname(name).toLowerCase();
    const child = await extractBuffer(att.content, childExt, name);
    out.attachments.push({ name, ...child });
  }
  return out;
}

async function extractMsg(buf) {
  let MsgReader;
  try { MsgReader = require('@kenjiuno/msgreader').default; }
  catch { return result('', 'unscanned', 'msgreader', 'msgreader not installed'); }
  let reader, data;
  try {
    reader = new MsgReader(buf);
    data = reader.getFileData();
    if (data && data.error) throw new Error(data.error);
  } catch (e) {
    return result('', 'unscanned', 'msgreader', 'msg parse failed: ' + (e.message || '').slice(0, 120));
  }

  const header = [data.subject ? 'Subject: ' + data.subject : '',
                  data.senderName ? 'From: ' + data.senderName : ''].filter(Boolean).join('\n');
  const out = result([header, data.body || ''].filter(Boolean).join('\n\n'), 'scanned', 'msgreader');

  out.attachments = [];
  for (const attMeta of data.attachments || []) {
    try {
      const att = reader.getAttachment(attMeta);
      const name = att.fileName || attMeta.fileName || 'attachment';
      const childExt = path.extname(name).toLowerCase();
      const child = await extractBuffer(Buffer.from(att.content), childExt, name);
      out.attachments.push({ name, ...child });
    } catch (e) {
      out.attachments.push({ name: attMeta.fileName || 'attachment', ...result('', 'unscanned', 'msgreader', 'attachment unreadable') });
    }
  }
  return out;
}

// Core: extract from an in-memory buffer given an extension. Async because
// docx/eml/msg parsers are async.
async function extractBuffer(buf, ext, name) {
  ext = (ext || '').toLowerCase();
  if (ext === '.csv') return result(stripBom(buf.toString('utf8')), 'scanned', 'utf8-csv');
  if (TEXT_EXT.has(ext)) return result(stripBom(buf.toString('utf8')), 'scanned', 'utf8');
  if (ext === '.xlsx') return extractXlsx(buf);
  if (ext === '.pdf') return extractPdf(buf);
  if (IMAGE_EXT.has(ext)) return extractImage(buf, ext);
  if (ext === '.docx') return await extractDocx(buf);
  if (ext === '.eml') return await extractEml(buf);
  if (ext === '.msg') return await extractMsg(buf);
  return result('', 'unscanned', 'none', `no extractor for "${ext || '(none)'}"`);
}

async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  return extractBuffer(buf, ext, path.basename(filePath));
}

// The set intake will admit. Anything outside this is quarantined as an
// unsupported type before extraction is attempted.
const SUPPORTED = new Set([
  '.csv', '.xlsx', '.md', '.markdown', '.txt', '.pdf', '.docx', '.eml', '.msg',
  ...IMAGE_EXT,
]);

module.exports = { extract, extractBuffer, SUPPORTED, IMAGE_EXT, OCR_MIN_ALNUM };
