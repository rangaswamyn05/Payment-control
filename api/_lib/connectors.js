'use strict';
// Sends each payment event to the business's own systems.
// Implemented: the business API connector and the Google Sheets connector (append-only).
const crypto = require('crypto');

function validateUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return 'That is not a valid URL'; }
  if (process.env.ALLOW_LOCAL_CONNECTORS === '1') return null;
  if (x.protocol !== 'https:') return 'The URL must start with https://';
  const h = x.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === '[::1]') return 'Private addresses are not allowed';
  return null;
}

async function sendApi(api, event, payment, order) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(api.url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (api.key || ''),
        'X-Idempotency-Key': payment.id + ':' + event,
      },
      body: JSON.stringify({
        event,
        payment_id: payment.id,
        order_id: order.code,
        amount: payment.amount,
        mode: payment.mode,
        date: payment.date,
        reference: payment.txnId || '',
        status: payment.status,
      }),
    });
    return { connector: 'api', ok: r.ok, status: r.status };
  } catch (e) {
    return { connector: 'api', ok: false, error: String(e && e.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

async function dispatch(event, payment, order, settings) {
  const results = [];
  const api = settings && settings.connectors && settings.connectors.api;
  if (api && apiOn(settings) && api.url && !validateUrl(api.url)) results.push(await sendApi(api, event, payment, order));
  const extra = (settings && settings.connectors && settings.connectors.extra) || [];
  if (apiOn(settings)) for (const x of extra) if (x && x.url && !validateUrl(x.url)) results.push({ ...(await sendApi(x, event, payment, order)), name: x.name || '' });
  if (event !== 'test' && sheetOn(settings)) { const r = await appendRow('Payments', [new Date().toISOString(), event, payment.id, order.code, payment.amount, payment.mode, payment.date, payment.txnId || '', payment.status], sheetIdOf(settings)); if (r) results.push(r); }
  return results;
}

// ----- Google Sheets (service account, append only; never edits or deletes rows)
let tok = { v: '', exp: 0 };
const b64 = x => Buffer.from(x).toString('base64url');
function sheetsConfig(sid) {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim(), id = sid || process.env.SHEETS_ID;
  // The whole downloaded JSON file may be pasted: take the private key (and email) out of it.
  if (raw.startsWith('{')) { try { const j = JSON.parse(raw); raw = String(j.private_key || ''); email = email || j.client_email; } catch (e) { raw = ''; } }
  const key = raw.replace(/\\n/g, '\n');
  return email && key && id ? { email, key, id } : null;
}
async function sheetsToken(c) {
  if (tok.v && Date.now() < tok.exp - 60000) return tok.v;
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({ iss: c.email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(c.key).toString('base64url');
  const url = process.env.ALLOW_LOCAL_CONNECTORS === '1' && process.env.GOOGLE_TOKEN_URL ? process.env.GOOGLE_TOKEN_URL : 'https://oauth2.googleapis.com/token';
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google sign-in failed (' + r.status + ')');
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.v;
}
async function appendRow(tab, row, sid) {
  const c = sheetsConfig(sid);
  if (!c) return null;
  try {
    const t = await sheetsToken(c);
    const base = process.env.ALLOW_LOCAL_CONNECTORS === '1' && process.env.SHEETS_API_BASE ? process.env.SHEETS_API_BASE : 'https://sheets.googleapis.com';
    const safe = row.map(v => { const x = v == null ? '' : String(v); return /^[=+\-@]/.test(x) ? "'" + x : x; });
    const r = await fetch(`${base}/v4/spreadsheets/${encodeURIComponent(c.id)}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [safe] }) });
    return { connector: 'sheets', ok: r.ok, status: r.status };
  } catch (e) { return { connector: 'sheets', ok: false, error: String(e && e.message || e).slice(0, 120) }; }
}
const sheetIdOf = st => (st && st.sheet && st.sheet.id) || '';
const sheetOn = st => !!st && (['app_sheet', 'all'].includes(st.storage) || !!sheetIdOf(st));
function sheetIdFromLink(x) { const m = /\/spreadsheets\/d\/([\w-]{20,})/.exec(String(x || '')); return m ? m[1] : (/^[\w-]{30,}$/.test(String(x || '').trim()) ? String(x).trim() : ''); }
async function prepareSheet(sid) {
  const c = sheetsConfig(sid); if (!c) return { ok: false, error: 'Google Sheets is not switched on for this app yet' };
  try {
    const t = await sheetsToken(c), base = process.env.ALLOW_LOCAL_CONNECTORS === '1' && process.env.SHEETS_API_BASE ? process.env.SHEETS_API_BASE : 'https://sheets.googleapis.com';
    const h = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
    const m = await fetch(`${base}/v4/spreadsheets/${encodeURIComponent(sid)}?fields=sheets.properties.title`, { headers: h });
    if (!m.ok) return { ok: false, status: m.status, error: m.status === 404 || m.status === 403 ? 'Cannot open that sheet. Share it with the email shown, as Editor' : 'Google answered ' + m.status };
    const have = ((await m.json()).sheets || []).map(x => x.properties.title);
    const need = ['Payments', 'Orders'].filter(x => !have.includes(x));
    if (need.length) { const b = await fetch(`${base}/v4/spreadsheets/${encodeURIComponent(sid)}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: need.map(title => ({ addSheet: { properties: { title } } })) }) }); if (!b.ok) return { ok: false, status: b.status, error: 'Could not add the Payments and Orders tabs. Is the email an Editor?' }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 120) }; }
}
const apiOn = st => !!(st && st.connectors && st.connectors.api && st.connectors.api.enabled) || (!!st && ['app_api', 'all'].includes(st.storage));
async function dispatchOrder(event, order, settings) {
  if (!sheetOn(settings)) return [];
  const r = await appendRow('Orders', [new Date().toISOString(), event, order.code, order.customer, order.total, order.createdBy || '', order.approvedBy || ''], sheetIdOf(settings));
  return r ? [r] : [];
}

module.exports = { dispatch, dispatchOrder, appendRow, sheetsConfig, validateUrl, sheetIdFromLink, prepareSheet };
