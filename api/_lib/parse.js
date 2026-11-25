'use strict';
// Reads the text of a UPI / bank payment screenshot (as returned by an OCR service)
// and pulls out the fields. Layouts differ a lot between apps, so every field is
// optional and the person always confirms the values before saving.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const toNum = s => Number(String(s).replace(/,/g, ''));
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const TIME = '(?:[\\s,]*(?:at\\s*)?(\\d{1,2})[:.](\\d{2})(?::\\d{2})?\\s*([ap])\\.?m\\.?)?';
const TIME24 = '(?:[\\s,]*(?:at\\s*)?(\\d{1,2}):(\\d{2})(?::\\d{2})?)?';

function mk(y, mo, d, h, mi, ap) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  let time = null;
  if (h != null && h !== '') {
    let hh = Number(h);
    if (ap) { ap = ap.toLowerCase(); if (ap === 'p' && hh < 12) hh += 12; if (ap === 'a' && hh === 12) hh = 0; }
    if (hh > 23 || Number(mi) > 59) return { date: `${y}-${pad(mo)}-${pad(d)}`, time: null };
    time = `${pad(hh)}:${pad(mi)}`;
  }
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
}

function parseDate(text) {
  let m;
  // 25 November 2026, 2:11 pm   /  24 Nov 2026 at 10:03 PM
  m = new RegExp('(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/,]+' + MON + '[a-z]*[\\s\\-\\/,]+(\\d{4})' + TIME, 'i').exec(text);
  if (m) return mk(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1], m[4], m[5], m[6]);
  // 25 Nov 2026, 14:11
  m = new RegExp('(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/,]+' + MON + '[a-z]*[\\s\\-\\/,]+(\\d{4})' + TIME24, 'i').exec(text);
  if (m) return mk(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1], m[4], m[5]);
  // Nov 24, 2026, 10:03 PM
  m = new RegExp(MON + '[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})' + TIME, 'i').exec(text);
  if (m) return mk(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2], m[4], m[5], m[6]);
  // 24/11/2026 10:03 PM   (day first, as used in India)
  m = new RegExp('(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{4})' + TIME, 'i').exec(text);
  if (m) return mk(+m[3], +m[2], +m[1], m[4], m[5], m[6]);
  m = new RegExp('(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{4})' + TIME24, 'i').exec(text);
  if (m) return mk(+m[3], +m[2], +m[1], m[4], m[5]);
  // 2026-11-24 22:03
  m = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text);
  if (m) return mk(+m[1], +m[2], +m[3], m[4], m[5]);
  return null;
}

function findAmounts(text) {
  const out = [];
  const re = /(?:₹|\u20B9|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
  let m;
  while ((m = re.exec(text))) { const n = toNum(m[1]); if (n > 0) out.push(n); }
  if (out.length) return out;
  // OCR sometimes drops the rupee sign: use a line that is only a number
  for (const l of text.split(/\n/)) {
    const mm = /^\s*\+?\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*$/.exec(l);
    if (mm && mm[1].replace(/[,.]/g, '').length <= 9) { const n = toNum(mm[1]); if (n > 0) out.push(n); }
  }
  return out;
}

const STOP = /^(completed|success|successful|failed|pending|powered|unified|bank|paid|sent|credited|debited|status|date|remarks|transaction|reply|advance|to|from|upi|details|reference|ref|payment)\b/i;

function lineAfter(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const same = lines[i].replace(re, '').replace(/^[\s:\-]+/, '').trim();
    const out = [];
    if (same && /^[A-Za-z][A-Za-z .'&\-]{2,}$/.test(same)) out.push(same);
    for (let j = i + 1; j < lines.length && out.length < 3; j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (/^[A-Za-z][A-Za-z .'&\-]{2,}$/.test(l) && !STOP.test(l) && !/\bbank\b/i.test(l)) out.push(l); else break;
    }
    const s = out.join(' ').trim();
    if (s) return s;
  }
  return null;
}

function cleanSender(l) {
  return l.replace(/\s+with\s+.*$/i, '').replace(/[•·.*x]{2,}\s*\d*\s*$/i, '').replace(/\s+\d{2,}$/, '').trim();
}

function parseUpi(raw) {
  const text = String(raw || '').replace(/\r/g, '').replace(/[\u200e\u200f]/g, '');
  const flat = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const out = { amount: null, date: null, time: null, txnId: null, payer: null, payee: null, payeeVpa: null, direction: null, mode: 'upi', status: null, note: null };

  const amts = findAmounts(text);
  if (amts.length) out.amount = amts[0];
  out.candidates = [...new Set(amts)].slice(0, 5);

  const d = parseDate(flat);
  if (d) { out.date = d.date; out.time = d.time; }

  // Transaction / reference id (needs a digit so words such as "Completed" are not taken)
  const idRes = [
    /(?:UPI\s*)?(?:Transaction|Txn|Trans\.?)\s*(?:ID|No\.?|Ref(?:erence)?(?:\s*(?:No\.?|ID))?)\s*[:\-]?\s*([A-Za-z0-9]{8,25})/i,
    /\bUTR\s*(?:No\.?|Number)?\s*[:\-]?\s*([A-Za-z0-9]{8,25})/i,
    /UPI\s*Ref(?:erence)?(?:\s*(?:No\.?|ID|Number))?\s*[:\-]?\s*([A-Za-z0-9]{8,25})/i,
    /\bRef(?:erence)?\s*(?:No\.?|ID|Number)\s*[:\-]?\s*([A-Za-z0-9]{8,25})/i,
  ];
  for (const re of idRes) {
    const g = new RegExp(re.source, 'gi'); let m;
    while ((m = g.exec(flat))) { if (/\d/.test(m[1])) { out.txnId = m[1]; break; } }
    if (out.txnId) break;
  }

  // Bank remark line: UPI/NAME/BANK/123456789012/...
  const rem = /UPI\s*\/\s*([^\/]+?)\s*\/\s*([A-Za-z]{3,8})\s*\/\s*(\d{8,})/i.exec(flat);
  if (rem) { out.payer = rem[1].trim(); if (!out.txnId) out.txnId = rem[3]; }

  const vpa = /([A-Za-z0-9._\-]{3,}@[A-Za-z]{2,})/.exec(flat);
  if (vpa) out.payeeVpa = vpa[1];

  const payee = lineAfter(lines, /^(?:paid\s+to|sent\s+to|to)\b/i);
  if (payee) out.payee = payee;

  // "Sent from NAME with BANK ••26" / "From NAME"
  for (let i = 0; i < lines.length && !out.payer; i++) {
    if (/^(?:sent\s+from|paid\s+by|from)\b/i.test(lines[i])) {
      const rest = lines[i].replace(/^(?:sent\s+from|paid\s+by|from)\b[\s:\-]*/i, '').trim();
      const cand = rest || lines[i + 1] || '';
      const c = cleanSender(cand);
      if (c && /^[A-Za-z][A-Za-z .'&\-]{2,}$/.test(c)) out.payer = c;
    }
  }

  if (/\bcredited\b|received\s+from|money\s+received/i.test(flat)) out.direction = 'credit';
  else if (/paid\s+to|sent\s+to|debited/i.test(flat)) out.direction = 'debit';

  if (/\b(success(?:ful)?|completed|paid)\b/i.test(flat)) out.status = 'success';
  else if (/\b(failed|declined|pending)\b/i.test(flat)) out.status = (/\bfailed|declined\b/i.test(flat)) ? 'failed' : 'pending';

  if (/\b(neft|imps|rtgs)\b/i.test(flat) && !/\bupi\b/i.test(flat)) out.mode = 'transfer';

  let score = 0;
  if (out.amount) score += 2;
  if (out.date) score += 1;
  if (out.txnId) score += 1;
  if (out.payee || out.payer) score += 1;
  out.confidence = score >= 4 ? 'high' : score >= 3 ? 'medium' : 'low';
  return out;
}

module.exports = { parseUpi, parseDate, findAmounts };
