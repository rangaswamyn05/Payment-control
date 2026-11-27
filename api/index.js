'use strict';
// One serverless function handles every /api/* route (keeps us inside Vercel's free function limit).
const db = require('./_lib/db');
const A = require('./_lib/auth');
const { parseUpi, parseSchedule, parseInvoiceStyle } = require('./_lib/parse');
const { appendRow } = require('./_lib/connectors');
const { dispatch, dispatchOrder, validateUrl, sheetIdFromLink, prepareSheet, sheetsConfig, catalog, pickCols, PAY_COLS, ORD_COLS, PAY_DEFAULT, ORD_DEFAULT, payRow, API_FIELDS, API_DEFAULT } = require('./_lib/connectors');

const RANK = { uploader: 1, manager: 2, owner: 3 };
const VERIFIED = ['verified', 'cash_confirmed'];
const UNVERIFIED = ['client_reported', 'cash_pending'];
const MODES = ['upi', 'transfer', 'cheque', 'card', 'cash'];
const r2 = n => Math.round(Number(n) * 100) / 100;
const lc = s => String(s || '').trim().toLowerCase();

class HttpErr extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (e) { throw new HttpErr(400, 'Bad request'); } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString() || '{}'); } catch (e) { throw new HttpErr(400, 'Bad request'); } }
    return req.body;
  }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 6e6) throw new HttpErr(413, 'File too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString();
  if (!s) return {};
  try { return JSON.parse(s); } catch (e) { throw new HttpErr(400, 'Bad request'); }
}

const pubUser = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active !== false });

async function audit(me, action, entity, entityId, detail) {
  try { await db.insert('audit', { at: new Date().toISOString(), by: me ? me.name + ' (' + me.role + ')' : 'system', byId: me ? me.id : null, action, entity, entityId, detail: String(detail || '').slice(0, 400) }); } catch (e) { /* never block the action */ }
}

// ---------- seed / setup ----------
async function ensureSeed() {
  const users = await db.all('users');
  if (users.length || process.env.NO_DEMO === '1' || ((await db.get('settings', 'main')) || {}).noDemo) return;
  const mk = (name, username, role) => db.insert('users', { name, username, role, active: true, pw: A.hashPassword('demo1234'), demo: true });
  await mk('Demo Owner', 'owner', 'owner');
  await mk('Demo Manager', 'manager', 'manager');
  await mk('Demo Uploader', 'uploader', 'uploader');
  const o = (code, customer, total) => db.insert('orders', { code, customer, total, status: 'open', note: 'Demo order', demo: true, createdBy: 'system' });
  await o('DEMO-1001', 'Demo client A', 100000);
  await o('DEMO-1002', 'Demo client B', 60000);
  await o('DEMO-1003', 'Demo client C', 45000);
}

async function authed(req, url, min) {
  let tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok && url) tok = url.searchParams.get('t') || '';
  const p = A.verifyToken(tok);
  if (!p) throw new HttpErr(401, 'Please sign in again');
  const u = await db.get('users', p.uid);
  if (!u || u.active === false) throw new HttpErr(401, 'This account is not active');
  if (RANK[u.role] < RANK[min]) throw new HttpErr(403, 'Your role cannot do this');
  return u;
}

// ---------- calculations ----------
const isSystem = p => p.status === 'verified' && p.verifyMethod === 'statement';
const isManual = p => p.status === 'cash_confirmed' || (p.status === 'verified' && p.verifyMethod !== 'statement');
function sums(pays) {
  const s = { verified: 0, unverified: 0, flagged: 0, validated: 0, manual: 0 };
  for (const p of pays) {
    if (VERIFIED.includes(p.status)) s.verified += p.amount;
    else if (UNVERIFIED.includes(p.status)) s.unverified += p.amount;
    else if (p.status === 'flagged') s.flagged += p.amount;
    if (isSystem(p)) s.validated += p.amount; else if (isManual(p)) s.manual += p.amount;
  }
  for (const k of Object.keys(s)) s[k] = r2(s[k]);
  return s;
}

const digits = x => String(x || '').replace(/\D/g, '');
// Indian mobile number: exactly 10 digits, with an optional +91 or 0 in front. Returns the 10 digits or ''.
const tenDigits = x => { let d = digits(x); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return d.length === 10 ? d : ''; };
const NOTE_MANUAL = 'Manually validated, not system validated';
const NOTE_PROVIDE = 'Upload a statement to validate this payment';
const NOTE_UNABLE = 'Unable to validate with the statements provided. Upload another statement, or a manager can review it manually.';
function unitsOf(u) { const n = Number(String(u == null ? '' : u).replace(/,/g, '')); return Number.isFinite(n) && n > 0 && n <= 1e7 ? Math.round(n * 1000) / 1000 : 0; }
function acctLabel(p, accs) {
  if (p.mode === 'cash') return 'Cash';
  const a = (accs || []).find(x => x.id === p.accountId);
  return a ? 'Received in ' + (a.bank ? a.bank + ' ' : '') + a.name + ' ····' + a.last4 : '';
}
function payNote(p) {
  if (isSystem(p)) return 'Validated against the bank statement';
  if (p.mode === 'cash' && isManual(p)) return 'Cash: validated manually by the owner. No bank statement can match cash';
  if (isManual(p)) return NOTE_MANUAL;
  if (p.status === 'client_reported') return p.stmtUnableAt ? 'Unable to validate: ' + (p.stmtReason || 'not found in the statement provided') + '. Upload another statement, or a manager can review it manually.' : NOTE_PROVIDE;
  if (p.status === 'cash_pending') return 'Waiting for the owner to approve cash';
  return '';
}

const todayIST = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
// Optional payment plan on an order: either a full instalment schedule or just the next due date.
function parseDue(body, total) {
  const out = {};
  if (Array.isArray(body.schedule) && body.schedule.length) {
    if (body.schedule.length > 24) throw new HttpErr(400, 'Up to 24 instalments');
    const rows = body.schedule.map(r => ({ date: String((r && r.date) || ''), amount: r2(r && r.amount) }));
    if (rows.some(r => !isDay(r.date) || !(r.amount > 0))) throw new HttpErr(400, 'Each instalment needs a date and an amount');
    if (r2(rows.reduce((s, r) => s + r.amount, 0)) > total + 0.005) throw new HttpErr(400, 'The instalments add up to more than the order total');
    out.schedule = rows.sort((a, b) => a.date.localeCompare(b.date));
  } else if (body.nextDue) {
    if (!isDay(String(body.nextDue))) throw new HttpErr(400, 'Enter the next payment due date');
    out.nextDue = String(body.nextDue);
  }
  return out;
}
// What the salesperson should chase next: first instalment not yet covered, or the single due date.
function dueInfo(o, collected, outstanding) {
  if (!(outstanding > 0.005)) return null;
  let date = '', amount = outstanding;
  if (Array.isArray(o.schedule) && o.schedule.length) {
    let cum = o.scheduleBase || 0;
    for (const r of o.schedule) { cum = r2(cum + r.amount); if (cum > collected + 0.005) { date = r.date; amount = r2(cum - collected); break; } }
  } else if (o.nextDue) date = o.nextDue;
  return date ? { date, amount, overdue: date < todayIST() } : null;
}
function orderView(o, allPays) {
  const pays = allPays.filter(p => p.orderCode === o.code);
  const s = sums(pays);
  const live = pays.filter(p => p.status !== 'rejected');
  const claimed = r2(s.verified + s.unverified);
  const waiting = live.filter(p => p.status === 'client_reported');
  let validation = 'none';
  if (waiting.length) validation = waiting.some(p => p.stmtUnableAt) ? 'unable' : 'pending';
  else if (live.some(p => p.status === 'cash_pending')) validation = 'owner';
  else if (claimed > 0) validation = s.manual > 0 ? 'manual' : 'validated';
  return {
    id: o.id, code: o.code, customer: o.customer, total: o.total, status: o.status, note: o.note || '', created: o.created, demo: !!o.demo,
    customerExtra: o.customerExtra || {}, item: o.item || '', units: o.units || 0, phone: o.phone || '', createdBy: o.createdBy || '', rejectReason: o.rejectReason || '', modifications: o.modifications || [],
    verified: s.verified, awaiting: s.unverified, flagged: s.flagged,
    collected: claimed, validated: s.validated, manual: s.manual, notValidated: s.unverified, validation,
    validationNote: validation === 'unable' ? NOTE_UNABLE : validation === 'pending' ? NOTE_PROVIDE : validation === 'owner' ? 'Cash waiting for owner approval' : validation === 'manual' ? NOTE_MANUAL : '',
    outstanding: r2(Math.max(0, o.total - claimed)),
    outstandingVerified: r2(Math.max(0, o.total - s.verified)),
    payments: live.length,
    pendingCash: pays.filter(p => p.status === 'cash_pending').length,
    pendingOwner: live.filter(p => p.approval === 'pending_owner').length,
    flaggedCount: pays.filter(p => p.status === 'flagged').length,
  };
}

const withOrder = (p, orders) => { const o = orders.find(x => x.code === p.orderCode); return { ...p, customer: o ? o.customer : '', validationNote: payNote(p) }; };

function normDate(d) {
  d = String(d || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(d)) return null;
  const t = Date.parse(d.length === 10 ? d + 'T00:00' : d);
  if (isNaN(t)) return null;
  if (t > Date.now() + 36 * 3600 * 1000) return 'future';
  return d;
}

const STORAGE = ['app', 'app_sheet', 'app_api', 'all'];
// Supporting checks reported on every statement match (they never block a match).
function matchChecks(p, row) {
  const d = Math.abs(Math.floor(Date.parse(String(row.date).slice(0, 10) + 'T00:00:00Z') / 86400000) - Math.floor(Date.parse(String(p.date).slice(0, 10) + 'T00:00:00Z') / 86400000));
  const dt = isNaN(d) ? 'Date not compared.' : d === 0 ? 'Date: same day.' : d === 1 ? 'Date: 1 day apart (normal for late-night or holiday credits).' : 'Date: ' + d + ' days apart, please look.';
  const hay = (String(row.ref || '') + ' ' + String(row.desc || '')).toLowerCase();
  const words = [p.orderCode, ...String(p.note || '').split(/[^\w-]+/), ...String(p.payer || '').split(/\s+/)].map(x => String(x || '').trim().toLowerCase()).filter(x => x.length >= 4);
  const hit = words.find(w => hay.includes(w));
  const rm = !words.length ? 'Remarks: none to compare.' : hit ? 'Remarks agree ("' + hit + '" is in the bank narration).' : 'Remarks: not found in the bank narration.';
  return dt + ' ' + rm;
}

async function getSettings() {
  const s = (await db.get('settings', 'main')) || { id: 'main' };
  return {
    id: 'main', businessName: s.businessName || '', managerEmails: s.managerEmails || [],
    connectors: { api: { enabled: false, url: '', key: '', ...((s.connectors && s.connectors.api) || {}), fields: pickCols(s.connectors && s.connectors.api && s.connectors.api.fields, API_FIELDS, API_DEFAULT) }, extra: (s.connectors && Array.isArray(s.connectors.extra) ? s.connectors.extra : []).slice(0, 5) },
    storage: STORAGE.includes(s.storage) ? s.storage : 'app',
    orderIdMode: s.orderIdMode === 'auto' ? 'auto' : 'own',
    business: { name: '', taxId: '', taxNA: false, noInvoice: false, invoiceMode: 'payment', address: '', contact: '', gstRate: '', gstMode: '', gstPct: '', kind: '', industry: '', ...(s.business || {}) },
    customerFields: Array.isArray(s.customerFields) ? s.customerFields : [],
    limits: { singlePayment: 0, collectionThreshold: 0, ...(s.limits || {}) },
    sheet: { id: String((s.sheet && s.sheet.id) || '').slice(0, 80), cols: { payments: pickCols(s.sheet && s.sheet.cols && s.sheet.cols.payments, PAY_COLS, PAY_DEFAULT), orders: pickCols(s.sheet && s.sheet.cols && s.sheet.cols.orders, ORD_COLS, ORD_DEFAULT) } },
    accounts: (Array.isArray(s.accounts) ? s.accounts : []).slice(0, 10).map(a => ({ id: String(a.id || ''), name: String(a.name || ''), bank: String(a.bank || ''), last4: String(a.last4 || ''), upi: (Array.isArray(a.upi) ? a.upi : []).map(x => String(x).trim().toLowerCase()).filter(x => /^[\w.\-]{2,}@[a-z]{2,}$/.test(x)).slice(0, 5) })).filter(a => a.id && a.name && /^\d{4}$/.test(a.last4)),
    onboarded: !!s.onboarded, invoiceStyle: s.invoiceStyle || null, invoiceSampleId: s.invoiceSampleId || '', lastExportAt: s.lastExportAt || '', lastExportById: s.lastExportById || '',
  };
}
async function saveSettings(next) { if (await db.get('settings', 'main')) await db.update('settings', 'main', next); else await db.insert('settings', next); }

async function notify(to, text, orderCode) { try { await db.insert('notifications', { to, text: String(text).slice(0, 300), orderCode: orderCode || '', read: false }); } catch (e) { /* never block */ } }
const mine = (n, me) => n.to === 'user:' + me.id || (n.to === 'role:owner' && me.role === 'owner') || (n.to === 'role:manager' && RANK[me.role] >= RANK.manager);
const inr = n => '₹' + Number(n).toLocaleString('en-IN');

async function runConnectors(event, payment, order, me) {
  try {
    const settings = await getSettings();
    const results = await dispatch(event, payment, order, settings);
    for (const r of results) await audit(me, 'connector_' + (r.ok ? 'ok' : 'failed'), 'payment', payment.id, `${r.connector} ${event} ${r.status || r.error || ''}`);
    return results;
  } catch (e) { return []; }
}

// ---------- payment entry (shared by new order and add payment) ----------
async function addPayment(me, order, body, opts = {}) {
  const settings = await getSettings();
  const mode = lc(body.mode);
  if (!MODES.includes(mode)) throw new HttpErr(400, 'Choose UPI, bank transfer, cheque, card or Razorpay, or cash');
  const amount = r2(body.amount);
  if (!(amount > 0) || amount > 1e9) throw new HttpErr(400, 'Enter the amount');
  const date = normDate(body.date);
  if (!date) throw new HttpErr(400, 'Enter the payment date');
  if (date === 'future') throw new HttpErr(400, 'That date is in the future');
  const txnId = String(body.txnId || '').trim().slice(0, 40);
  const isMgr = RANK[me.role] >= RANK.manager;
  if (mode !== 'cash') {
    if (!txnId) throw new HttpErr(400, (mode === 'cheque' ? 'No cheque number. Add a photo that shows the cheque number, or type it in.' : mode === 'card' ? 'No payment ID. Add the receipt screenshot that shows the payment ID, or type it in.' : 'No transaction ID found. Add a screenshot that shows the transaction ID, or type it in.'), { needTxn: true });
    if (!body.imageId && !isMgr) throw new HttpErr(400, 'Attach the payment screenshot');
  }
  if (body.imageId && !(await db.get('images', body.imageId))) throw new HttpErr(400, 'Screenshot not found, please attach it again');
  const all = (await db.all('payments')).filter(p => p.status !== 'rejected');
  if (txnId && mode !== 'cash') {
    const d = all.find(p => p.txnId && lc(p.txnId) === lc(txnId));
    if (d) throw new HttpErr(409, `This payment is already recorded (order ${d.orderCode}).`, { duplicate: true });
  }
  const mineP = all.filter(p => p.orderCode === order.code);
  const expected = mineP.length + 1;
  const seq = opts.first ? 1 : (Number(body.seq) > 0 ? Math.floor(Number(body.seq)) : expected);
  let seqReason = '';
  if (seq !== expected) {
    seqReason = String(body.seqReason || '').trim().slice(0, 200);
    if (seqReason.length < 3) throw new HttpErr(409, `This looks like payment ${expected} for this order, but you picked ${seq}. Write why, or pick ${expected}.`, { needReason: true, expected });
  }
  let status = mode === 'cash' ? 'cash_pending' : 'client_reported';
  let reason = '', approval = '';
  if (mode === 'cash') {
    if (me.role === 'owner') status = 'cash_confirmed';
    else approval = 'pending_owner';
  } else if (isMgr && me.role !== 'owner') approval = 'pending_owner';
  const lim = Number(settings.limits.singlePayment) || 0;
  const notices = [];
  if (lim > 0 && amount > lim && me.role !== 'owner') { approval = 'pending_owner'; notices.push(`This payment is above ${inr(lim)}. The owner will approve it.`); }
  const already = r2(mineP.reduce((s, p) => s + p.amount, 0));
  if (order.total && already + amount > order.total + 0.005) { status = 'flagged'; reason = 'overpayment'; notices.push('This is more than the order total. A manager will review it.'); }
  const th = Number(settings.limits.collectionThreshold) || 0;
  if (th > 0 && already + amount > th) notices.push('Please talk to your manager or owner first. This entry is saved and flagged for them.');
  const p = await db.insert('payments', {
    orderCode: order.code, mode, amount, date, txnId, seq, seqReason, payer: String(body.payer || '').trim().slice(0, 80), payee: String(body.payee || '').trim().slice(0, 80),
    imageId: body.imageId || '', note: String(body.note || '').slice(0, 200), status, reason, approval,
    createdBy: me.id, createdByName: me.name, ocr: body.ocr ? String(body.ocr).slice(0, 20) : '',
    attention: notices.length > 0 && !notices[0].startsWith('This payment is above') ? true : !!(lim > 0 && amount > lim),
  });
  await audit(me, 'payment_added', 'payment', p.id, `${order.code} #${seq} ${mode} ${amount} ${status}${seqReason ? '. Out of order: ' + seqReason : ''}`);
  if (approval === 'pending_owner') await notify('role:owner', `${me.name} entered ${inr(amount)} (${mode}) on ${order.code}. It needs your approval.`, order.code);
  if (status === 'flagged') await notify('role:manager', `${order.code}: ${inr(amount)} is more than the order total. Please review.`, order.code);
  if (th > 0 && already + amount > th) await notify('role:manager', `${order.code}: collections passed ${inr(th)} (${inr(already + amount)}). Entered by ${me.name}.`, order.code);
  if (!opts.first) await runConnectors('created', p, order, me);
  return { p, notice: notices.join(' '), notices };
}

async function afterApprove(me, o, settings) {
  const exists = (await db.all('invoices')).find(i => i.orderCode === o.code);
  if (!exists && !(settings.business && settings.business.noInvoice)) await db.insert('invoices', { orderCode: o.code, no: 'INV-' + o.code, generatedBy: me.name });
  await audit(me, 'invoice_generated', 'order', o.code, 'INV-' + o.code);
  try { await dispatchOrder('order_approved', o, settings); } catch (e) { /* never block */ }
  for (const p of (await db.all('payments')).filter(x => x.orderCode === o.code && x.status !== 'rejected')) await runConnectors('created', p, o, me);
}

// An order closes by itself once every rupee of it is validated or approved and nothing is flagged or waiting.
async function autoClose(me, code) {
  try {
    const o = (await db.all('orders')).find(x => x.code === code);
    if (!o || o.status !== 'open') return;
    const v = orderView(o, await db.all('payments'));
    if (v.outstanding > 0.005 || v.outstandingVerified > 0.005 || v.flaggedCount || v.pendingCash) return;
    await db.update('orders', o.id, { status: 'closed', closedAt: new Date().toISOString(), closedBy: 'auto' });
    await audit(me, 'order_auto_closed', 'order', o.code, 'Fully paid and validated');
    if (o.createdById) await notify('user:' + o.createdById, `${o.code} is fully paid and validated. The order is closed.`, o.code);
  } catch (e) { /* closing is a convenience, never block a payment */ }
}
async function applyAdjust(me, o, r, settings) {
  const at = new Date().toISOString();
  let n;
  if (r.kind === 'close_offline') {
    await db.insert('payments', { orderCode: o.code, mode: 'cash', amount: r.amount, date: at.slice(0, 16), txnId: '', seq: 0, status: 'cash_confirmed', approval: '', note: 'Received offline (adjustment): ' + r.comment, adjust: true, createdBy: r.byId || me.id, createdByName: r.by || me.name });
    n = await db.update('orders', o.id, { status: 'closed', closedAt: at });
    await audit(me, 'adjust_close_offline', 'order', o.code, `${r.amount} offline. ${r.comment}`);
  } else if (r.kind === 'change_plan') {
    n = await db.update('orders', o.id, { schedule: r.schedule, scheduleBase: r.base || 0, nextDue: '', planImageId: r.planImageId || o.planImageId || '', modifications: [...(o.modifications || []), { field: 'payment plan', from: (o.schedule && o.schedule.length) ? 'earlier plan' : 'none', to: r.schedule.map(x => x.date + ' ' + inr(x.amount)).join(', '), by: me.name, at, comment: r.comment }] });
    await audit(me, 'adjust_plan', 'order', o.code, r.comment);
  } else {
    n = await db.update('orders', o.id, { total: r.newTotal, modifications: [...(o.modifications || []), { field: 'total', from: o.total, to: r.newTotal, by: me.name, at, comment: r.comment }] });
    await audit(me, 'adjust_total', 'order', o.code, `${o.total} -> ${r.newTotal}. ${r.comment}`);
  }
  if (r.byId && r.byId !== me.id) await notify('user:' + r.byId, `Your change to ${o.code} was approved.`, o.code);
  return n;
}

function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function invoiceHtml(o, v, inv, settings, pays, single) {
  const b = settings.business, sty = settings.invoiceStyle || {};
  const gm = b.gstRate === 'GST registered (regular)' ? b.gstMode : '', gr = Number(b.gstPct) || 0, split = p => { const r = gr; if (gm === 'incl') { const g = r2(p.amount * r / (100 + r)); return { net: r2(p.amount - g), gst: g, tot: p.amount }; } if (gm === 'excl') { const g = r2(p.amount * r / 100); return { net: p.amount, gst: g, tot: r2(p.amount + g) }; } return { net: p.amount, gst: 0, tot: p.amount }; };
  const live = pays.filter(p => p.status !== 'rejected'), sp = live.map(split);
  const rows = live.map((p, i) => `<tr><td>${esc(String(p.date || '').slice(0, 10))}</td><td>${esc(p.mode)}</td><td class="r">${esc(inr(sp[i].net))}</td><td class="r">${gm ? esc(inr(sp[i].gst)) + ' <span style="color:#667">(' + esc(String(gr)) + '%)</span>' : '-'}</td><td class="r">${esc(inr(sp[i].tot))}</td></tr>`).join('');
  const tn = r2(sp.reduce((a, x) => a + x.net, 0)), tg = r2(sp.reduce((a, x) => a + x.gst, 0)), tt = r2(sp.reduce((a, x) => a + x.tot, 0));
  const extra = settings.customerFields.map(f => `<div>${esc(f.label)}: ${esc((o.customerExtra || {})[f.key] || '')}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.no)}</title><style>body{font:15px system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#111}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:14px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}.r{text-align:right}.big{font-size:18px;font-weight:700}@media print{.np{display:none}}</style></head><body>
<div style="display:flex;justify-content:space-between"><div><h1>${esc(b.name || settings.businessName || 'Invoice')}</h1><div>${esc(b.address)}</div><div>${esc(b.contact)}</div><div>${b.taxNA ? '' : 'GST / Tax no: ' + esc(b.taxId)}</div></div><div style="text-align:right"><div class="big">${esc(sty.title || 'Invoice')} ${esc(inv.no)}</div><div>${esc(String(inv.created || '').slice(0, 10))}</div></div></div>
<hr><div><b>${esc(sty.billTo ? sty.billTo.replace(/^./, c => c.toUpperCase()) : 'Bill to')}:</b> ${esc(o.customer)}</div>${extra}<div>Phone: ${esc(o.phone || '')}</div><div>Order: ${esc(o.code)}</div>${o.item ? `<div>Product / service: <b>${esc(o.item)}</b>${o.units ? ' &times; ' + esc(String(o.units)) + ' unit' + (o.units === 1 ? '' : 's') : ''}</div>` : ''}
<table><tr><th>Date</th><th>Mode</th><th class="r">Amount before GST</th><th class="r">GST</th><th class="r">Total</th></tr>${rows}<tr><td colspan="2"><b>Total</b></td><td class="r"><b>${esc(inr(tn))}</b></td><td class="r"><b>${esc(inr(tg))}</b></td><td class="r"><b>${esc(inr(tt))}</b></td></tr></table>
<table><tr><td>Order total</td><td class="r big">${esc(inr(o.total))}</td></tr><tr><td>${single ? 'Paid up to this payment' : 'Paid so far'}</td><td class="r">${esc(inr(v.collected))}</td></tr><tr><td>Balance</td><td class="r big">${esc(inr(v.outstanding))}</td></tr></table>
${(sty.footer || []).map(l => `<div style="color:#444;font-size:13px;margin-top:4px">${esc(l)}</div>`).join('')}
<p class="np"><button onclick="print()">Print or save as PDF</button></p></body></html>`;
}

// ---------- rate limit (best effort, per server instance) ----------
const fails = global.__pcfails || (global.__pcfails = new Map());
function tooMany(key) { const a = (fails.get(key) || []).filter(t => Date.now() - t < 10 * 60 * 1000); fails.set(key, a); return a.length >= 10; }

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = url.pathname;
  if (!path.startsWith('/api/') || path === '/api/index') path = '/api/' + (url.searchParams.get('p') || '');
  const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  const [a, b, c] = seg;

  if (a === 'health' && m === 'GET') {
    let users;
    try { await ensureSeed(); users = await db.all('users'); }
    catch (e) { return send(res, 503, { ok: false, error: 'Database problem: ' + String(e.message || e).replace(/eyJ[\w.-]+/g, '[key]').slice(0, 200) }); }
    return send(res, 200, { ok: true, db: db.kind, ocr: !!process.env.GOOGLE_VISION_KEY, needsSetup: users.length === 0, demo: users.some(u => u.demo), secretSet: A.secretIsSet });
  }

  if (a === 'setup' && m === 'POST') {
    const users = await db.all('users');
    if (users.length) throw new HttpErr(403, 'Setup is already done');
    const body = await readBody(req);
    if (!body.name || !body.username || String(body.password || '').length < 8) throw new HttpErr(400, 'Enter a name, a username and a password of at least 8 characters');
    const u = await db.insert('users', { name: String(body.name).trim(), username: lc(body.username), role: 'owner', active: true, pw: A.hashPassword(body.password) });
    await audit(u, 'setup', 'user', u.id, 'First owner created');
    return send(res, 200, { token: A.sign({ uid: u.id }), user: pubUser(u) });
  }

  if (a === 'login' && m === 'POST') {
    await ensureSeed();
    const body = await readBody(req);
    const uname = lc(body.username);
    const key = uname + '|' + (req.headers['x-forwarded-for'] || '');
    if (tooMany(key)) throw new HttpErr(429, 'Too many attempts. Try again in a few minutes.');
    const u = (await db.all('users')).find(x => x.username === uname && x.active !== false);
    if (!u || !A.verifyPassword(body.password, u.pw)) { fails.get(key).push(Date.now()); throw new HttpErr(401, 'Wrong username or password'); }
    await audit(u, 'login', 'user', u.id, '');
    return send(res, 200, { token: A.sign({ uid: u.id }), user: pubUser(u) });
  }

  if (a === 'me' && m === 'GET') { const me = await authed(req, url, 'uploader'); return send(res, 200, { user: pubUser(me) }); }

  // ----- users (owner)
  if (a === 'users') {
    const me = await authed(req, url, 'owner');
    if (!b && m === 'GET') return send(res, 200, { users: (await db.all('users')).map(pubUser) });
    if (!b && m === 'POST') {
      const body = await readBody(req);
      const username = lc(body.username);
      if (!body.name || !/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpErr(400, 'Name and a username (3 to 30 letters or numbers) are required');
      if (String(body.password || '').length < 8) throw new HttpErr(400, 'Password must be at least 8 characters');
      if (!RANK[body.role]) throw new HttpErr(400, 'Choose a role');
      if ((await db.all('users')).some(x => x.username === username)) throw new HttpErr(409, 'That username is taken');
      const u = await db.insert('users', { name: String(body.name).trim(), username, role: body.role, active: true, pw: A.hashPassword(body.password) });
      await audit(me, 'user_created', 'user', u.id, `${u.username} as ${u.role}`);
      return send(res, 200, { user: pubUser(u) });
    }
    if (b && m === 'PATCH') {
      const u = await db.get('users', b);
      if (!u) throw new HttpErr(404, 'User not found');
      const body = await readBody(req);
      const patch = {};
      if (body.role) { if (!RANK[body.role]) throw new HttpErr(400, 'Bad role'); patch.role = body.role; }
      if (typeof body.active === 'boolean') patch.active = body.active;
      if (body.password) { if (String(body.password).length < 8) throw new HttpErr(400, 'Password must be at least 8 characters'); patch.pw = A.hashPassword(body.password); }
      const owners = (await db.all('users')).filter(x => x.role === 'owner' && x.active !== false);
      if (u.role === 'owner' && owners.length === 1 && (patch.active === false || (patch.role && patch.role !== 'owner'))) throw new HttpErr(400, 'There must be at least one active owner');
      const n = await db.update('users', b, patch);
      await audit(me, 'user_updated', 'user', b, Object.keys(patch).filter(k => k !== 'pw').join(', ') + (patch.pw ? ' password reset' : ''));
      return send(res, 200, { user: pubUser(n) });
    }
  }

  // ----- settings
  if (a === 'settings' && !b) {
    if (m === 'GET') {
      const me = await authed(req, url, 'uploader');
      const s = await getSettings();
      const api = s.connectors.api;
      const base = { businessName: s.businessName, onboarded: s.onboarded, orderIdMode: s.orderIdMode, customerFields: s.customerFields, business: { name: s.business.name, taxNA: s.business.taxNA } };
      if (RANK[me.role] < RANK.manager) return send(res, 200, { settings: base });
      return send(res, 200, { settings: { ...base, managerEmails: s.managerEmails, storage: s.storage, business: s.business, limits: s.limits, accounts: s.accounts, sheet: me.role === 'owner' ? { id: s.sheet.id, cols: s.sheet.cols } : {}, sheetCatalog: me.role === 'owner' ? catalog() : null, sheetEmail: me.role === 'owner' ? (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '') : '', sheetReady: !!sheetsConfig('x'), lastExportAt: s.lastExportAt, connectors: { api: { enabled: !!api.enabled, url: me.role === 'owner' ? api.url || '' : '', keySet: !!api.key, fields: api.fields }, apiCatalog: me.role === 'owner' ? API_FIELDS.map(f => ({ k: f[0], label: f[1] })) : [], extra: me.role === 'owner' ? s.connectors.extra.map(x => ({ id: x.id, name: x.name, url: x.url, keySet: !!x.key, fields: pickCols(x.fields, API_FIELDS, API_DEFAULT) })) : [] } } });
    }
    if (m === 'PUT') {
      const me = await authed(req, url, 'owner');
      const body = await readBody(req);
      const cur = await getSettings();
      const curApi = cur.connectors.api;
      const inApi = (body.connectors && body.connectors.api) || {};
      if (inApi.url) { const bad = validateUrl(inApi.url); if (bad) throw new HttpErr(400, bad); }
      const bz = body.business || cur.business;
      const biz = { name: String(bz.name || '').slice(0, 80), taxNA: !!bz.taxNA, noInvoice: !!bz.taxNA && !!bz.noInvoice, invoiceMode: bz.invoiceMode === 'order' ? 'order' : 'payment', taxId: String(bz.taxId || '').trim().slice(0, 30), address: String(bz.address || '').slice(0, 200), contact: String(bz.contact || '').slice(0, 120), gstRate: String(bz.gstRate || '').slice(0, 40), gstMode: bz.gstMode === 'incl' || bz.gstMode === 'excl' ? bz.gstMode : '', gstPct: bz.gstPct !== undefined && bz.gstPct !== '' && Number(bz.gstPct) >= 0 && Number(bz.gstPct) <= 100 ? String(Number(bz.gstPct)) : '', kind: String(bz.kind || '').slice(0, 40), industry: String(bz.industry || '').slice(0, 40) };
      if (body.onboarded && !biz.taxNA && !biz.taxId) throw new HttpErr(400, 'Enter your GST or tax number, or tick that GST or tax is not applicable to your business');
      const cf = (Array.isArray(body.customerFields) ? body.customerFields : cur.customerFields).slice(0, 6).map(f => ({ label: String(f.label || '').trim().slice(0, 30) })).filter(f => f.label).map((f, i) => ({ label: f.label, key: 'f' + i + '_' + f.label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) }));
      const lm = body.limits || cur.limits;
      const next = {
        id: 'main', businessName: String(body.businessName !== undefined ? body.businessName : cur.businessName || biz.name).slice(0, 80),
        managerEmails: (Array.isArray(body.managerEmails) ? body.managerEmails : cur.managerEmails).map(x => String(x).trim()).filter(x => /^\S+@\S+\.\S+$/.test(x)).slice(0, 5),
        connectors: { extra: (Array.isArray(body.extraSystems) ? body.extraSystems : cur.connectors.extra).slice(0, 5).map(x => { const old = cur.connectors.extra.find(o => o.id === x.id) || {}; const u = String(x.url || '').trim(); if (u) { const bad = validateUrl(u); if (bad) throw new HttpErr(400, bad + ' (' + String(x.name || u).slice(0, 30) + ')'); } return { fields: pickCols(x.fields !== undefined ? x.fields : old.fields, API_FIELDS, API_DEFAULT), id: String(x.id || '').replace(/[^\w]/g, '').slice(0, 20) || 'sys_' + Math.random().toString(36).slice(2, 8), name: String(x.name || '').trim().slice(0, 40), url: u, key: x.key ? String(x.key) : old.key || '' }; }).filter(x => x.url), api: { fields: pickCols(inApi.fields !== undefined ? inApi.fields : curApi.fields, API_FIELDS, API_DEFAULT), enabled: !!inApi.enabled, url: inApi.url !== undefined ? String(inApi.url).trim() : curApi.url || '', key: inApi.key ? String(inApi.key) : curApi.key || '' } },
        storage: STORAGE.includes(body.storage) ? body.storage : cur.storage,
        orderIdMode: body.orderIdMode === 'auto' || body.orderIdMode === 'own' ? body.orderIdMode : cur.orderIdMode,
        business: biz, customerFields: cf,
        sheet: { id: body.sheetLink !== undefined ? (String(body.sheetLink).trim() ? (sheetIdFromLink(body.sheetLink) || (() => { throw new HttpErr(400, 'That is not a Google Sheet link'); })()) : '') : cur.sheet.id, cols: body.sheetCols ? { payments: pickCols(body.sheetCols.payments, PAY_COLS, PAY_DEFAULT), orders: pickCols(body.sheetCols.orders, ORD_COLS, ORD_DEFAULT) } : cur.sheet.cols },
        accounts: (() => { const inp = Array.isArray(body.accounts) ? body.accounts : cur.accounts; return inp.slice(0, 10).map(a => { const last4 = String(a.last4 || '').replace(/\D/g, ''); if (String(a.name || '').trim() && !/^\d{4}$/.test(last4)) throw new HttpErr(400, 'Enter the last 4 digits of the account number for ' + String(a.name).trim()); return { id: String(a.id || '').replace(/[^\w]/g, '').slice(0, 20) || 'acc_' + Math.random().toString(36).slice(2, 8), name: String(a.name || '').trim().slice(0, 40), bank: String(a.bank || '').trim().slice(0, 40), last4, upi: (Array.isArray(a.upi) ? a.upi : String(a.upi || '').split(/[,\s]+/)).map(x => String(x).trim().toLowerCase()).filter(x => /^[\w.\-]{2,}@[a-z]{2,}$/.test(x)).slice(0, 5) }; }).filter(a => a.name); })(),
        limits: { singlePayment: Math.max(0, r2(lm.singlePayment) || 0), collectionThreshold: Math.max(0, r2(lm.collectionThreshold) || 0) },
        onboarded: body.onboarded !== undefined ? !!body.onboarded : cur.onboarded, invoiceSampleId: body.invoiceSampleId !== undefined ? String(body.invoiceSampleId).slice(0, 40) : cur.invoiceSampleId, lastExportAt: cur.lastExportAt, lastExportById: cur.lastExportById,
      };
      await saveSettings(next);
      await audit(me, 'settings_updated', 'settings', 'main', `storage ${next.storage}; limits ${next.limits.singlePayment}/${next.limits.collectionThreshold}`);
      return send(res, 200, { ok: true });
    }
  }
  if (a === 'settings') {
    if (b === 'test-sheet' && m === 'POST') {
      const me = await authed(req, url, 'owner');
      const s = await getSettings();
      if (!s.sheet.id) throw new HttpErr(400, 'Save the Google Sheet link first');
      const pr = await prepareSheet(s.sheet.id, s.sheet.cols);
      if (!pr.ok) return send(res, 200, { ok: false, error: pr.error });
      const r = await appendRow('Payments', payRow(s.sheet.cols.payments, { id: 'TEST', amount: 1, mode: 'upi', date: '', txnId: 'TEST', status: 'test', payer: 'Test', createdByName: me.name }, { code: 'TEST', customer: 'Test customer', phone: '', total: 1 }, 'test'), s.sheet.id);
      await audit(me, 'sheet_test', 'settings', 'main', JSON.stringify(r || {}));
      return send(res, 200, { ok: !!(r && r.ok), error: r && r.ok ? '' : 'Google did not accept the row' });
    }
    if (b === 'test-api' && m === 'POST') {
      const me = await authed(req, url, 'owner');
      const s = await getSettings();
      const api = s.connectors.api;
      if (!api || !api.url) throw new HttpErr(400, 'Save the API URL first');
      const bad = validateUrl(api.url); if (bad) throw new HttpErr(400, bad);
      const r = await dispatch('test', { id: 'test', amount: 1, mode: 'upi', date: new Date().toISOString().slice(0, 16), txnId: 'TEST', status: 'client_reported' }, { code: 'TEST' }, { connectors: { api: { ...api, enabled: true }, extra: s.connectors.extra } });
      await audit(me, 'api_test', 'settings', 'main', JSON.stringify(r[0] || {}));
      return send(res, 200, { result: r[0] || null, results: r });
    }
  }

  // ----- images
  if (a === 'images') {
    if (!b && m === 'POST') {
      const me = await authed(req, url, 'uploader');
      const body = await readBody(req);
      const du = String(body.dataUrl || '');
      if (body.kind === 'sample' && me.role === 'owner' && du.startsWith('data:application/pdf;base64,')) {
        const pm = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(du);
        if (!pm || Buffer.from(pm[1].slice(0, 12), 'base64').toString('latin1').slice(0, 4) !== '%PDF') throw new HttpErr(400, 'That does not look like a PDF');
        if (pm[1].length > 4.2e6) throw new HttpErr(413, 'That PDF is too large');
        const pdf = await db.insert('images', { dataUrl: du, createdBy: me.id, sample: true });
        return send(res, 200, { id: pdf.id });
      }
      const mt = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(du);
      if (!mt) throw new HttpErr(400, 'Please choose a photo or screenshot (JPG, PNG or WebP)');
      if (mt[2].length > 4.2e6) throw new HttpErr(413, 'That image is too large');
      const img = await db.insert('images', { dataUrl: body.dataUrl, createdBy: me.id });
      return send(res, 200, { id: img.id });
    }
    if (b && m === 'GET') {
      const me = await authed(req, url, 'uploader');
      const img = await db.get('images', b);
      if (!img || (RANK[me.role] < RANK.manager && img.createdBy !== me.id)) throw new HttpErr(404, 'Not found');
      const mt = /^data:((?:image\/[a-z]+)|application\/pdf);base64,(.*)$/.exec(img.dataUrl);
      if (mt[1] === 'application/pdf') { res.setHeader('Content-Security-Policy', 'sandbox'); res.setHeader('X-Content-Type-Options', 'nosniff'); }
      res.statusCode = 200; res.setHeader('Content-Type', mt[1]); res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.end(Buffer.from(mt[2], 'base64'));
    }
  }

  // ----- screenshot reading
  if (a === 'ocr' && m === 'POST') {
    const me = await authed(req, url, 'uploader');
    const body = await readBody(req);
    // which existing orders does the screenshot mention (order ID in the remark, or the customer's phone)?
    const mentions = async (parsed, text) => {
      if (!parsed || body.kind === 'plan') return parsed;
      try {
        const orders = await db.all('orders');
        const hay = ' ' + String(text).toUpperCase().replace(/[^A-Z0-9-]+/g, ' ') + ' ';
        const hit = new Set(orders.filter(o => o.code && hay.includes(' ' + String(o.code).toUpperCase() + ' ')).map(o => o.code));
        if (parsed.orderHint) orders.filter(o => String(o.code).toUpperCase() === parsed.orderHint).forEach(o => hit.add(o.code));
        if (parsed.phone) orders.filter(o => o.phone && digits(o.phone).endsWith(parsed.phone.slice(-10))).forEach(o => hit.add(o.code));
        parsed.orderMatches = [...hit].slice(0, 5);
      } catch (e) { /* hints only */ }
      return parsed;
    };
    if (typeof body.text === 'string' && body.text.trim()) { // text already read in the browser (no key needed)
      const t = body.text.slice(0, 20000);
      return send(res, 200, { configured: true, source: 'browser', rawText: t.slice(0, 1500), parsed: body.kind === 'plan' ? { schedule: parseSchedule(t) } : await mentions(parseUpi(t), t) });
    }
    const img = await db.get('images', body.imageId);
    if (!img || (RANK[me.role] < RANK.manager && img.createdBy !== me.id)) throw new HttpErr(404, 'Image not found');
    if (!process.env.GOOGLE_VISION_KEY) return send(res, 200, { configured: false });
    const b64 = img.dataUrl.split(',')[1];
    const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(process.env.GOOGLE_VISION_KEY), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: b64 }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }] }),
    });
    if (!r.ok) return send(res, 200, { configured: true, error: 'Reading failed (' + r.status + '). Enter the details by hand.' });
    const j = await r.json();
    const resp = (j.responses || [])[0] || {};
    const text = (resp.fullTextAnnotation && resp.fullTextAnnotation.text) || (resp.textAnnotations && resp.textAnnotations[0] && resp.textAnnotations[0].description) || '';
    if (!text) return send(res, 200, { configured: true, error: 'No text found in the image. Enter the details by hand.' });
    return send(res, 200, { configured: true, rawText: text.slice(0, 1500), parsed: body.kind === 'plan' ? { schedule: parseSchedule(text) } : await mentions(parseUpi(text), text) });
  }

  // ----- read the sample invoice (owner): words -> layout to follow
  if (a === 'invoice-style' && m === 'POST') {
    const me = await authed(req, url, 'owner');
    const body = await readBody(req);
    const cur = await getSettings();
    const img = await db.get('images', body.imageId || cur.invoiceSampleId);
    if (!img) throw new HttpErr(404, 'Sample invoice not found');
    let text = typeof body.text === 'string' ? body.text.slice(0, 20000) : '';
    if (!text) {
      if (!process.env.GOOGLE_VISION_KEY) return send(res, 200, { configured: false });
      const m0 = /^data:([\w/+.-]+);base64,/.exec(img.dataUrl || ''), b64 = String(img.dataUrl || '').split(',')[1], pdf = m0 && m0[1] === 'application/pdf';
      const key = encodeURIComponent(process.env.GOOGLE_VISION_KEY);
      const r = pdf
        ? await fetch('https://vision.googleapis.com/v1/files:annotate?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ inputConfig: { content: b64, mimeType: 'application/pdf' }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], pages: [1, 2] }] }) })
        : await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ image: { content: b64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }) });
      if (!r.ok) return send(res, 200, { configured: true, error: 'Could not read the sample (' + r.status + '). Invoices will use the standard layout.' });
      const j = await r.json();
      const resp = pdf ? ((j.responses || [])[0] || {}).responses || [] : j.responses || [];
      text = resp.map(x => (x.fullTextAnnotation && x.fullTextAnnotation.text) || '').join('\n');
    }
    if (!text.trim()) return send(res, 200, { configured: true, error: 'No text found in the sample. Invoices will use the standard layout.' });
    const style = { ...parseInvoiceStyle(text), imageId: img.id, readAt: new Date().toISOString() };
    await saveSettings({ invoiceStyle: style });
    await audit(me, 'invoice_style_read', 'settings', 'invoice', style.title || 'sample read');
    return send(res, 200, { configured: true, style });
  }

  // ----- orders
  if (a === 'orders') {
    if (b === 'lookup' && c && m === 'GET') {
      await authed(req, url, 'uploader');
      const o = (await db.all('orders')).find(x => lc(x.code) === lc(c));
      if (!o) throw new HttpErr(404, 'No order with that ID');
      const n = (await db.all('payments')).filter(p => p.orderCode === o.code && p.status !== 'rejected').length;
      return send(res, 200, { code: o.code, customer: o.customer, item: o.item || '', units: o.units || 0, total: o.total, closed: o.status === 'closed', pending: o.status === 'pending', rejected: o.status === 'rejected', nextPayment: n + 1, hasPlan: !!(o.schedule && o.schedule.length), outstanding: orderView(o, await db.all('payments')).outstanding });
    }
    if (b === 'by-phone' && c && m === 'GET') {
      await authed(req, url, 'uploader');
      const d = digits(c);
      if (d.length < 7) return send(res, 200, { orders: [] });
      const list = (await db.all('orders')).filter(o => o.status === 'open' && o.phone && digits(o.phone).endsWith(d.slice(-10)) );
      return send(res, 200, { orders: list.map(o => ({ code: o.code, customer: o.customer, total: o.total })) });
    }
    if (b === 'mine' && m === 'GET') {
      const me = await authed(req, url, 'uploader');
      const list = (await db.all('orders')).filter(o => o.createdById === me.id).reverse();
      const allPays = await db.all('payments');
      return send(res, 200, { orders: list.map(o => { const v = orderView(o, allPays); return { collected: v.collected, outstanding: v.outstanding, due: dueInfo(o, v.collected, v.outstanding), code: o.code, customer: o.customer, total: o.total, status: o.status, rejectReason: o.rejectReason || '', customerExtra: o.customerExtra || {}, modifications: o.modifications || [] }; }) });
    }
    const resubmitting = c === 'resubmit' && m === 'POST';
    const me = await authed(req, url, (!b && m === 'POST') || resubmitting ? 'uploader' : 'manager');
    const orders = await db.all('orders');
    const settings = await getSettings();
    if (!b && m === 'GET') {
      const pays = await db.all('payments');
      return send(res, 200, { orders: orders.map(o => orderView(o, pays)).reverse() });
    }
    const readExtra = (inp, old) => {
      const out = { ...(old || {}) };
      for (const f of settings.customerFields) {
        const v = inp && inp[f.key] !== undefined ? String(inp[f.key]).trim().slice(0, 120) : (out[f.key] || '');
        if (!v) throw new HttpErr(400, `Enter ${f.label.toLowerCase()}`);
        out[f.key] = v;
      }
      return out;
    };
    if (!b && m === 'POST') {
      const body = await readBody(req);
      const total = r2(body.total);
      if (!(total > 0)) throw new HttpErr(400, 'Enter the order total');
      if (!String(body.customer || '').trim()) throw new HttpErr(400, 'Enter the client name');
      let code = settings.orderIdMode === 'auto' ? '' : String(body.code || '').trim();
      if (!code) {
        if (settings.orderIdMode !== 'auto') throw new HttpErr(400, 'Enter the order ID');
        const n = orders.map(o => /^ORD-(\d+)$/.exec(o.code)).filter(Boolean).map(x => +x[1]); code = 'ORD-' + ((n.length ? Math.max(...n) : 1000) + 1);
      }
      const phoneDigits = tenDigits(body.phone);
      if (!phoneDigits) throw new HttpErr(400, 'Enter the customer’s 10-digit phone number', { badPhone: true });
      const same = orders.filter(o => o.phone && digits(o.phone).slice(-10) === phoneDigits.slice(-10) && o.status !== 'rejected');
      if (same.length && body.confirmSamePhone !== true) throw new HttpErr(409, `This phone number already has ${same.length === 1 ? 'order ' + same[0].code : same.length + ' orders'}. Is it the same customer?`, { samePhone: same.slice(0, 5).map(o => ({ code: o.code, customer: o.customer, status: o.status })) });
      if (!/^[A-Za-z0-9._-]{2,24}$/.test(code)) throw new HttpErr(400, 'Order ID can use letters, numbers, dot, dash and underscore');
      if (orders.some(o => lc(o.code) === lc(code))) throw new HttpErr(409, 'That order ID already exists. To add a payment to it, use Add payment.');
      const customerExtra = readExtra(body.customerExtra, {});
      const isMgr = RANK[me.role] >= RANK.manager;
      if (!body.firstPayment && !isMgr) throw new HttpErr(400, 'Add the first advance payment screenshot with the order');
      const due = parseDue(body, total);
      const firstAmt = body.firstPayment ? r2(body.firstPayment.amount) : 0;
      if (!due.schedule && !due.nextDue && body.skipDue !== true && r2(total - firstAmt) > 0.005) throw new HttpErr(400, 'Add the payment plan (a screenshot with the dates and amounts) or the next payment due date', { needDue: true });
      let first = null;
      if (body.firstPayment) first = await addPayment(me, { code, status: 'pending' }, { ...body.firstPayment, seq: 1 }, { first: true });
      const o = await db.insert('orders', { code, customer: String(body.customer).trim().slice(0, 80), total, status: isMgr ? 'open' : 'pending', note: String(body.note || '').slice(0, 200), item: String(body.item || '').trim().slice(0, 80), units: unitsOf(body.units), createdBy: me.name, createdById: me.id, customerExtra, phone: String(body.phone).trim().slice(0, 20), ...due, planImageId: body.planImageId && (await db.get('images', String(body.planImageId))) ? String(body.planImageId) : '' });
      await audit(me, 'order_created', 'order', o.code, `${o.customer}, total ${o.total}${o.status === 'pending' ? ', waiting for approval' : ''}`);
      if (o.status === 'open') await afterApprove(me, o, settings);
      else await notify('role:manager', `New order ${o.code} (${o.customer}, ${inr(o.total)}) is waiting for approval.`, o.code);
      return send(res, 200, { order: isMgr ? orderView(o, first ? [first.p] : []) : { code: o.code, customer: o.customer, status: 'pending' }, notice: first && first.notice });
    }
    const o = orders.find(x => lc(x.code) === lc(b));
    if (!o) throw new HttpErr(404, 'Order not found');
    const pays = await db.all('payments');
    if (!c && m === 'GET') {
      const mineP = pays.filter(p => p.orderCode === o.code); const accsList = (await getSettings()).accounts;
      return send(res, 200, { order: orderView(o, pays), payments: mineP.reverse().map(p => ({ ...p, validationNote: payNote(p), account: acctLabel(p, accsList) })), invoice: !!(await db.all('invoices')).find(i => i.orderCode === o.code), invoiceMode: (settings.business && settings.business.invoiceMode) || 'payment' });
    }
    if (resubmitting) {
      if (o.status !== 'rejected') throw new HttpErr(400, 'Only a rejected order can be sent again');
      if (o.createdById !== me.id && RANK[me.role] < RANK.manager) throw new HttpErr(403, 'This is not your order');
      const body = await readBody(req);
      const patch = { status: 'pending', rejectReason: '' };
      if (body.customer !== undefined) { if (!String(body.customer).trim()) throw new HttpErr(400, 'Enter the client name'); patch.customer = String(body.customer).trim().slice(0, 80); }
      if (body.total !== undefined) { const t = r2(body.total); if (!(t > 0)) throw new HttpErr(400, 'Enter a valid total'); patch.total = t; }
      patch.customerExtra = readExtra(body.customerExtra, o.customerExtra);
      if (body.item !== undefined) patch.item = String(body.item).trim().slice(0, 80);
      if (body.units !== undefined) patch.units = unitsOf(body.units);
      const n = await db.update('orders', o.id, patch);
      await audit(me, 'order_resubmitted', 'order', o.code, '');
      await notify('role:manager', `Order ${o.code} was corrected and sent again for approval.`, o.code);
      return send(res, 200, { order: { code: n.code, status: n.status } });
    }
    if (!c && m === 'PATCH') {
      const body = await readBody(req);
      if (me.role !== 'owner' && o.status !== 'pending') throw new HttpErr(403, 'This order is locked after approval. Use Adjust: a manager’s change goes to the owner.');
      const patch = {};
      if (body.customer !== undefined) patch.customer = String(body.customer).trim().slice(0, 80);
      if (body.note !== undefined) patch.note = String(body.note).slice(0, 200);
      if (body.total !== undefined) { const t = r2(body.total); if (!(t > 0)) throw new HttpErr(400, 'Enter a valid total'); if (t !== o.total) patch.total = t; }
      const n = await db.update('orders', o.id, patch);
      await audit(me, 'order_updated', 'order', o.code, Object.entries(patch).map(([k, v]) => `${k}: ${o[k]} -> ${v}`).join('; '));
      return send(res, 200, { order: orderView(n, pays) });
    }
    if (c === 'close' && m === 'POST') {
      const body = await readBody(req);
      const v = orderView(o, pays);
      const blockers = [];
      if (v.outstandingVerified > 0) blockers.push(`₹${v.outstandingVerified} is not yet verified`);
      if (v.flaggedCount) blockers.push(`${v.flaggedCount} flagged payment(s) need review`);
      if (v.pendingCash) blockers.push(`${v.pendingCash} cash entr${v.pendingCash > 1 ? 'ies' : 'y'} to approve`);
      if (blockers.length) {
        if (!(body.override && me.role === 'owner' && String(body.reason || '').trim().length >= 5)) throw new HttpErr(409, 'Cannot close: ' + blockers.join('; '), { blockers, canOverride: me.role === 'owner' });
        await audit(me, 'order_closed_override', 'order', o.code, 'Reason: ' + body.reason + '. ' + blockers.join('; '));
      } else await audit(me, 'order_closed', 'order', o.code, '');
      const n = await db.update('orders', o.id, { status: 'closed', closedAt: new Date().toISOString() });
      return send(res, 200, { order: orderView(n, pays) });
    }
    if (c === 'approve' && m === 'POST') {
      if (o.status !== 'pending') throw new HttpErr(400, 'This order is not waiting for approval');
      const body = await readBody(req);
      const mods = [], at = new Date().toISOString();
      const patch = { status: 'open', approvedBy: me.name, approvedAt: at };
      if (body.customer !== undefined && String(body.customer).trim() && String(body.customer).trim() !== o.customer) { patch.customer = String(body.customer).trim().slice(0, 80); mods.push({ field: 'client name', from: o.customer, to: patch.customer }); }
      if (body.total !== undefined && r2(body.total) !== o.total) { const t = r2(body.total); if (!(t > 0)) throw new HttpErr(400, 'Enter a valid total'); patch.total = t; mods.push({ field: 'total', from: o.total, to: t }); }
      if (body.customerExtra) { const ex = { ...(o.customerExtra || {}) }; for (const f of settings.customerFields) { const v = body.customerExtra[f.key]; if (v !== undefined && String(v).trim() && String(v).trim() !== ex[f.key]) { mods.push({ field: f.label.toLowerCase(), from: ex[f.key] || '', to: String(v).trim() }); ex[f.key] = String(v).trim().slice(0, 120); } } patch.customerExtra = ex; }
      if (mods.length) patch.modifications = [...(o.modifications || []), ...mods.map(x => ({ ...x, by: me.name, at, comment: String(body.comment || '').slice(0, 200) }))];
      const n = await db.update('orders', o.id, patch);
      await audit(me, mods.length ? 'order_modified_approved' : 'order_approved', 'order', o.code, mods.map(x => `${x.field}: ${x.from} -> ${x.to}`).join('; ') || `total ${n.total}`);
      if (o.createdById) await notify('user:' + o.createdById, mods.length ? `${o.code} was modified: ${mods.map(x => `${x.field} from ${x.from} to ${x.to}`).join(', ')}. It is approved now.` : `${o.code} was approved.`, o.code);
      await afterApprove(me, n, settings);
      return send(res, 200, { order: orderView(n, pays) });
    }
    if (c === 'reject' && m === 'POST') {
      if (o.status !== 'pending') throw new HttpErr(400, 'This order is not waiting for approval');
      const body = await readBody(req);
      if (!String(body.reason || '').trim()) throw new HttpErr(400, 'Give a reason for rejecting');
      const n = await db.update('orders', o.id, { status: 'rejected', rejectedBy: me.name, rejectReason: String(body.reason).slice(0, 200) });
      await audit(me, 'order_rejected', 'order', o.code, String(body.reason).slice(0, 200));
      if (o.createdById) await notify('user:' + o.createdById, `${o.code} was sent back: ${String(body.reason).slice(0, 120)}. Please fix it and send it again.`, o.code);
      return send(res, 200, { order: orderView(n, pays) });
    }
    if (c === 'adjust' && m === 'POST') {
      if (o.status !== 'open') throw new HttpErr(400, 'Only an open order can be adjusted');
      const body = await readBody(req);
      const v = orderView(o, pays);
      const kind = body.kind;
      const comment = String(body.comment || '').trim();
      if (comment.length < 3) throw new HttpErr(400, 'Add a comment explaining the change');
      const reqd = { orderCode: o.code, kind, comment: comment.slice(0, 200), by: me.name, byId: me.id, status: 'pending' };
      if (kind === 'close_offline') {
        if (!(v.outstanding > 0)) throw new HttpErr(400, 'Nothing is outstanding on this order');
        if (r2(body.amount) !== v.outstanding) throw new HttpErr(400, `The offline amount must equal the outstanding amount (${inr(v.outstanding)})`);
        reqd.amount = v.outstanding;
      } else if (kind === 'change_total') {
        const t = r2(body.newTotal);
        if (!(t > 0)) throw new HttpErr(400, 'Enter the new total');
        if (t < v.collected) throw new HttpErr(400, `The new total cannot be below what is collected (${inr(v.collected)})`);
        if (t === o.total) throw new HttpErr(400, 'That is the same total');
        reqd.newTotal = t; reqd.oldTotal = o.total;
      } else throw new HttpErr(400, 'Choose close with an offline amount, or change the total');
      if (me.role === 'owner') {
        const n = await applyAdjust(me, o, reqd, settings);
        return send(res, 200, { applied: true, order: orderView(n, await db.all('payments')) });
      }
      const r = await db.insert('requests', reqd);
      await audit(me, 'adjust_requested', 'order', o.code, `${kind} ${reqd.amount || reqd.newTotal}. ${comment}`);
      await notify('role:owner', `${me.name} asks to ${kind === 'close_offline' ? `close ${o.code} with ${inr(reqd.amount)} received offline` : `change ${o.code} total from ${inr(o.total)} to ${inr(reqd.newTotal)}`}: "${comment.slice(0, 100)}"`, o.code);
      return send(res, 200, { requested: true, id: r.id });
    }
    if (c === 'reopen' && m === 'POST') {
      const n = await db.update('orders', o.id, { status: 'open' });
      await audit(me, 'order_reopened', 'order', o.code, '');
      return send(res, 200, { order: orderView(n, pays) });
    }
  }

  // ----- payments
  if (a === 'payments') {
    if (b === 'mine' && m === 'GET') {
      const me = await authed(req, url, 'uploader');
      const mineP = (await db.all('payments')).filter(p => p.createdBy === me.id).reverse();
      return send(res, 200, { payments: mineP.map(p => ({ id: p.id, orderCode: p.orderCode, amount: p.amount, mode: p.mode, date: p.date, created: p.created, seq: p.seq })) });
    }
    if (!b && m === 'POST') {
      const me = await authed(req, url, 'uploader');
      const body = await readBody(req);
      const order = (await db.all('orders')).find(o => lc(o.code) === lc(body.orderCode));
      if (!order) throw new HttpErr(400, 'No order with that ID. Check the order ID.');
      if (order.status === 'closed') throw new HttpErr(400, 'That order is closed.');
      if (order.status === 'pending') throw new HttpErr(400, 'That order is waiting for manager approval.');
      if (order.status === 'rejected') throw new HttpErr(400, 'That order was sent back. Fix it and send it again first.');
      const v0 = orderView(order, await db.all('payments'));
      const hasPlan = !!(order.schedule && order.schedule.length);
      if (!hasPlan && !body.nextDue && body.skipDue !== true && !(Array.isArray(body.schedule) && body.schedule.length) && r2(order.total - v0.collected - r2(body.amount)) > 0.005) throw new HttpErr(400, 'Add the next payment due date', { needDue: true });
      const newDue = body.nextDue && !(order.schedule && order.schedule.length) && (order.createdById === me.id || RANK[me.role] >= RANK.manager) ? parseDue({ nextDue: body.nextDue }, order.total) : null;
      const { p, notice } = await addPayment(me, order, body);
      if (newDue) await db.update('orders', order.id, newDue);
      let planNote = '';
      if (Array.isArray(body.schedule) && body.schedule.length && !hasPlan) {
        if (body.schedule.length > 24) throw new HttpErr(400, 'Up to 24 instalments');
        const rows = body.schedule.map(r => ({ date: String((r && r.date) || ''), amount: r2(r && r.amount) }));
        if (rows.some(r => !isDay(r.date) || !(r.amount > 0))) throw new HttpErr(400, 'Each instalment needs a date and an amount');
        rows.sort((x, y) => x.date.localeCompare(y.date));
        const base = r2(v0.collected + r2(body.amount)), outAfter = r2(order.total - base), sum = r2(rows.reduce((t, r) => t + r.amount, 0));
        const planImageId = body.planImageId && (await db.get('images', body.planImageId)) ? String(body.planImageId) : '';
        if (Math.abs(sum - outAfter) < 0.005) {
          await applyAdjust(me, order, { kind: 'change_plan', schedule: rows, base, planImageId, comment: 'Payment plan added with a payment', byId: me.id, by: me.name }, await getSettings());
          planNote = 'Payment plan saved.';
        } else {
          const reason = `Plan adds up to ${inr(sum)} but ${inr(outAfter)} is due on ${order.code}. Does not match the order setup.`;
          const rq = await db.insert('requests', { orderCode: order.code, kind: 'change_plan', comment: reason, by: me.name, byId: me.id, status: 'pending', schedule: rows, base, planImageId, outstanding: outAfter, planTotal: sum });
          await audit(me, 'plan_change_requested', 'order', order.code, reason);
          await notify('role:owner', `${me.name} sent a payment plan for ${order.code} that does not match: ${reason}`, order.code);
          await notify('role:manager', `${me.name} sent a payment plan for ${order.code} that does not match: ${reason}`, order.code);
          planNote = 'The plan does not match what is due (' + inr(sum) + ' planned, ' + inr(outAfter) + ' due). It was sent to a manager or the owner to approve.';
        }
      }
      return send(res, 200, { planNote, payment: { id: p.id, orderCode: p.orderCode, amount: p.amount, mode: p.mode, seq: p.seq, flagged: p.status === 'flagged', needsOwner: p.approval === 'pending_owner' }, notice: [notice, planNote].filter(Boolean).join(' ') });
    }
    const me = await authed(req, url, 'manager');
    const orders = await db.all('orders');
    if (!b && m === 'GET') {
      let list = await db.all('payments');
      const st = url.searchParams.get('status'), oc = url.searchParams.get('order'), mo = url.searchParams.get('month');
      if (st === 'owner') list = list.filter(p => p.approval === 'pending_owner' && p.status !== 'rejected');
      else if (st) list = list.filter(p => p.status === st);
      if (oc) list = list.filter(p => lc(p.orderCode) === lc(oc));
      if (mo) list = list.filter(p => (p.date || '').startsWith(mo));
      return send(res, 200, { payments: list.reverse().map(p => withOrder(p, orders)) });
    }
    const p = await db.get('payments', b);
    if (!p) throw new HttpErr(404, 'Payment not found');
    const order = orders.find(o => o.code === p.orderCode);
    const body = ['confirm-cash', 'approve', 'verify', 'release', 'reject', 'flag'].includes(c) ? await readBody(req) : {};
    const done = async (patch, action, detail, event) => {
      const n = await db.update('payments', p.id, patch);
      await audit(me, action, 'payment', p.id, `${p.orderCode} ${p.amount}. ${detail || ''}`);
      await runConnectors(event || action, n, order || { code: p.orderCode }, me);
      await autoClose(me, p.orderCode);
      if (p.createdBy && p.createdBy !== me.id && ['payment_rejected', 'owner_approved'].includes(action)) await notify('user:' + p.createdBy, `${p.orderCode}: your ${inr(p.amount)} entry was ${action === 'owner_approved' ? 'approved' : 'rejected: ' + String(detail || '').slice(0, 80)}.`, p.orderCode);
      return send(res, 200, { payment: n });
    };
    if ((c === 'confirm-cash' || c === 'approve') && m === 'POST') {
      if (me.role !== 'owner') throw new HttpErr(403, 'Only the owner can approve this');
      if (p.status === 'cash_pending') return done({ status: 'cash_confirmed', approval: '', confirmedBy: me.name, confirmedById: me.id, confirmedAt: new Date().toISOString(), confirmNote: String(body.note || '').slice(0, 200) }, 'owner_approved', 'cash ' + (body.note || ''), 'cash_confirmed');
      if (p.approval === 'pending_owner') return done({ approval: '', approvedBy: me.name }, 'owner_approved', body.note, 'owner_approved');
      throw new HttpErr(409, 'Nothing to approve on this entry');
    }
    if (c === 'verify' && m === 'POST') {
      if (p.status !== 'client_reported') throw new HttpErr(409, 'This payment is not waiting for verification');
      if (p.createdBy === me.id) throw new HttpErr(403, 'You logged this entry, so someone else must verify it');
      if (String(body.note || '').trim().length < 5) throw new HttpErr(400, 'Write how you checked it (at least a few words)');
      return done({ status: 'verified', verifyMethod: 'manual', verifiedBy: me.name, verifiedAt: new Date().toISOString(), verifyNote: String(body.note).slice(0, 200) }, 'payment_verified_manual', body.note, 'verified');
    }
    if (c === 'release' && m === 'POST') {
      if (p.status !== 'flagged') throw new HttpErr(409, 'This payment is not flagged');
      const back = p.mode === 'cash' ? (p.approval === 'pending_owner' || me.role !== 'owner' ? 'cash_pending' : 'cash_confirmed') : 'client_reported';
      return done({ status: back, reason: '' }, 'flag_released', body.note, 'released');
    }
    if (c === 'reject' && m === 'POST') {
      if (String(body.reason || '').trim().length < 3) throw new HttpErr(400, 'Give a reason');
      return done({ status: 'rejected', rejectReason: String(body.reason).slice(0, 200) }, 'payment_rejected', body.reason, 'rejected');
    }
    if (c === 'flag' && m === 'POST') {
      if (String(body.reason || '').trim().length < 3) throw new HttpErr(400, 'Give a reason');
      return done({ status: 'flagged', reason: String(body.reason).slice(0, 80) }, 'payment_flagged', body.reason, 'flagged');
    }
  }

  // ----- notifications
  if (a === 'notifications') {
    const me = await authed(req, url, 'uploader');
    if (!b && m === 'GET') {
      const list = (await db.all('notifications')).filter(n => mine(n, me)).reverse().slice(0, 50);
      const isRead = n => (n.readBy || []).includes(me.id);
      return send(res, 200, { notifications: list.map(n => ({ id: n.id, text: n.text, orderCode: n.orderCode, created: n.created, read: isRead(n) })), unread: list.filter(n => !isRead(n)).length });
    }
    if (b === 'read' && m === 'POST') {
      for (const n of (await db.all('notifications')).filter(x => mine(x, me) && !(x.readBy || []).includes(me.id))) await db.update('notifications', n.id, { readBy: [...(n.readBy || []), me.id] });
      return send(res, 200, { ok: true });
    }
  }

  // ----- adjustment requests (owner decides)
  if (a === 'ideas') {
    const me = await authed(req, url, 'uploader');
    const all = (await db.all('requests')).filter(r => r.kind === 'idea');
    if (!b && m === 'GET') return send(res, 200, { ideas: (me.role === 'owner' ? all : all.filter(r => r.byId === me.id)).reverse().map(r => ({ id: r.id, type: r.type, text: r.text, manualSteps: r.manualSteps || '', flowImageId: r.flowImageId || '', rating: r.rating || '', by: r.by, status: r.status, reply: r.reply || '', created: r.created })) });
    if (!b && m === 'POST') {
      const body = await readBody(req);
      const type = body.type === 'problem' ? 'problem' : 'feedback';
      if (type === 'problem' && RANK[me.role] < RANK.manager) throw new HttpErr(403, 'Only owners and managers can send a business problem');
      const text = String(body.text || '').trim().slice(0, 2000);
      const rating = body.rating === 'up' || body.rating === 'down' ? body.rating : '';
      if (text.length < 5 && !body.flowImageId && !rating) throw new HttpErr(400, 'Write a few words, or upload your flow');
      const flowImageId = body.flowImageId && (await db.get('images', String(body.flowImageId))) ? String(body.flowImageId) : '';
      const kindLabel = ['idea', 'broken', 'confusing', 'praise'].includes(body.label) ? body.label : '';
      const r = await db.insert('requests', { kind: 'idea', type, label: kindLabel, rating, text, manualSteps: String(body.manualSteps || '').trim().slice(0, 2000), flowImageId, by: me.name, byId: me.id, byRole: me.role, status: 'received', reply: '' });
      await audit(me, type === 'problem' ? 'business_problem_sent' : 'feedback_sent', 'idea', r.id, text.slice(0, 80));
      return send(res, 200, { ok: true, id: r.id });
    }
  }
  if (a === 'requests') {
    const me = await authed(req, url, 'manager');
    if (!b && m === 'GET') return send(res, 200, { requests: (await db.all('requests')).filter(r => r.status === 'pending').reverse() });
    const r = await db.get('requests', b);
    if (!r || r.status !== 'pending') throw new HttpErr(404, 'Request not found');
    if (me.role !== 'owner' && r.kind !== 'change_plan') throw new HttpErr(403, 'Only the owner can decide this');
    const o = (await db.all('orders')).find(x => x.code === r.orderCode);
    if (c === 'approve' && m === 'POST') {
      if (!o || o.status !== 'open') throw new HttpErr(400, 'That order is no longer open');
      await applyAdjust(me, o, r, await getSettings());
      await db.update('requests', r.id, { status: 'approved', decidedBy: me.name });
      return send(res, 200, { ok: true });
    }
    if (c === 'reject' && m === 'POST') {
      await db.update('requests', r.id, { status: 'rejected', decidedBy: me.name });
      await audit(me, 'adjust_rejected', 'order', r.orderCode, r.comment);
      if (r.byId) await notify('user:' + r.byId, `Your change to ${r.orderCode} was not approved.`, r.orderCode);
      return send(res, 200, { ok: true });
    }
  }

  // ----- invoices
  if (a === 'invoices' && b && m === 'GET') {
    await authed(req, url, 'uploader');
    const o = (await db.all('orders')).find(x => lc(x.code) === lc(b));
    const inv = (await db.all('invoices')).find(i => o && i.orderCode === o.code);
    if (!o || !inv) throw new HttpErr(404, 'No invoice for this order yet');
    const pays = (await db.all('payments')).filter(p => p.orderCode === o.code);
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const st = await getSettings(), pid = url.searchParams.get('p'), one = pid ? pays.find(x => x.id === pid && x.status !== 'rejected') : null;
    if (pid && !one) throw new HttpErr(404, 'No such payment on this order');
    if (one) { const upto = pays.filter(x => x.status !== 'rejected' && (x.seq || 0) <= (one.seq || 0)); const vv = orderView(o, upto); return res.end(invoiceHtml(o, vv, { ...inv, no: inv.no + '-' + (one.seq || 1) }, st, [one], true)); }
    return res.end(invoiceHtml(o, orderView(o, pays), inv, st, pays));
  }

  // ----- reports (owner)
  if (a === 'reports' && m === 'GET') {
    const me = await authed(req, url, 'owner');
    const rawP = url.searchParams.get('period') || 'all';
    const per = /^\d{4}(-\d{2})?$/.test(rawP) || rawP === 'all' ? rawP : 'all';
    const pays = await db.all('payments');
    const rows = (await db.all('orders')).filter(o => o.status !== 'pending' && o.status !== 'rejected' && (per === 'all' || (o.created || '').startsWith(per))).map(o => orderView(o, pays));
    const t = f => r2(rows.reduce((s, o) => s + f(o), 0));
    const out = { period: per, orders: rows.length, revenue: t(o => o.total), collected: t(o => o.collected), outstanding: t(o => o.outstanding), validated: t(o => o.validated), manual: t(o => o.manual), notValidated: t(o => o.notValidated) };
    if (url.searchParams.get('csv') === '1') {
      const q = x => '"' + String(x == null ? '' : x).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"';
      const head = ['Order', 'Client', 'Status', 'Total', 'Collected', 'Outstanding', 'Validated', 'Manually validated', 'Not validated'];
      const lines = [head.map(q).join(',')].concat(rows.map(o => [o.code, o.customer, o.status, o.total, o.collected, o.outstanding, o.validated, o.manual, o.notValidated].map(q).join(',')));
      await db.update('settings', 'main', { lastExportAt: new Date().toISOString(), lastExportById: me.id }).catch(() => {});
      if (!(await db.get('settings', 'main'))) await db.insert('settings', { id: 'main', lastExportAt: new Date().toISOString(), lastExportById: me.id });
      await audit(me, 'report_downloaded', 'report', per, `${rows.length} orders`);
      res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="report-${per}.csv"`);
      return res.end(lines.join('\n'));
    }
    return send(res, 200, { report: out, orders: rows });
  }

  // ----- clear data (owner): closed orders' invoice files and screenshots only
  if (a === 'data' && b === 'clear' && m === 'POST') {
    const me = await authed(req, url, 'owner');
    const body = await readBody(req);
    const st = await getSettings();
    const fresh = st.lastExportAt && Date.now() - Date.parse(st.lastExportAt) < 30 * 60 * 1000;
    if (!fresh) throw new HttpErr(409, 'Download the report first. Then you can clear.', { needDownload: true });
    if (body.confirm !== true) throw new HttpErr(409, 'This cannot be undone. Confirm to clear invoice files and screenshots of closed orders. Order records and totals stay.', { needConfirm: true });
    const closed = new Set((await db.all('orders')).filter(o => o.status === 'closed').map(o => o.code));
    let inv = 0, img = 0;
    for (const i of await db.all('invoices')) if (closed.has(i.orderCode)) { await db.remove('invoices', i.id); inv++; }
    for (const p of await db.all('payments')) if (closed.has(p.orderCode) && p.imageId) { await db.remove('images', p.imageId); await db.update('payments', p.id, { imageId: '', imageCleared: true }); img++; }
    await audit(me, 'data_cleared', 'data', 'closed', `${inv} invoice files, ${img} screenshots`);
    return send(res, 200, { invoices: inv, screenshots: img });
  }

  // ----- backup (owner): everything in one file, kept as evidence. Passwords, keys and screenshot files are left out.
  if (a === 'data' && b === 'backup' && m === 'GET') {
    const me = await authed(req, url, 'owner');
    const trim = v => typeof v === 'string' ? (v.length > 20000 ? '[file left out of the backup]' : v) : Array.isArray(v) ? v.map(trim) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(pw|key|secret)$/i.test(k) ? '[removed]' : trim(x)])) : v;
    const tables = {};
    for (const t of ['users', 'orders', 'payments', 'audit', 'notifications', 'requests', 'invoices', 'images', 'settings']) tables[t] = (await db.all(t)).map(trim);
    const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    await db.update('settings', 'main', { lastBackupAt: new Date().toISOString() }).catch(() => {});
    if (!(await db.get('settings', 'main'))) await db.insert('settings', { id: 'main', lastBackupAt: new Date().toISOString() });
    await audit(me, 'backup_downloaded', 'data', 'all', Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
    return send(res, 200, { app: 'Payment Control', exportedAt: new Date().toISOString(), exportedBy: me.name, counts, tables });
  }

  // ----- start fresh (owner): removes every order, payment, request, file and login. Settings stay. Needs a backup in the last 30 minutes.
  if (a === 'data' && b === 'start-fresh' && m === 'POST') {
    const me = await authed(req, url, 'owner');
    const body = await readBody(req);
    const st = (await db.get('settings', 'main')) || {};
    if (!(st.lastBackupAt && Date.now() - Date.parse(st.lastBackupAt) < 30 * 60 * 1000)) throw new HttpErr(409, 'Download the backup first. Then you can start fresh.', { needBackup: true });
    if (body.confirm !== 'START FRESH') throw new HttpErr(409, 'Type START FRESH to confirm. This removes every order, payment, request and login, and cannot be undone.', { needConfirm: true });
    const gone = {};
    for (const t of ['orders', 'payments', 'audit', 'notifications', 'requests', 'invoices', 'images', 'users']) { let n = 0; for (const r of await db.all(t)) { await db.remove(t, r.id); n++; } gone[t] = n; }
    await db.update('settings', 'main', { noDemo: true }).catch(() => {});
    await audit(null, 'started_fresh', 'data', 'all', Object.entries(gone).map(([k, v]) => `${k} ${v}`).join(', ') + '. Done by ' + me.name);
    return send(res, 200, { removed: gone });
  }

  // ----- summary
  if (a === 'summary' && m === 'GET') {
    await authed(req, url, 'manager');
    const rawP = url.searchParams.get('period') || url.searchParams.get('month') || '';
    const month = /^\d{4}-\d{2}$/.test(rawP) || /^\d{4}$/.test(rawP) || rawP === 'all' ? rawP : new Date().toISOString().slice(0, 7);
    const orders = await db.all('orders');
    const pays = await db.all('payments');
    const views = orders.map(o => orderView(o, pays));
    const open = views.filter(o => o.status === 'open');
    const acctSel = url.searchParams.get('account') || 'all';
    const inAcct = p => acctSel === 'all' || (acctSel === 'cash' ? p.mode === 'cash' : acctSel === 'unmatched' ? (p.mode !== 'cash' && !p.accountId) : p.accountId === acctSel);
    const inMonth = pays.filter(p => (month === 'all' || (p.date || '').startsWith(month)) && p.status !== 'rejected' && inAcct(p));
    const cnt = inMonth.filter(p => p.status !== 'flagged');
    const sum = f => r2(inMonth.filter(f).reduce((s, p) => s + p.amount, 0));
    const live = pays.filter(p => p.status !== 'rejected' && inAcct(p));
    return send(res, 200, {
      month, account: acctSel, accounts: (await getSettings()).accounts,
      outstanding: r2(open.reduce((s, o) => s + o.outstanding, 0)),
      outstandingVerifiedOnly: r2(open.reduce((s, o) => s + o.outstandingVerified, 0)),
      pendingOrders: views.filter(o => o.status === 'pending').length,
      openOrders: open.length, closedOrders: views.length - open.length,
      awaiting: r2(live.filter(p => UNVERIFIED.includes(p.status) && p.mode !== 'cash').reduce((s, p) => s + p.amount, 0)),
      received: r2(cnt.reduce((s, p) => s + p.amount, 0)),
      receivedCash: r2(cnt.filter(p => p.mode === 'cash').reduce((s, p) => s + p.amount, 0)),
      receivedOnline: r2(cnt.filter(p => p.mode !== 'cash').reduce((s, p) => s + p.amount, 0)),
      byStatus: { verified: sum(p => VERIFIED.includes(p.status)), awaiting: sum(p => UNVERIFIED.includes(p.status)), flagged: sum(p => p.status === 'flagged') },
      flaggedCount: live.filter(p => p.status === 'flagged').length,
      ownerPending: live.filter(p => p.approval === 'pending_owner' || p.status === 'cash_pending').length,
      adjustRequests: (await db.all('requests')).filter(r => r.status === 'pending').length,
      validatedTotal: r2(views.reduce((x, o) => x + o.validated, 0)), manualTotal: r2(views.reduce((x, o) => x + o.manual, 0)), notValidatedTotal: r2(views.reduce((x, o) => x + o.notValidated, 0)),
      cashPendingCount: live.filter(p => p.status === 'cash_pending').length,
      cashPendingAmount: r2(live.filter(p => p.status === 'cash_pending').reduce((s, p) => s + p.amount, 0)),
      dues: (() => { const today = todayIST(), wk = new Date(Date.parse(today + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10); const out = []; for (const v of open) { const raw = orders.find(x => x.code === v.code); const d = raw && dueInfo(raw, v.collected, v.outstanding); if (!d) continue; const tm = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); const bucket = d.date < today ? 'overdue' : d.date === today ? 'today' : d.date === tm ? 'tomorrow' : d.date <= wk ? 'week' : ''; if (bucket) out.push({ code: v.code, customer: v.customer, phone: v.phone || '', date: d.date, amount: d.amount, bucket }); } return out.sort((a, b) => a.date.localeCompare(b.date)); })(),
      top: open.filter(o => o.outstanding > 0).sort((x, y) => y.outstanding - x.outstanding).slice(0, 8),
    });
  }

  // ----- bank statement matching
  if (a === 'statement' && m === 'POST') {
    const me = await authed(req, url, 'manager');
    const body = await readBody(req);
    const rows = (Array.isArray(body.rows) ? body.rows : []).map(r => ({ date: String(r.date || '').slice(0, 10), amount: r2(r.amount), ref: String(r.ref || '').slice(0, 120), desc: String(r.desc || '').slice(0, 200) })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.amount > 0);
    if (!rows.length) throw new HttpErr(400, 'No credits found in that statement');
    // Whose account is this? The owner lists the business accounts in Settings; each statement must be for one of them.
    const stSettings = await getSettings(); let acct = null, acctProof = '';
    if (stSettings.accounts.length) {
      acct = stSettings.accounts.find(x => x.id === body.accountId) || (stSettings.accounts.length === 1 ? stSettings.accounts[0] : null);
      if (!acct) throw new HttpErr(400, 'Choose which business account this statement is for', { needAccount: true });
      const head = String(body.headText || '').slice(0, 6000), low = head.toLowerCase();
      const shows = [...head.matchAll(/(?:a\/c|acct|account)[^\n\d]{0,30}((?:[\dXx*•\-\s]){6,24})/gi)].map(m => m[1].replace(/\D/g, '')).filter(d => d.length >= 4);
      const endsRight = new RegExp('(?:^|\\D)[\\dXx*•]{0,20}' + acct.last4 + '(?!\\d)').test(head);
      const words = t => String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
      const nameShown = words(acct.name).length > 0 && words(acct.name).every(w => low.includes(w));
      const bankShown = words(acct.bank).length > 0 && words(acct.bank).every(w => low.includes(w));
      if (shows.length && !shows.some(d => d.endsWith(acct.last4)) && !endsRight) throw new HttpErr(409, `This statement shows a different account (ending ${shows[0].slice(-4)}), not ${acct.name} ending ${acct.last4}. It may be a personal or another account. Nothing was marked validated.`, { wrongAccount: true });
      const missing = [!endsRight && 'last 4 digits', !nameShown && 'account name', !bankShown && 'bank name'].filter(Boolean);
      if (!missing.length) acctProof = 'last 4 digits, account name and bank all shown on the statement';
      else if (body.confirmed === true) acctProof = 'confirmed by ' + me.name + ' (the file does not show: ' + missing.join(', ') + ')';
      else throw new HttpErr(409, `The statement does not show the ${missing.join(', ')} of ${acct.name} ending ${acct.last4}. If you are sure it is that account, tick the box to confirm.`, { needConfirm: true, missing });
    }
    if (rows.length > 5000) throw new HttpErr(400, 'Statement is too large. Upload one month at a time.');
    const dates = rows.map(r => r.date).sort();
    const from = dates[0], to = dates[dates.length - 1];
    const day = d => Math.floor(Date.parse(d.slice(0, 10) + 'T00:00:00Z') / 86400000);
    const pays = (await db.all('payments')).filter(p => p.mode !== 'cash' && p.mode !== 'card' && p.status === 'client_reported');
    const used = new Set();
    const allOrders = await db.all('orders');
    const matched = [], flagged = [];
    const findRow = (p, strong) => rows.findIndex((r, i) => !used.has(i) && Math.abs(r.amount - p.amount) < 0.005 && (strong ? (p.txnId && (r.ref + ' ' + r.desc).toLowerCase().includes(p.txnId.toLowerCase())) : Math.abs(day(r.date) - day(p.date)) <= 2));
    const inRange = p => p.date.slice(0, 10) >= from && p.date.slice(0, 10) <= to;
    const sorted = [...pays].filter(inRange);
    for (const p of sorted) { const i = findRow(p, true); if (i >= 0) { used.add(i); p._m = { i, how: 'reference' }; } }
    for (const p of sorted) { if (p._m) continue; const i = findRow(p, false); if (i >= 0) { used.add(i); p._m = { i, how: 'amount and date' }; } }
    for (const p of sorted) {
      if (p._m) {
        await db.update('payments', p.id, { ...(acct ? { accountId: acct.id } : {}), status: 'verified', reason: '', verifyMethod: 'statement', stmtUnableAt: '', verifiedBy: me.name, verifiedAt: new Date().toISOString(), accountProof: acctProof, verifyNote: 'Matched on ' + p._m.how + ' with statement credit dated ' + rows[p._m.i].date + '. ' + matchChecks(p, rows[p._m.i]) });
        await audit(me, 'payment_verified_statement', 'payment', p.id, `${p.orderCode} ${p.amount} matched on ${p._m.how}`);
        matched.push({ id: p.id, orderCode: p.orderCode, amount: p.amount, how: p._m.how });
        await runConnectors('verified', { ...p, status: 'verified' }, allOrders.find(o => o.code === p.orderCode) || { code: p.orderCode }, me);
        await autoClose(me, p.orderCode);
      } else if (p.status === 'client_reported') {
        const sameId = p.txnId ? rows.find(r => (r.ref + ' ' + r.desc).toLowerCase().includes(p.txnId.toLowerCase())) : null;
        const sameAmt = rows.find(r => Math.abs(r.amount - p.amount) < 0.005);
        const why = sameId && Math.abs(sameId.amount - p.amount) >= 0.005 ? `the bank credit with this transaction ID is ${inr(sameId.amount)}, not ${inr(p.amount)}` : sameAmt && p.txnId ? 'a credit of the same amount exists but its transaction ID does not match' : sameAmt ? 'a credit of the same amount exists but there is no transaction ID to confirm it' : p.txnId ? `no bank credit with this transaction ID or amount between ${from} and ${to}` : `no bank credit of this amount between ${from} and ${to}`;
        await db.update('payments', p.id, { stmtUnableAt: new Date().toISOString(), stmtReason: why });
        await audit(me, 'payment_unable_to_validate', 'payment', p.id, `${p.orderCode} ${p.amount} not found in statement ${from} to ${to}`);
        flagged.push({ id: p.id, orderCode: p.orderCode, amount: p.amount, reason: why });
      }
    }
    const unmatchedCredits = rows.filter((r, i) => !used.has(i));
    await audit(me, 'statement_checked', 'statement', from + ' to ' + to, `${rows.length} credits, ${matched.length} matched, ${flagged.length} flagged, ${unmatchedCredits.length} credits without a payment record`);
    return send(res, 200, { range: { from, to }, credits: rows.length, matched, flagged, untouched: pays.length - sorted.length, unmatchedCredits: unmatchedCredits.slice(0, 200) });
  }

  // ----- audit log
  if (a === 'audit' && m === 'GET') {
    await authed(req, url, 'manager');
    const lim = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    return send(res, 200, { audit: (await db.all('audit')).reverse().slice(0, lim) });
  }

  throw new HttpErr(404, 'Not found');
}

module.exports = async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    if (e instanceof HttpErr) return send(res, e.code, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
};
module.exports.route = route;
