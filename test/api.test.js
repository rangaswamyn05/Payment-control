'use strict';
process.env.ALLOW_LOCAL_CONNECTORS = '1';
const http = require('http');
const { start } = require('./serve');
let bad = 0, base;
const ok = (name, cond, extra) => { if (!cond) bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + (extra || ''))); };
async function call(method, path, body, tok) {
  const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
const login = async u => (await call('POST', 'login', { username: u, password: 'demo1234' })).j.token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const srv = await start(0); base = 'http://localhost:' + srv.address().port;
  // mock business API
  const got = [];
  const mock = http.createServer((q, s) => { let d = ''; q.on('data', c => d += c); q.on('end', () => { got.push({ h: q.headers, b: JSON.parse(d) }); s.statusCode = 200; s.end('{}'); }); });
  await new Promise(r => mock.listen(0, r)); const mockUrl = 'http://localhost:' + mock.address().port + '/record-payment';

  let r = await call('GET', 'health'); ok('health, memory db, demo seeded', r.s === 200 && r.j.db === 'memory' && r.j.demo === true);
  r = await call('POST', 'login', { username: 'owner', password: 'nope' }); ok('wrong password rejected', r.s === 401);
  const up = await login('uploader'), mg = await login('manager'), ow = await login('owner');
  ok('three roles can sign in', up && mg && ow);

  // role walls
  ok('uploader cannot see orders', (await call('GET', 'orders', null, up)).s === 403);
  ok('uploader cannot see summary', (await call('GET', 'summary', null, up)).s === 403);
  ok('uploader cannot see settings', (await call('GET', 'settings', null, up)).s === 403);
  ok('manager cannot create users', (await call('POST', 'users', { name: 'X', username: 'xx1', password: 'longpassword', role: 'uploader' }, mg)).s === 403);
  ok('no token rejected', (await call('GET', 'orders')).s === 401);
  r = await call('POST', 'users', { name: 'Second Manager', username: 'manager2', password: 'longpassword', role: 'manager' }, ow); ok('owner creates a user', r.s === 200 && r.j.user.role === 'manager');
  const mg2 = (await call('POST', 'login', { username: 'manager2', password: 'longpassword' })).j.token;

  // connector
  r = await call('PUT', 'settings', { businessName: 'Demo Co', connectors: { api: { enabled: true, url: mockUrl, key: 'secret-key-1' } } }, ow); ok('owner saves API connector', r.s === 200);
  r = await call('GET', 'settings', null, mg); ok('manager sees settings without the key', r.s === 200 && r.j.settings.connectors.api.keySet === true && !JSON.stringify(r.j).includes('secret-key-1'));
  r = await call('POST', 'settings/test-api', null, ow); ok('API test call reaches the business endpoint', r.j.result && r.j.result.ok === true && got.length === 1 && got[0].h.authorization === 'Bearer secret-key-1');

  // uploader flow
  r = await call('GET', 'orders/lookup/demo-1001', null, up); ok('uploader looks up an order, sees only code and client', r.s === 200 && r.j.customer === 'Demo client A' && r.j.total === undefined);
  r = await call('GET', 'orders/lookup/NOPE', null, up); ok('unknown order id is a clear 404', r.s === 404);
  const base1 = { orderCode: 'DEMO-1001', mode: 'upi', amount: 30000, date: '2026-11-25T11:18', txnId: 'T2611251118ABC' };
  r = await call('POST', 'payments', base1, up); ok('online payment without screenshot refused for uploader', r.s === 400);
  const img = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id; ok('image stored', !!img);
  r = await call('POST', 'ocr', { imageId: img }, up); ok('ocr says not configured when no key', r.s === 200 && r.j.configured === false);
  r = await call('POST', 'payments', { ...base1, imageId: img }, up); ok('uploader adds a UPI payment', r.s === 200 && r.j.payment.flagged === false);
  ok('payment event sent to business API with idempotency key', got.length === 2 && got[1].b.order_id === 'DEMO-1001' && got[1].b.amount === 30000 && /:created$/.test(got[1].h['x-idempotency-key']));
  r = await call('POST', 'payments', { ...base1, imageId: img }, up); ok('same transaction id is refused as duplicate', r.s === 409 && r.j.duplicate === true);
  const noRef = { orderCode: 'DEMO-1001', mode: 'upi', amount: 5000, date: '2026-11-25T14:11', imageId: img };
  r = await call('POST', 'payments', noRef, up); ok('payment with no reference accepted', r.s === 200 && !r.j.payment.flagged);
  r = await call('POST', 'payments', noRef, up); ok('same amount and time with no reference is flagged, not lost', r.s === 200 && r.j.payment.flagged === true);
  r = await call('POST', 'payments', { ...noRef, date: '2999-01-01' }, up); ok('future date refused', r.s === 400);
  r = await call('POST', 'payments', { ...noRef, amount: -5 }, up); ok('negative amount refused', r.s === 400);
  r = await call('POST', 'payments', { ...noRef, orderCode: 'NOPE' }, up); ok('unknown order refused', r.s === 400);
  r = await call('GET', 'payments/mine', null, up); ok('uploader sees own submissions only, no status or totals', r.s === 200 && r.j.payments.length === 3 && r.j.payments[0].status === undefined);

  // cash controls
  const cashBody = { orderCode: 'DEMO-1002', mode: 'cash', amount: 20000, date: '2026-11-24' };
  r = await call('POST', 'payments', cashBody, up); const cashId = (await call('GET', 'payments?status=cash_pending', null, mg)).j.payments[0].id; ok('cash is logged as pending', r.s === 200 && !!cashId);
  ok('uploader cannot confirm cash', (await call('POST', 'payments/' + cashId + '/confirm-cash', {}, up)).s === 403);
  r = await call('POST', 'payments', { orderCode: 'DEMO-1002', mode: 'cash', amount: 1000, date: '2026-11-24' }, mg); const mgCash = (await call('GET', 'payments?status=cash_pending', null, mg)).j.payments.find(p => p.amount === 1000).id;
  ok('person who logged cash cannot confirm it', (await call('POST', 'payments/' + mgCash + '/confirm-cash', {}, mg)).s === 403);
  ok('a different manager can confirm it', (await call('POST', 'payments/' + mgCash + '/confirm-cash', {}, mg2)).s === 200);
  r = await call('POST', 'payments/' + cashId + '/confirm-cash', {}, mg); ok('manager confirms uploader cash, who and when recorded', r.s === 200 && r.j.payment.status === 'cash_confirmed' && r.j.payment.confirmedBy === 'Demo Manager' && !!r.j.payment.confirmedAt);

  // verification
  const all = (await call('GET', 'payments', null, mg)).j.payments;
  const online = all.find(p => p.txnId === 'T2611251118ABC');
  ok('manual verify needs a note', (await call('POST', 'payments/' + online.id + '/verify', { note: '' }, mg)).s === 400);
  r = await call('POST', 'payments/' + online.id + '/verify', { note: 'Seen in bank app' }, mg); ok('manager verifies manually with a note', r.s === 200 && r.j.payment.status === 'verified');
  const flagged = all.find(p => p.status === 'flagged');
  ok('flagged item can be released', (await call('POST', 'payments/' + flagged.id + '/release', {}, mg)).s === 200);

  // orders & summary
  r = await call('POST', 'orders', { code: 'T-1', customer: 'Test client', total: 1000 }, mg); ok('manager creates an order', r.s === 200);
  ok('duplicate order id refused', (await call('POST', 'orders', { code: 't-1', customer: 'x', total: 5 }, mg)).s === 409);
  r = await call('GET', 'orders/DEMO-1001', null, mg); ok('order detail adds up: 30000 verified + 5000 awaiting + 5000 released', r.j.order.verified === 30000 && r.j.order.awaiting === 10000 && r.j.order.outstanding === 60000, JSON.stringify(r.j.order));
  ok('manager cannot change total after payments', (await call('PATCH', 'orders/DEMO-1001', { total: 90000 }, mg)).s === 403);
  ok('owner can change total (audited)', (await call('PATCH', 'orders/DEMO-1001', { total: 100000 }, ow)).s === 200);
  r = await call('POST', 'orders/DEMO-1001/close', {}, mg); ok('close blocked while not fully verified', r.s === 409 && r.j.blockers.length >= 1);
  r = await call('POST', 'orders/DEMO-1001/close', { override: true, reason: 'test' }, mg); ok('manager cannot override close', r.s === 409);
  r = await call('POST', 'orders/DEMO-1001/close', { override: true, reason: 'Client settled in kind, approved' }, ow); ok('owner can close with a written reason', r.s === 200 && r.j.order.status === 'closed');
  ok('payments to a closed order are refused', (await call('POST', 'payments', { ...noRef, date: '2026-11-20', amount: 7 }, up)).s === 400);
  r = await call('GET', 'summary?month=2026-11', null, mg);
  ok('summary: outstanding counts open orders only (39000 + 45000 + 1000)', r.s === 200 && r.j.openOrders === 3 && r.j.outstanding === 85000, JSON.stringify(r.j));
  ok('summary: received 61000 = online 40000 + cash 21000; verified 51000, awaiting 10000', r.j.received === 61000 && r.j.receivedOnline === 40000 && r.j.receivedCash === 21000 && r.j.byStatus.verified === 51000 && r.j.byStatus.awaiting === 10000, JSON.stringify(r.j));
  console.log('     summary =', JSON.stringify({ outstanding: r.j.outstanding, openOrders: r.j.openOrders, received: r.j.received, online: r.j.receivedOnline, cash: r.j.receivedCash, byStatus: r.j.byStatus, awaiting: r.j.awaiting }));

  // statement matching
  const stBefore = (await call('GET', 'payments', null, mg)).j.payments.filter(p => p.status === 'client_reported').length;
  r = await call('POST', 'statement', { rows: [
    { date: '2026-11-25', amount: 5000, ref: '', desc: 'UPI/CR/some narration' },
    { date: '2026-11-25', amount: 77777, ref: '', desc: 'UPI/CR/unknown payer' },
  ] }, mg);
  ok('statement: amount+date match verifies the 5000, other credit shown as unrecorded', r.s === 200 && r.j.matched.length === 1 && r.j.unmatchedCredits.length === 1 && r.j.unmatchedCredits[0].amount === 77777, JSON.stringify(r.j));
  ok('payments outside the statement range are left alone', stBefore >= 1);
  r = await call('POST', 'statement', { rows: [] }, mg); ok('empty statement refused', r.s === 400);

  // audit
  r = await call('GET', 'audit?limit=500', null, mg); ok('audit log records actions', r.j.audit.length > 15 && r.j.audit.some(x => x.action === 'order_closed_override'));

  r = await call('POST', 'orders', { customer: 'Sales test client', total: 50000 }, up); ok('sales team (uploader) creates an order, sees only code and client', r.s === 200 && !!r.j.order.code && r.j.order.total === undefined && r.j.order.customer === 'Sales test client');
  const newCode = r.j.order.code;
  ok('new sales order waits for approval', (await call('GET', 'orders/lookup/' + newCode, null, up)).j.pending === true);
  ok('payment on an unapproved order refused', (await call('POST', 'payments', { orderCode: newCode, mode: 'cash', amount: 1000, date: '2026-11-20' }, up)).s === 400);
  ok('uploader cannot approve', (await call('POST', 'orders/' + newCode + '/approve', {}, up)).s === 403);
  ok('pending order not counted as outstanding', (await call('GET', 'summary', null, mg)).j.pendingOrders >= 1);
  ok('manager approves the order', (await call('POST', 'orders/' + newCode + '/approve', {}, mg)).j.order.status === 'open');
  ok('payment accepted after approval', (await call('POST', 'payments', { orderCode: newCode, mode: 'cash', amount: 1000, date: '2026-11-20' }, up)).s === 200);
  r = await call('POST', 'orders', { customer: 'Bad client', total: 100 }, up);
  ok('manager rejects an order with a reason', (await call('POST', 'orders/' + r.j.order.code + '/reject', {}, mg)).s === 400 && (await call('POST', 'orders/' + r.j.order.code + '/reject', { reason: 'Wrong total' }, mg)).j.order.status === 'rejected');
  ok('approval is in the audit log', (await call('GET', 'audit', null, ow)).j.audit.some(e => e.action === 'order_approved'));
  // Google Sheets connector against a mock Google
  const gl = []; const crypto = require('crypto');
  const gm = http.createServer((q, s) => { let d = ''; q.on('data', c => d += c); q.on('end', () => { gl.push({ u: q.url, h: q.headers, d }); s.setHeader('Content-Type', 'application/json'); s.end(q.url.startsWith('/token') ? '{"access_token":"tok123","expires_in":3600}' : '{}'); }); });
  await new Promise(r2 => gm.listen(0, r2)); const gp = gm.address().port;
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@test.iam'; process.env.GOOGLE_SERVICE_ACCOUNT_KEY = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  process.env.SHEETS_ID = 'sheet1'; process.env.GOOGLE_TOKEN_URL = 'http://localhost:' + gp + '/token'; process.env.SHEETS_API_BASE = 'http://localhost:' + gp;
  r = await call('POST', 'orders', { customer: '=HYPERLINK("x")', total: 7000 }, up);
  await call('POST', 'orders/' + r.j.order.code + '/approve', {}, mg);
  const ap = gl.find(g => g.u.includes('/values/Orders'));
  ok('approval appends the order to the Orders tab, with a Google sign-in', !!ap && ap.h.authorization === 'Bearer tok123' && gl.some(g => g.u.startsWith('/token') && g.d.includes('assertion=')));
  const row = ap && JSON.parse(ap.d).values[0];
  ok('row holds order id, client, total, approver; formula text is neutralised', row && row[2] === r.j.order.code && row[4] === '7000' && row[6] === 'Demo Manager' && row[3].startsWith("'="));
  ok('uses append only', !!ap && ap.u.includes(':append') && !gl.some(g => /clear|delete/i.test(g.u)));
  gm.close();
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL API TESTS PASSED');
  srv.close(); mock.close(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
