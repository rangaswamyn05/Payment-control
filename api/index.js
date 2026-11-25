'use strict';
// One serverless function handles every /api/* route (keeps us inside Vercel's free function limit).
const db = require('./_lib/db');
const A = require('./_lib/auth');
const { parseUpi } = require('./_lib/parse');
const { dispatch, validateUrl } = require('./_lib/connectors');

const RANK = { uploader: 1, manager: 2, owner: 3 };
const VERIFIED = ['verified', 'cash_confirmed'];
const UNVERIFIED = ['client_reported', 'cash_pending'];
const MODES = ['upi', 'transfer', 'cash'];
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
  if (users.length || process.env.NO_DEMO === '1') return;
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
function sums(pays) {
  const s = { verified: 0, unverified: 0, flagged: 0 };
  for (const p of pays) {
    if (VERIFIED.includes(p.status)) s.verified += p.amount;
    else if (UNVERIFIED.includes(p.status)) s.unverified += p.amount;
    else if (p.status === 'flagged') s.flagged += p.amount;
  }
  s.verified = r2(s.verified); s.unverified = r2(s.unverified); s.flagged = r2(s.flagged);
  return s;
}

function orderView(o, allPays) {
  const pays = allPays.filter(p => p.orderCode === o.code);
  const s = sums(pays);
  const claimed = r2(s.verified + s.unverified);
  return {
    id: o.id, code: o.code, customer: o.customer, total: o.total, status: o.status, note: o.note || '', created: o.created, demo: !!o.demo,
    verified: s.verified, awaiting: s.unverified, flagged: s.flagged,
    outstanding: r2(Math.max(0, o.total - claimed)),
    outstandingVerified: r2(Math.max(0, o.total - s.verified)),
    payments: pays.length,
    pendingCash: pays.filter(p => p.status === 'cash_pending').length,
    flaggedCount: pays.filter(p => p.status === 'flagged').length,
  };
}

const withOrder = (p, orders) => { const o = orders.find(x => x.code === p.orderCode); return { ...p, customer: o ? o.customer : '' }; };

function normDate(d) {
  d = String(d || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(d)) return null;
  const t = Date.parse(d.length === 10 ? d + 'T00:00' : d);
  if (isNaN(t)) return null;
  if (t > Date.now() + 36 * 3600 * 1000) return 'future';
  return d;
}

async function getSettings() {
  const s = await db.get('settings', 'main');
  return s || { id: 'main', businessName: '', managerEmails: [], connectors: { api: { enabled: false, url: '', key: '' } } };
}

async function runConnectors(event, payment, order, me) {
  try {
    const settings = await getSettings();
    const results = await dispatch(event, payment, order, settings);
    for (const r of results) await audit(me, 'connector_' + (r.ok ? 'ok' : 'failed'), 'payment', payment.id, `${r.connector} ${event} ${r.status || r.error || ''}`);
    return results;
  } catch (e) { return []; }
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
    await ensureSeed();
    const users = await db.all('users');
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
  if (a === 'settings') {
    if (m === 'GET') {
      const me = await authed(req, url, 'manager');
      const s = await getSettings();
      const api = (s.connectors && s.connectors.api) || {};
      return send(res, 200, { settings: { businessName: s.businessName || '', managerEmails: s.managerEmails || [], connectors: { api: { enabled: !!api.enabled, url: me.role === 'owner' ? api.url || '' : '', keySet: !!api.key } } } });
    }
    if (m === 'PUT') {
      const me = await authed(req, url, 'owner');
      const body = await readBody(req);
      const cur = await getSettings();
      const curApi = (cur.connectors && cur.connectors.api) || {};
      const inApi = (body.connectors && body.connectors.api) || {};
      if (inApi.url) { const bad = validateUrl(inApi.url); if (bad) throw new HttpErr(400, bad); }
      const next = {
        id: 'main',
        businessName: String(body.businessName || '').slice(0, 80),
        managerEmails: (Array.isArray(body.managerEmails) ? body.managerEmails : []).map(x => String(x).trim()).filter(x => /^\S+@\S+\.\S+$/.test(x)).slice(0, 5),
        connectors: { api: { enabled: !!inApi.enabled, url: inApi.url !== undefined ? String(inApi.url).trim() : curApi.url || '', key: inApi.key ? String(inApi.key) : curApi.key || '' } },
      };
      if (await db.get('settings', 'main')) await db.update('settings', 'main', next); else await db.insert('settings', next);
      await audit(me, 'settings_updated', 'settings', 'main', 'API connector ' + (next.connectors.api.enabled ? 'on' : 'off'));
      return send(res, 200, { ok: true });
    }
    if (b === 'test-api' && m === 'POST') {
      const me = await authed(req, url, 'owner');
      const s = await getSettings();
      const api = s.connectors.api;
      if (!api || !api.url) throw new HttpErr(400, 'Save the API URL first');
      const bad = validateUrl(api.url); if (bad) throw new HttpErr(400, bad);
      const r = await dispatch('test', { id: 'test', amount: 1, mode: 'upi', date: new Date().toISOString().slice(0, 16), txnId: 'TEST', status: 'client_reported' }, { code: 'TEST' }, { connectors: { api: { ...api, enabled: true } } });
      await audit(me, 'api_test', 'settings', 'main', JSON.stringify(r[0] || {}));
      return send(res, 200, { result: r[0] || null });
    }
  }

  // ----- images
  if (a === 'images') {
    if (!b && m === 'POST') {
      const me = await authed(req, url, 'uploader');
      const body = await readBody(req);
      const mt = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
      if (!mt) throw new HttpErr(400, 'Please choose a photo or screenshot (JPG, PNG or WebP)');
      if (mt[2].length > 4.2e6) throw new HttpErr(413, 'That image is too large');
      const img = await db.insert('images', { dataUrl: body.dataUrl, createdBy: me.id });
      return send(res, 200, { id: img.id });
    }
    if (b && m === 'GET') {
      const me = await authed(req, url, 'uploader');
      const img = await db.get('images', b);
      if (!img || (RANK[me.role] < RANK.manager && img.createdBy !== me.id)) throw new HttpErr(404, 'Not found');
      const mt = /^data:(image\/[a-z]+);base64,(.*)$/.exec(img.dataUrl);
      res.statusCode = 200; res.setHeader('Content-Type', mt[1]); res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.end(Buffer.from(mt[2], 'base64'));
    }
  }

  // ----- screenshot reading
  if (a === 'ocr' && m === 'POST') {
    const me = await authed(req, url, 'uploader');
    const body = await readBody(req);
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
    return send(res, 200, { configured: true, parsed: parseUpi(text) });
  }

  // ----- orders
  if (a === 'orders') {
    if (b === 'lookup' && c && m === 'GET') {
      await authed(req, url, 'uploader');
      const o = (await db.all('orders')).find(x => lc(x.code) === lc(c));
      if (!o) throw new HttpErr(404, 'No order with that ID');
      return send(res, 200, { code: o.code, customer: o.customer, closed: o.status === 'closed' });
    }
    const me = await authed(req, url, 'manager');
    const orders = await db.all('orders');
    if (!b && m === 'GET') {
      const pays = await db.all('payments');
      return send(res, 200, { orders: orders.map(o => orderView(o, pays)).reverse() });
    }
    if (!b && m === 'POST') {
      const body = await readBody(req);
      const total = r2(body.total);
      if (!(total > 0)) throw new HttpErr(400, 'Enter the order total');
      if (!String(body.customer || '').trim()) throw new HttpErr(400, 'Enter the client name');
      let code = String(body.code || '').trim();
      if (!code) { const n = orders.map(o => /^ORD-(\d+)$/.exec(o.code)).filter(Boolean).map(x => +x[1]); code = 'ORD-' + ((n.length ? Math.max(...n) : 1000) + 1); }
      if (!/^[A-Za-z0-9._-]{2,24}$/.test(code)) throw new HttpErr(400, 'Order ID can use letters, numbers, dot, dash and underscore');
      if (orders.some(o => lc(o.code) === lc(code))) throw new HttpErr(409, 'That order ID already exists');
      const o = await db.insert('orders', { code, customer: String(body.customer).trim().slice(0, 80), total, status: 'open', note: String(body.note || '').slice(0, 200), createdBy: me.name });
      await audit(me, 'order_created', 'order', o.code, `${o.customer}, total ${o.total}`);
      return send(res, 200, { order: orderView(o, []) });
    }
    const o = orders.find(x => lc(x.code) === lc(b));
    if (!o) throw new HttpErr(404, 'Order not found');
    const pays = await db.all('payments');
    if (!c && m === 'GET') {
      const mine = pays.filter(p => p.orderCode === o.code);
      return send(res, 200, { order: orderView(o, pays), payments: mine.reverse() });
    }
    if (!c && m === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (body.customer !== undefined) patch.customer = String(body.customer).trim().slice(0, 80);
      if (body.note !== undefined) patch.note = String(body.note).slice(0, 200);
      if (body.total !== undefined) {
        const t = r2(body.total);
        if (!(t > 0)) throw new HttpErr(400, 'Enter a valid total');
        if (t !== o.total) {
          if (pays.some(p => p.orderCode === o.code && p.status !== 'rejected') && me.role !== 'owner') throw new HttpErr(403, 'Only the owner can change the total once payments exist');
          patch.total = t;
        }
      }
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
      if (v.pendingCash) blockers.push(`${v.pendingCash} cash entr${v.pendingCash > 1 ? 'ies' : 'y'} to confirm`);
      if (blockers.length) {
        if (!(body.override && me.role === 'owner' && String(body.reason || '').trim().length >= 5)) throw new HttpErr(409, 'Cannot close: ' + blockers.join('; '), { blockers, canOverride: me.role === 'owner' });
        await audit(me, 'order_closed_override', 'order', o.code, 'Reason: ' + body.reason + '. ' + blockers.join('; '));
      } else await audit(me, 'order_closed', 'order', o.code, '');
      const n = await db.update('orders', o.id, { status: 'closed', closedAt: new Date().toISOString() });
      return send(res, 200, { order: orderView(n, pays) });
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
      const mine = (await db.all('payments')).filter(p => p.createdBy === me.id).reverse();
      return send(res, 200, { payments: mine.map(p => ({ id: p.id, orderCode: p.orderCode, amount: p.amount, mode: p.mode, date: p.date, created: p.created })) });
    }
    if (!b && m === 'POST') {
      const me = await authed(req, url, 'uploader');
      const body = await readBody(req);
      const orders = await db.all('orders');
      const order = orders.find(o => lc(o.code) === lc(body.orderCode));
      if (!order) throw new HttpErr(400, 'No order with that ID. Check the order ID.');
      if (order.status === 'closed') throw new HttpErr(400, 'That order is closed.');
      const mode = lc(body.mode);
      if (!MODES.includes(mode)) throw new HttpErr(400, 'Choose UPI, bank transfer or cash');
      const amount = r2(body.amount);
      if (!(amount > 0) || amount > 1e9) throw new HttpErr(400, 'Enter the amount');
      const date = normDate(body.date);
      if (!date) throw new HttpErr(400, 'Enter the payment date');
      if (date === 'future') throw new HttpErr(400, 'That date is in the future');
      if (mode !== 'cash' && !body.imageId && me.role === 'uploader') throw new HttpErr(400, 'Attach the payment screenshot');
      if (body.imageId && !(await db.get('images', body.imageId))) throw new HttpErr(400, 'Screenshot not found, please attach it again');
      const txnId = String(body.txnId || '').trim().slice(0, 40);
      const payee = String(body.payee || '').trim().slice(0, 80);
      const all = (await db.all('payments')).filter(p => p.status !== 'rejected');
      if (txnId && mode !== 'cash') {
        const d = all.find(p => p.txnId && lc(p.txnId) === lc(txnId));
        if (d) throw new HttpErr(409, `This payment is already recorded (order ${d.orderCode}).`, { duplicate: true });
      }
      let status = mode === 'cash' ? 'cash_pending' : 'client_reported';
      let reason = '';
      const dup = !txnId && mode !== 'cash' && all.find(p => p.mode === mode && p.amount === amount && (p.date === date || (p.orderCode === order.code && p.date.slice(0, 10) === date.slice(0, 10))));
      if (dup) { status = 'flagged'; reason = 'possible_duplicate'; }
      const p = await db.insert('payments', {
        orderCode: order.code, mode, amount, date, txnId, payer: String(body.payer || '').trim().slice(0, 80), payee,
        imageId: body.imageId || '', note: String(body.note || '').slice(0, 200), status, reason,
        createdBy: me.id, createdByName: me.name, ocr: body.ocr ? String(body.ocr).slice(0, 20) : '',
      });
      await audit(me, 'payment_added', 'payment', p.id, `${order.code} ${mode} ${amount} ${status}`);
      const cn = await runConnectors('created', p, order, me);
      return send(res, 200, { payment: { id: p.id, orderCode: p.orderCode, amount: p.amount, mode: p.mode, flagged: status === 'flagged' }, connectors: cn });
    }
    const me = await authed(req, url, 'manager');
    const orders = await db.all('orders');
    if (!b && m === 'GET') {
      let list = await db.all('payments');
      const st = url.searchParams.get('status'), oc = url.searchParams.get('order'), mo = url.searchParams.get('month');
      if (st) list = list.filter(p => p.status === st);
      if (oc) list = list.filter(p => lc(p.orderCode) === lc(oc));
      if (mo) list = list.filter(p => (p.date || '').startsWith(mo));
      return send(res, 200, { payments: list.reverse().map(p => withOrder(p, orders)) });
    }
    const p = await db.get('payments', b);
    if (!p) throw new HttpErr(404, 'Payment not found');
    const order = orders.find(o => o.code === p.orderCode);
    const body = ['confirm-cash', 'verify', 'release', 'reject', 'flag'].includes(c) ? await readBody(req) : {};
    const done = async (patch, action, detail, event) => {
      const n = await db.update('payments', p.id, patch);
      await audit(me, action, 'payment', p.id, `${p.orderCode} ${p.amount}. ${detail || ''}`);
      await runConnectors(event || action, n, order || { code: p.orderCode }, me);
      return send(res, 200, { payment: n });
    };
    if (c === 'confirm-cash' && m === 'POST') {
      if (p.status !== 'cash_pending') throw new HttpErr(409, 'This cash entry is not waiting for confirmation');
      if (p.createdBy === me.id) throw new HttpErr(403, 'You logged this entry, so someone else must confirm it');
      return done({ status: 'cash_confirmed', confirmedBy: me.name, confirmedById: me.id, confirmedAt: new Date().toISOString(), confirmNote: String(body.note || '').slice(0, 200) }, 'cash_confirmed', body.note, 'cash_confirmed');
    }
    if (c === 'verify' && m === 'POST') {
      if (p.status !== 'client_reported') throw new HttpErr(409, 'This payment is not waiting for verification');
      if (p.createdBy === me.id) throw new HttpErr(403, 'You logged this entry, so someone else must verify it');
      if (String(body.note || '').trim().length < 5) throw new HttpErr(400, 'Write how you checked it (at least a few words)');
      return done({ status: 'verified', verifyMethod: 'manual', verifiedBy: me.name, verifiedAt: new Date().toISOString(), verifyNote: String(body.note).slice(0, 200) }, 'payment_verified_manual', body.note, 'verified');
    }
    if (c === 'release' && m === 'POST') {
      if (p.status !== 'flagged') throw new HttpErr(409, 'This payment is not flagged');
      const back = p.mode === 'cash' ? 'cash_pending' : 'client_reported';
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

  // ----- summary
  if (a === 'summary' && m === 'GET') {
    await authed(req, url, 'manager');
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : new Date().toISOString().slice(0, 7);
    const orders = await db.all('orders');
    const pays = await db.all('payments');
    const views = orders.map(o => orderView(o, pays));
    const open = views.filter(o => o.status === 'open');
    const inMonth = pays.filter(p => (p.date || '').startsWith(month) && p.status !== 'rejected');
    const cnt = inMonth.filter(p => p.status !== 'flagged');
    const sum = f => r2(inMonth.filter(f).reduce((s, p) => s + p.amount, 0));
    const live = pays.filter(p => p.status !== 'rejected');
    return send(res, 200, {
      month,
      outstanding: r2(open.reduce((s, o) => s + o.outstanding, 0)),
      outstandingVerifiedOnly: r2(open.reduce((s, o) => s + o.outstandingVerified, 0)),
      openOrders: open.length, closedOrders: views.length - open.length,
      awaiting: r2(live.filter(p => UNVERIFIED.includes(p.status) && p.mode !== 'cash').reduce((s, p) => s + p.amount, 0)),
      received: r2(cnt.reduce((s, p) => s + p.amount, 0)),
      receivedCash: r2(cnt.filter(p => p.mode === 'cash').reduce((s, p) => s + p.amount, 0)),
      receivedOnline: r2(cnt.filter(p => p.mode !== 'cash').reduce((s, p) => s + p.amount, 0)),
      byStatus: { verified: sum(p => VERIFIED.includes(p.status)), awaiting: sum(p => UNVERIFIED.includes(p.status)), flagged: sum(p => p.status === 'flagged') },
      flaggedCount: live.filter(p => p.status === 'flagged').length,
      cashPendingCount: live.filter(p => p.status === 'cash_pending').length,
      cashPendingAmount: r2(live.filter(p => p.status === 'cash_pending').reduce((s, p) => s + p.amount, 0)),
      top: open.filter(o => o.outstanding > 0).sort((x, y) => y.outstanding - x.outstanding).slice(0, 8),
    });
  }

  // ----- bank statement matching
  if (a === 'statement' && m === 'POST') {
    const me = await authed(req, url, 'manager');
    const body = await readBody(req);
    const rows = (Array.isArray(body.rows) ? body.rows : []).map(r => ({ date: String(r.date || '').slice(0, 10), amount: r2(r.amount), ref: String(r.ref || '').slice(0, 120), desc: String(r.desc || '').slice(0, 200) })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.amount > 0);
    if (!rows.length) throw new HttpErr(400, 'No credits found in that statement');
    if (rows.length > 5000) throw new HttpErr(400, 'Statement is too large. Upload one month at a time.');
    const dates = rows.map(r => r.date).sort();
    const from = dates[0], to = dates[dates.length - 1];
    const day = d => Math.floor(Date.parse(d.slice(0, 10) + 'T00:00:00Z') / 86400000);
    const pays = (await db.all('payments')).filter(p => p.mode !== 'cash' && (p.status === 'client_reported' || (p.status === 'flagged' && p.reason === 'no_matching_credit')));
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
        await db.update('payments', p.id, { status: 'verified', reason: '', verifyMethod: 'statement', verifiedBy: me.name, verifiedAt: new Date().toISOString(), verifyNote: 'Matched on ' + p._m.how + ' with statement credit dated ' + rows[p._m.i].date });
        await audit(me, 'payment_verified_statement', 'payment', p.id, `${p.orderCode} ${p.amount} matched on ${p._m.how}`);
        matched.push({ id: p.id, orderCode: p.orderCode, amount: p.amount, how: p._m.how });
        await runConnectors('verified', { ...p, status: 'verified' }, allOrders.find(o => o.code === p.orderCode) || { code: p.orderCode }, me);
      } else if (p.status === 'client_reported') {
        await db.update('payments', p.id, { status: 'flagged', reason: 'no_matching_credit' });
        await audit(me, 'payment_flagged_statement', 'payment', p.id, `${p.orderCode} ${p.amount} no matching credit between ${from} and ${to}`);
        flagged.push({ id: p.id, orderCode: p.orderCode, amount: p.amount });
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
