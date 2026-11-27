'use strict';
process.env.ALLOW_LOCAL_CONNECTORS = '1';
const http = require('http');
const { start } = require('./serve');
let bad = 0, base;
const ok = (name, cond, extra) => { if (!cond) bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + (extra || ''))); };
async function call(method, path, body, tok) {
  if (method === 'POST' && (path === 'payments' || path === 'orders') && body && !body.nextDue && !body.schedule) { const { noDue, ...rest } = body; body = noDue ? rest : { ...rest, nextDue: '2030-01-01' }; }
  const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
const login = async u => (await call('POST', 'login', { username: u, password: 'demo1234' })).j.token;
let phn = 9000000000; const P = () => String(++phn);
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
  ok('uploader sees only the safe settings', (await call('GET', 'settings', null, up)).j.settings.storage === undefined);
  ok('manager cannot create users', (await call('POST', 'users', { name: 'X', username: 'xx1', password: 'longpassword', role: 'uploader' }, mg)).s === 403);
  ok('no token rejected', (await call('GET', 'orders')).s === 401);
  r = await call('POST', 'users', { name: 'Second Manager', username: 'manager2', password: 'longpassword', role: 'manager' }, ow); ok('owner creates a user', r.s === 200 && r.j.user.role === 'manager');
  const mg2 = (await call('POST', 'login', { username: 'manager2', password: 'longpassword' })).j.token;

  // connector
  r = await call('PUT', 'settings', { businessName: 'Demo Co', connectors: { api: { enabled: true, url: mockUrl, key: 'secret-key-1' } } }, ow); ok('owner saves API connector', r.s === 200);
  r = await call('GET', 'settings', null, mg); ok('manager sees settings without the key', r.s === 200 && r.j.settings.connectors.api.keySet === true && !JSON.stringify(r.j).includes('secret-key-1'));
  r = await call('POST', 'settings/test-api', null, ow); ok('API test call reaches the business endpoint', r.j.result && r.j.result.ok === true && got.length === 1 && got[0].h.authorization === 'Bearer secret-key-1');

  // uploader flow
  r = await call('GET', 'orders/lookup/demo-1001', null, up); ok('uploader looks up an order: client, total and next payment number', r.s === 200 && r.j.customer === 'Demo client A' && r.j.total === 100000 && r.j.nextPayment === 1);
  r = await call('GET', 'orders/lookup/NOPE', null, up); ok('unknown order id is a clear 404', r.s === 404);
  const img = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id; ok('image stored', !!img);
  r = await call('POST', 'ocr', { imageId: img }, up); ok('ocr says not configured when no key', r.s === 200 && r.j.configured === false);
  const base1 = { orderCode: 'DEMO-1001', mode: 'upi', amount: 30000, date: '2026-11-25T11:18', txnId: 'T2611251118ABC', imageId: img };
  r = await call('POST', 'payments', { ...base1, imageId: '' }, up); ok('online payment without screenshot refused', r.s === 400);
  r = await call('POST', 'payments', { ...base1, txnId: '' }, up); ok('screenshot with no transaction ID is rejected', r.s === 400 && r.j.needTxn === true);
  r = await call('POST', 'payments', base1, up); ok('uploader adds payment 1 (next number picked)', r.s === 200 && r.j.payment.seq === 1 && !r.j.payment.needsOwner);
  ok('payment event sent to business API with idempotency key', got.length === 2 && got[1].b.order_id === 'DEMO-1001' && got[1].b.amount === 30000 && /:created$/.test(got[1].h['x-idempotency-key']));
  r = await call('POST', 'payments', base1, up); ok('same transaction id refused as duplicate', r.s === 409 && r.j.duplicate === true);
  r = await call('POST', 'payments', { ...base1, mode: 'cheque', txnId: '' }, up); ok('cheque without a cheque number is rejected', r.s === 400 && r.j.needTxn === true);
  r = await call('POST', 'payments', { ...base1, mode: 'cheque' }, up); ok('cheque number already recorded is refused as duplicate', r.s === 409 && r.j.duplicate === true);
  r = await call('POST', 'payments', { ...base1, mode: 'card', txnId: '' }, up); ok('card payment without a payment ID is rejected', r.s === 400 && r.j.needTxn === true);
  r = await call('POST', 'payments', { ...base1, mode: 'card' }, up); ok('card payment ID already recorded is refused as duplicate', r.s === 409 && r.j.duplicate === true);
  const fp = (n, amt) => ({ mode: 'upi', amount: String(amt), date: '2026-11-25T10:00', txnId: 'PLANTXN' + n, imageId: img });
  r = await call('POST', 'orders', { phone: P(), code: 'plan-0', customer: 'x', total: 100000, firstPayment: fp('0', 5000), noDue: true }, up); ok('new order without a plan or due date is refused', r.s === 400 && r.j.needDue === true);
  r = await call('POST', 'orders', { phone: P(), code: 'plan-0', customer: 'x', total: 100000, firstPayment: fp('0', 5000), schedule: [{ date: '2030-02-01', amount: 80000 }, { date: '2030-03-01', amount: 30000 }] }, up); ok('plan adding up to more than the total is refused', r.s === 400);
  r = await call('POST', 'orders', { phone: P(), code: 'plan-0', customer: 'x', total: 100000, firstPayment: fp('0', 5000), nextDue: 'soon' }, up); ok('invalid next due date is refused', r.s === 400);
  r = await call('POST', 'payments', { ...base1, noDue: true, orderCode: 'DEMO-1001', txnId: 'NODUE0001', amount: 1000 }, up); ok('payment leaving a balance needs the next due date', r.s === 400 && r.j.needDue === true);
  const p2 = { orderCode: 'DEMO-1001', mode: 'transfer', amount: 5000, date: '2026-11-25T14:11', txnId: 'NEFT0002', imageId: img };
  r = await call('POST', 'payments', { ...p2, seq: 4 }, up); ok('wrong payment number asks for a reason', r.s === 409 && r.j.needReason === true && r.j.expected === 2);
  r = await call('POST', 'payments', { ...p2, seq: 4, seqReason: 'Third and fourth were paid in cash' }, up); ok('out-of-order number accepted with a reason, no manager step', r.s === 200 && r.j.payment.seq === 4 && !r.j.payment.needsOwner);
  r = await call('POST', 'payments', { ...p2, txnId: 'X3', date: '2999-01-01' }, up); ok('future date refused', r.s === 400);
  r = await call('POST', 'payments', { ...p2, txnId: 'X4', amount: -5 }, up); ok('negative amount refused', r.s === 400);
  r = await call('POST', 'payments', { ...p2, txnId: 'X5', orderCode: 'NOPE' }, up); ok('unknown order refused', r.s === 400);
  r = await call('GET', 'payments/mine', null, up); ok('uploader sees own submissions only, no status or totals', r.s === 200 && r.j.payments.length === 2 && r.j.payments[0].status === undefined);

  // dashboard states
  r = await call('GET', 'orders/DEMO-1001', null, mg); ok('order shows collected, outstanding, validation pending', r.j.order.collected === 35000 && r.j.order.outstanding === 65000 && r.j.order.validation === 'pending' && /Upload a statement/.test(r.j.order.validationNote), JSON.stringify(r.j.order));
  r = await call('POST', 'statement', { rows: [{ date: '2026-11-25', amount: 1234, ref: 'OTHER', desc: 'x' }, { date: '2026-11-25', amount: 5000, ref: '', desc: 'NEFT0002 from client' }] }, mg);
  ok('statement matches the 5000 by transaction ID, the 30000 is only "unable to validate", not flagged wrong', r.j.matched.length === 1 && r.j.matched[0].how === 'reference' && r.j.flagged.length === 1 && r.j.flagged[0].amount === 30000, JSON.stringify(r.j));
  r = await call('GET', 'orders/DEMO-1001', null, mg); ok('order: 5000 validated, 30000 not validated, note says unable to validate', r.j.order.validated === 5000 && r.j.order.notValidated === 30000 && r.j.order.validation === 'unable' && r.j.order.flaggedCount === 0 && /Unable to validate/.test(r.j.order.validationNote), JSON.stringify(r.j.order));
  r = await call('POST', 'statement', { rows: [{ date: '2026-11-25', amount: 30000, ref: 'T2611251118ABC', desc: 'UPI' }] }, mg);
  ok('a later statement clears the pending item', r.j.matched.length === 1);
  r = await call('GET', 'orders/DEMO-1001', null, mg); ok('order fully system validated', r.j.order.validated === 35000 && r.j.order.validation === 'validated');

  // cash and approvals
  const cashBody = { orderCode: 'DEMO-1002', mode: 'cash', amount: 20000, date: '2026-11-24' };
  r = await call('POST', 'payments', cashBody, up); ok('sales cash entry needs the owner', r.s === 200 && r.j.payment.needsOwner === true);
  const cashId = (await call('GET', 'payments?status=cash_pending', null, mg)).j.payments[0].id;
  ok('uploader cannot approve cash', (await call('POST', 'payments/' + cashId + '/confirm-cash', {}, up)).s === 403);
  ok('manager cannot approve cash either', (await call('POST', 'payments/' + cashId + '/confirm-cash', {}, mg)).s === 403);
  r = await call('GET', 'orders/DEMO-1002', null, mg); ok('cash waiting shows as owner approval, still outstanding view counts it', r.j.order.validation === 'owner' && r.j.order.pendingCash === 1);
  r = await call('POST', 'payments/' + cashId + '/confirm-cash', {}, ow); ok('owner approves cash, who and when recorded', r.s === 200 && r.j.payment.status === 'cash_confirmed' && r.j.payment.confirmedBy === 'Demo Owner' && !!r.j.payment.confirmedAt);
  r = await call('GET', 'orders/DEMO-1002', null, mg); ok('cash shows as manually validated, not system validated', r.j.order.manual === 20000 && r.j.order.validated === 0 && r.j.order.validation === 'manual' && /not system validated/.test(r.j.order.validationNote));
  r = await call('POST', 'payments', { orderCode: 'DEMO-1002', mode: 'upi', amount: 2000, date: '2026-11-24', txnId: 'MG-1', imageId: img }, mg);
  ok('a manager’s own entry goes to the owner', r.s === 200 && r.j.payment.needsOwner === true);
  const mgPay = (await call('GET', 'payments?status=owner', null, ow)).j.payments.find(p => p.txnId === 'MG-1');
  ok('owner approves the manager’s entry', !!mgPay && (await call('POST', 'payments/' + mgPay.id + '/approve', {}, ow)).s === 200);
  ok('manager cannot use owner approval', (await call('POST', 'payments/' + mgPay.id + '/approve', {}, mg)).s === 403);

  // limits and triggers (flag and notify, never block)
  r = await call('PUT', 'settings', { limits: { singlePayment: 50000, collectionThreshold: 30000 } }, ow); ok('owner sets limits', r.s === 200);
  r = await call('POST', 'payments', { orderCode: 'DEMO-1003', mode: 'upi', amount: 35000, date: '2026-11-24', txnId: 'LIM-1', imageId: img }, up);
  ok('collections over the threshold are saved, not blocked, sales told to talk to manager', r.s === 200 && /talk to your manager or owner/.test(r.j.notice));
  r = await call('GET', 'notifications', null, mg); ok('manager is notified of the threshold', r.j.notifications.some(n => /passed/.test(n.text)));
  r = await call('POST', 'payments', { orderCode: 'DEMO-1003', mode: 'upi', amount: 60000, date: '2026-11-24', txnId: 'LIM-2', imageId: img }, up);
  ok('over the single-payment limit: saved, goes to the owner, flagged as overpayment too', r.s === 200 && r.j.payment.needsOwner === true && r.j.payment.flagged === true);
  const op = (await call('GET', 'payments?status=flagged', null, mg)).j.payments.find(p => p.txnId === 'LIM-2');
  ok('overpayment is in manager review', !!op && op.reason === 'overpayment');
  ok('manager releases the overpayment', (await call('POST', 'payments/' + op.id + '/release', {}, mg)).s === 200);

  // adjust outstanding
  r = await call('POST', 'orders/DEMO-1003/adjust', { kind: 'change_total', newTotal: 95000, comment: 'Agreed extra work' }, mg);
  ok('manager’s change goes to the owner, not applied', r.s === 200 && r.j.requested === true && (await call('GET', 'orders/DEMO-1003', null, mg)).j.order.total === 45000);
  const rq = (await call('GET', 'requests', null, ow)).j.requests[0];
  ok('owner sees the request and approves it', !!rq && (await call('POST', 'requests/' + rq.id + '/approve', {}, ow)).s === 200 && (await call('GET', 'orders/DEMO-1003', null, ow)).j.order.total === 95000);
  r = await call('POST', 'orders/DEMO-1002/adjust', { kind: 'change_total', newTotal: 50000, comment: 'Discount given' }, ow); ok('owner’s change applies immediately', r.s === 200 && r.j.applied === true && r.j.order.total === 50000);
  r = await call('GET', 'orders/DEMO-1002', null, mg); const out2 = r.j.order.outstanding;
  r = await call('POST', 'orders/DEMO-1002/adjust', { kind: 'close_offline', amount: out2 + 1, comment: 'wrong' }, ow); ok('offline amount must equal the outstanding', r.s === 400);
  r = await call('POST', 'orders/DEMO-1002/adjust', { kind: 'close_offline', amount: out2, comment: 'Balance received in cash' }, ow);
  r = await call('GET', 'orders/DEMO-1002', null, ow); ok('closing with offline amount: closed, nothing outstanding, recorded as manual', r.j.order.status === 'closed' && r.j.order.outstanding === 0 && r.j.order.manual >= out2);
  ok('adjust needs a comment', (await call('POST', 'orders/DEMO-1003/adjust', { kind: 'change_total', newTotal: 90000, comment: '' }, ow)).s === 400);

  // orders & summary
  r = await call('POST', 'orders', { phone: P(), code: 'T-1', customer: 'Test client', total: 1000 }, mg); ok('manager creates an order', r.s === 200);
  ok('duplicate order id refused on create', (await call('POST', 'orders', { phone: P(), code: 't-1', customer: 'x', total: 5 }, up)).s === 409);
  ok('manager cannot change total after approval', (await call('PATCH', 'orders/DEMO-1001', { total: 90000 }, mg)).s === 403);
  ok('owner can change total (audited)', (await call('PATCH', 'orders/DEMO-1001', { total: 100000 }, ow)).s === 200);
  r = await call('POST', 'orders/DEMO-1001/close', {}, mg); ok('close blocked while not fully verified', r.s === 409);
  r = await call('POST', 'orders/DEMO-1001/close', { override: true, reason: 'Client settled in kind, approved' }, ow); ok('owner can close with a written reason', r.s === 200 && r.j.order.status === 'closed');
  ok('payments to a closed order are refused', (await call('POST', 'payments', { ...p2, txnId: 'ZZ9' }, up)).s === 400);
  r = await call('GET', 'summary?period=all', null, mg);
  ok('summary has validated, manual and not validated totals', r.s === 200 && r.j.validatedTotal > 0 && r.j.manualTotal > 0 && typeof r.j.notValidatedTotal === 'number', JSON.stringify(r.j));

  // sales creates, manager modifies and approves
  r = await call('POST', 'settings', null, ow);
  r = await call('PUT', 'settings', { customerFields: [{ label: 'Phone number' }] }, ow); ok('owner chooses customer fields at setup', r.s === 200);
  r = await call('POST', 'orders', { phone: P(), code: 'S-1', customer: 'Sales client', total: 50000, firstPayment: { mode: 'upi', amount: 10000, date: '2026-11-25', txnId: 'ADV-1', imageId: img } }, up);
  ok('missing phone number is refused', r.s === 400 && /phone number/i.test(r.j.error));
  const ord = { phone: '98765 43210', code: 'S-1', customer: 'Sales client', total: 50000, customerExtra: { f0_phonenumber: '9990001111' }, firstPayment: { mode: 'upi', amount: 10000, date: '2026-11-25', txnId: 'ADV-1', imageId: img } };
  r = await call('POST', 'orders', { ...ord, firstPayment: undefined }, up); ok('sales must attach the first advance screenshot', r.s === 400);
  r = await call('POST', 'orders', { ...ord, firstPayment: { ...ord.firstPayment, txnId: '' } }, up); ok('first advance with no transaction ID is rejected', r.s === 400);
  r = await call('POST', 'orders', ord, up); ok('sales creates the order with its first advance', r.s === 200 && r.j.order.status === 'pending' && r.j.order.total === undefined);
  ok('same order ID again is refused', (await call('POST', 'orders', ord, up)).s === 409);
  ok('payment on a pending order is refused', (await call('POST', 'payments', { orderCode: 'S-1', mode: 'cash', amount: 1000, date: '2026-11-20' }, up)).s === 400);
  ok('uploader cannot approve', (await call('POST', 'orders/S-1/approve', {}, up)).s === 403);
  ok('pending counted for managers', (await call('GET', 'summary', null, mg)).j.pendingOrders >= 1);
  r = await call('POST', 'orders/S-1/approve', { total: 40000, comment: 'Agreed 40k' }, mg); ok('manager modifies the total and approves in one step', r.j.order.status === 'open' && r.j.order.total === 40000 && r.j.order.modifications.length === 1);
  r = await call('GET', 'notifications', null, up); ok('sales is told old and new value and that it is approved', r.j.notifications.some(n => /50000.*40000/.test(n.text) && /approved/.test(n.text)), JSON.stringify(r.j));
  ok('an invoice exists after approval', (await call('GET', 'orders/S-1', null, mg)).j.invoice === true);
  r = await fetch(base + '/api/invoices/S-1?t=' + mg); const html = await r.text(); ok('invoice shows order, client, total, paid and balance', r.status === 200 && html.includes('S-1') && html.includes('Sales client') && html.includes('40,000') && html.includes('30,000'), html.slice(0, 200));
  ok('total is locked for managers after approval', (await call('PATCH', 'orders/S-1', { total: 1 }, mg)).s === 403);
  r = await call('POST', 'orders', { ...ord, phone: P(), code: 'S-2', firstPayment: { ...ord.firstPayment, txnId: 'ADV-2' } }, up);
  ok('manager rejects with a reason; sales is told', (await call('POST', 'orders/S-2/reject', {}, mg)).s === 400 && (await call('POST', 'orders/S-2/reject', { reason: 'Wrong total' }, mg)).j.order.status === 'rejected' && (await call('GET', 'notifications', null, up)).j.notifications.some(n => /S-2.*sent back/.test(n.text)));
  ok('another sales person cannot resubmit it', (await call('POST', 'orders/S-2/resubmit', {}, await (async () => { await call('POST', 'users', { name: 'Sales Two', username: 'sales2', password: 'longpassword', role: 'uploader' }, ow); return (await call('POST', 'login', { username: 'sales2', password: 'longpassword' })).j.token; })())).s === 403);
  r = await call('GET', 'orders/mine', null, up); ok('sales sees own orders and the reject reason', r.j.orders.some(o => o.code === 'S-2'));
  r = await call('POST', 'orders/S-2/resubmit', { total: 20000 }, up); ok('sales fixes and resubmits a rejected order', r.s === 200 && r.j.order.status === 'pending');
  ok('approval is in the audit log', (await call('GET', 'audit', null, ow)).j.audit.some(e => e.action === 'order_modified_approved'));

  // phone number: mandatory, duplicate warning, lookup, order ID mode
  r = await call('POST', 'orders', { ...ord, code: 'S-9', phone: '', firstPayment: { ...ord.firstPayment, txnId: 'ADV-9' } }, up); ok('phone number is mandatory', r.s === 400 && /phone/i.test(r.j.error));
  r = await call('POST', 'orders', { ...ord, code: 'S-9', firstPayment: { ...ord.firstPayment, txnId: 'ADV-9' } }, up); ok('same phone on a new order asks "same customer?"', r.s === 409 && r.j.samePhone && r.j.samePhone[0].code === 'S-1');
  r = await call('POST', 'orders', { ...ord, code: 'S-9', confirmSamePhone: true, firstPayment: { ...ord.firstPayment, txnId: 'ADV-9' } }, up); ok('sales can go ahead after the warning', r.s === 200);
  r = await call('GET', 'orders/by-phone/98765%2043210', null, up); ok('sales types the phone and sees that customer’s open orders', r.s === 200 && r.j.orders.length === 1 && r.j.orders[0].code === 'S-1', JSON.stringify(r.j));
  ok('short numbers return nothing', (await call('GET', 'orders/by-phone/123', null, up)).j.orders.length === 0);
  await call('PUT', 'settings', { customerFields: [], orderIdMode: 'auto' }, ow);
  r = await call('POST', 'orders', { phone: P(), code: 'IGNORED', customer: 'Auto client', total: 500, firstPayment: { mode: 'cash', amount: 100, date: '2026-11-25' } }, up);
  ok('automatic mode ignores typed IDs and numbers the order itself', r.s === 200 && /^ORD-\d+$/.test(r.j.order.code), JSON.stringify(r.j));
  await call('PUT', 'settings', { orderIdMode: 'own' }, ow);
  r = await call('POST', 'orders', { phone: P(), customer: 'No id', total: 500, firstPayment: { mode: 'cash', amount: 100, date: '2026-11-25' } }, up); ok('own-ID mode requires an order ID', r.s === 400);

  // reports and clear
  r = await call('GET', 'reports?period=all', null, ow); ok('owner report: revenue, collected, outstanding, validated, manual', r.s === 200 && r.j.report.revenue > 0 && r.j.report.manual > 0 && r.j.report.validated > 0);
  ok('manager cannot open reports', (await call('GET', 'reports', null, mg)).s === 403);
  ok('clear is blocked before download', (await call('POST', 'data/clear', { confirm: true }, ow)).s === 409);
  r = await fetch(base + '/api/reports?period=all&csv=1&t=' + ow); const csv = await r.text(); ok('report downloads as csv', r.status === 200 && csv.startsWith('"Order"') && csv.includes('DEMO-1001'));
  r = await call('POST', 'data/clear', {}, ow); ok('after download, still needs explicit confirm', r.s === 409 && r.j.needConfirm === true);
  r = await call('POST', 'data/clear', { confirm: true }, ow); ok('clear removes screenshots and invoice files of closed orders only', r.s === 200 && r.j.screenshots >= 1);
  ok('order records and totals survive clearing', (await call('GET', 'orders/DEMO-1001', null, ow)).j.order.total === 100000);
  ok('open order invoice survives', (await call('GET', 'orders/S-1', null, mg)).j.invoice === true);
  ok('clearing is audited', (await call('GET', 'audit?limit=500', null, ow)).j.audit.some(e => e.action === 'data_cleared'));

  // settings: GST rule
  r = await call('PUT', 'settings', { onboarded: true, business: { name: 'Acme', taxId: '', taxNA: false } }, ow); ok('GST or tax number required unless not applicable', r.s === 400);
  r = await call('PUT', 'settings', { onboarded: true, business: { name: 'Acme', taxId: '', taxNA: true, address: 'NY', contact: 'a@b.co' } }, ow); ok('tick not applicable and setup saves', r.s === 200);
  r = await call('PUT', 'settings', { storage: 'app_sheet' }, ow); ok('storage dropdown saves', r.s === 200 && (await call('GET', 'settings', null, ow)).j.settings.storage === 'app_sheet');
  ok('storage cannot be switched off', (await call('PUT', 'settings', { storage: 'none' }, ow)).s === 200 && (await call('GET', 'settings', null, ow)).j.settings.storage === 'app_sheet');

  // Google Sheets connector against a mock Google
  const gl = []; const crypto = require('crypto');
  const gm = http.createServer((q, s) => { let d = ''; q.on('data', c => d += c); q.on('end', () => { gl.push({ u: q.url, h: q.headers, d }); s.setHeader('Content-Type', 'application/json'); s.end(q.url.startsWith('/token') ? '{"access_token":"tok123","expires_in":3600}' : '{}'); }); });
  await new Promise(r2 => gm.listen(0, r2)); const gp = gm.address().port;
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@test.iam'; process.env.GOOGLE_SERVICE_ACCOUNT_KEY = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  process.env.SHEETS_ID = 'sheet1'; process.env.GOOGLE_TOKEN_URL = 'http://localhost:' + gp + '/token'; process.env.SHEETS_API_BASE = 'http://localhost:' + gp;
  await call('PUT', 'settings', { customerFields: [] }, ow);
  await call('PUT', 'settings', { storage: 'app_sheet' }, ow);
  r = await call('POST', 'orders', { phone: P(), code: 'SH-1', customer: '=HYPERLINK("x")', total: 7000, firstPayment: { mode: 'upi', amount: 1000, date: '2026-11-25', txnId: 'SH-1', imageId: (await call('POST', 'images', { dataUrl: PNG }, up)).j.id } }, up);
  await call('POST', 'orders/' + r.j.order.code + '/approve', {}, mg);
  const ap = gl.find(g => g.u.includes('/values/Orders'));
  ok('approval appends the order to the Orders tab, with a Google sign-in', !!ap && ap.h.authorization === 'Bearer tok123' && gl.some(g => g.u.startsWith('/token') && g.d.includes('assertion=')));
  const row = ap && JSON.parse(ap.d).values[0];
  ok('row holds order id, client, total, approver; formula text is neutralised', row && row[2] === r.j.order.code && row[4] === '7000' && row[6] === 'Demo Manager' && row[3].startsWith("'="));
  ok('uses append only', !!ap && ap.u.includes(':append') && !gl.some(g => /clear|delete/i.test(g.u)));
  { // each customer's own sheet
    const mine = 'abcdefghijklmnopqrstuvwxyz1234567890';
    let q0 = await call('PUT', 'settings', { storage: 'app', sheetLink: 'not a link' }, ow); ok('bad sheet link refused', q0.s === 400);
    q0 = await call('PUT', 'settings', { storage: 'app', sheetLink: 'https://docs.google.com/spreadsheets/d/' + mine + '/edit#gid=0' }, ow); ok('sheet link saved', q0.s === 200, JSON.stringify(q0.j));
    q0 = await call('GET', 'settings', null, ow); ok('owner sees sheet id, service email and ready flag', q0.j.settings.sheet.id === mine && q0.j.settings.sheetEmail === 'svc@test.iam' && q0.j.settings.sheetReady === true);
    q0 = await call('GET', 'settings', null, mg); ok('manager does not see sheet id or email', !q0.j.settings.sheet.id && !q0.j.settings.sheetEmail);
    gl.length = 0; q0 = await call('POST', 'settings/test-sheet', {}, ow);
    ok('test row goes to the customer sheet, tabs prepared', q0.j.ok === true && gl.some(g => g.u.includes('/' + mine + ':batchUpdate')) && gl.some(g => g.u.includes('/' + mine + '/values/Payments')), JSON.stringify([q0.j, gl.map(g => g.u)]));
    await call('PUT', 'settings', { sheetLink: '' }, ow); }
  { // the whole downloaded JSON file pasted as the key still works
    const keep = process.env.GOOGLE_SERVICE_ACCOUNT_KEY, pem = keep.replace(/\\n/g, '\n');
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', client_email: 'svc@test.iam', private_key: pem });
    const { sheetsConfig } = require('../api/_lib/connectors'); const c0 = sheetsConfig('x');
    ok('whole JSON key file is accepted', !!c0 && c0.key.includes('BEGIN PRIVATE KEY') && c0.email === 'svc@test.iam');
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = keep; }
  { // choose the sheet's columns
    let c0 = await call('PUT', 'settings', { sheetCols: { payments: ['order', 'customer', 'amount', 'bogus'], orders: ['order', 'total'] } }, ow); ok('owner picks sheet columns', c0.s === 200);
    c0 = await call('GET', 'settings', null, ow); ok('chosen columns kept, unknown dropped; catalogue offered', c0.j.settings.sheet.cols.payments.join() === 'order,customer,amount' && c0.j.settings.sheetCatalog.payments.length > 9, JSON.stringify(c0.j.settings.sheet.cols));
    const { payRow } = require('../api/_lib/connectors');
    ok('row follows the chosen columns', payRow(['order', 'customer', 'amount'], { amount: 500 }, { code: 'A1', customer: 'Ravi' }, 'x').join() === 'A1,Ravi,500');
    await call('PUT', 'settings', { sheetCols: { payments: [], orders: [] } }, ow); }
  { // choose what the business systems receive
    let c1 = await call('PUT', 'settings', { connectors: { api: { enabled: false, fields: ['order_id', 'amount', 'customer', 'nope'] } } }, ow); ok('owner picks what systems receive', c1.s === 200, JSON.stringify(c1.j));
    c1 = await call('GET', 'settings', null, ow); ok('fields kept, unknown dropped', c1.j.settings.connectors.api.fields.join() === 'order_id,amount,customer' && c1.j.settings.connectors.apiCatalog.length > 8, JSON.stringify(c1.j.settings.connectors.api));
    await call('PUT', 'settings', { connectors: { api: { enabled: false, fields: [] } } }, ow); }
  { // each added system has its own fields
    let c2 = await call('PUT', 'settings', { extraSystems: [{ name: 'CRM', url: 'https://crm.example.com/h', fields: ['order_id', 'phone'] }, { name: 'Books', url: 'https://books.example.com/h' }] }, ow); ok('save systems with their own fields', c2.s === 200);
    c2 = await call('GET', 'settings', null, ow); const ex2 = c2.j.settings.connectors.extra; ok('each system keeps its own fields; default for the other', ex2[0].fields.join() === 'order_id,phone' && ex2[1].fields.length === 7, JSON.stringify(ex2));
    await call('PUT', 'settings', { extraSystems: [] }, ow); }
  { // supporting checks are reported on a match
    const { } = {};
    const o9 = await call('POST', 'orders', { phone: P(), code: 'rm-1', customer: 'x', total: 800, firstPayment: { mode: 'upi', amount: '800', date: '2026-11-25T10:00', txnId: 'RM000111', imageId: (await call('POST', 'images', { dataUrl: PNG }, up)).j.id, note: 'rm-1 advance' } }, up); await call('POST', 'orders/rm-1/approve', {}, ow);
    await call('PUT', 'settings', { accounts: [] }, ow);
    const sr = await call('POST', 'statement', { rows: [{ date: '2026-11-24', amount: 5, ref: 'X', desc: 'x' }, { date: '2026-11-26', amount: 800, ref: 'RM000111', desc: 'UPI/RM000111/rm-1 advance' }] }, mg); ok('statement matches rm-1', sr.s === 200 && sr.j.matched.some(m => m.orderCode === 'rm-1'), JSON.stringify(sr.j));
    const pr9 = (await call('GET', 'orders/rm-1', null, mg)).j; const pp = JSON.stringify(pr9);
    ok('match note reports date and remarks checks', /1 day apart/.test(pp) && /Remarks agree/.test(pp), pp.slice(0, 300)); }
  { // product or service and units
    const o8 = await call('POST', 'orders', { phone: P(), code: 'item-1', customer: 'x', item: 'Wedding album', units: '2', total: 9000, firstPayment: { mode: 'upi', amount: '1000', date: '2026-11-25T10:00', txnId: 'ITEM0001', imageId: (await call('POST', 'images', { dataUrl: PNG }, up)).j.id } }, up);
    ok('order created with product and units', o8.s === 200, JSON.stringify(o8.j).slice(0, 200));
    const lk = await call('GET', 'orders/lookup/item-1', null, up); ok('lookup shows the item for Add payment', lk.j.item === 'Wedding album' && lk.j.units === 2, JSON.stringify(lk.j));
    const o9b = await call('POST', 'orders', { phone: P(), code: 'item-2', customer: 'x', item: 'Photo shoot', units: '-3', total: 500, firstPayment: { mode: 'upi', amount: '100', date: '2026-11-25T10:00', txnId: 'ITEM0002', imageId: (await call('POST', 'images', { dataUrl: PNG }, up)).j.id } }, up); const lk2 = await call('GET', 'orders/lookup/item-2', null, up); ok('bad units are ignored, not refused', o9b.s === 200 && lk2.j.units === 0 && lk2.j.item === 'Photo shoot', JSON.stringify(lk2.j)); }
  { // unable-to-validate gives a reason
    const imgU = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
    await call('POST', 'orders', { phone: P(), code: 'un-1', customer: 'x', total: 700, firstPayment: { mode: 'upi', amount: '700', date: '2026-11-25T10:00', txnId: 'UN000777', imageId: imgU } }, up); await call('POST', 'orders/un-1/approve', {}, ow);
    await call('PUT', 'settings', { accounts: [] }, ow);
    const ur = await call('POST', 'statement', { rows: [{ date: '2026-11-24', amount: 5, ref: 'X', desc: 'x' }, { date: '2026-11-26', amount: 650, ref: 'UN000777', desc: 'UPI' }] }, mg);
    ok('unmatched payment gets a reason', ur.s === 200 && ur.j.flagged.some(f => f.orderCode === 'un-1' && /transaction ID is .*650/.test(f.reason)), JSON.stringify(ur.j.flagged));
    const ud = (await call('GET', 'orders/un-1', null, mg)).j; ok('payment note says unable and why', (ud.payments || []).some(p => /Unable to validate: the bank credit with this transaction ID/.test(p.validationNote || '')), JSON.stringify((ud.payments || []).map(p => p.validationNote))); }
  { // dashboard shows what is due
    const imgD = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
    const tomorrow = new Date(Date.now() + 86400000 + 19800000).toISOString().slice(0, 10), far = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10), past = '2026-01-05';
    const mkd = async (code, n, dt) => { await call('POST', 'orders', { phone: P(), code, customer: 'x', total: 5000, nextDue: dt, firstPayment: { mode: 'upi', amount: '1000', date: '2026-11-25T10:00', txnId: 'DUE0000' + n, imageId: imgD } }, up); await call('POST', 'orders/' + code + '/approve', {}, ow); };
    await mkd('due-a', 1, past); await mkd('due-b', 2, tomorrow); await mkd('due-c', 3, far);
    const sm = await call('GET', 'summary?period=all', null, mg); const dz = sm.j.dues || [];
    ok('dashboard lists overdue and next-7-day dues, not far ones', dz.some(x => x.code === 'due-a' && x.bucket === 'overdue') && dz.some(x => x.code === 'due-b' && x.bucket === 'week') && !dz.some(x => x.code === 'due-c'), JSON.stringify(dz)); }
  gm.close();
  { const img2 = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
  const fp = (n, amt) => ({ mode: 'upi', amount: String(amt), date: '2026-11-25T10:00', txnId: 'PLANTXN' + n, imageId: img2 });
  let r2_;
  r2_ = await call('POST', 'orders', { phone: P(), code: 'plan-1', customer: 'x', total: 100000, firstPayment: fp('1', 5000), schedule: [{ date: '2030-03-01', amount: 50000 }, { date: '2030-02-01', amount: 50000 }] }, up); ok('order with a full plan is created', r2_.s === 200, JSON.stringify(r2_.j));
  r2_ = await call('GET', 'orders/mine', null, up); const po = (r2_.j.orders || []).find(o => o.code === 'plan-1'); ok('own orders show the next instalment due, soonest first', po && po.due && po.due.date === '2030-02-01' && po.due.amount === 45000 && po.due.overdue === false, JSON.stringify(po));
  r = await call('POST', 'orders', { phone: P(), code: 'plan-skip', customer: 'x', total: 100000, firstPayment: fp('skip1', 5000), noDue: true, skipDue: true }, up); ok('skipping the plan is allowed', r.s === 200 || r.s === 201);
  }
  { // plan added with a payment: matching goes straight in, a mismatch needs approval
    const imgP = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
    const mk = async (code, n) => { const r0 = await call('POST', 'orders', { phone: P(), code, customer: 'x', total: 100000, firstPayment: { mode: 'upi', amount: '20000', date: '2026-11-25T10:00', txnId: 'MM' + n, imageId: imgP }, skipDue: true, noDue: true }, up); return r0; };
    let r0 = await mk('mm-1', 'A1'); ok('order with plan skipped is created', r0.s === 200, JSON.stringify(r0.j));
    r0 = await call('POST', 'orders/mm-1/approve', {}, ow); ok('owner approves it', r0.s === 200, JSON.stringify(r0.j));
    r0 = await call('POST', 'payments', { mode: 'upi', amount: '20000', date: '2026-11-25T11:00', txnId: 'MM-A2', imageId: imgP, orderCode: 'mm-1', schedule: [{ date: '2030-05-01', amount: 40000 }, { date: '2030-06-01', amount: 20000 }], noDue: true }, up);
    ok('matching plan with a payment is saved at once', r0.s === 200 && /Payment plan saved/.test(r0.j.notice || ''), JSON.stringify(r0.j));
    r0 = await call('GET', 'orders/mine', null, up); const mo = (r0.j.orders || []).find(o => o.code === 'mm-1'); ok('next due follows the new plan', mo && mo.due && mo.due.date === '2030-05-01' && mo.due.amount === 40000, JSON.stringify(mo));
    r0 = await mk('mm-2', 'B1'); r0 = await call('POST', 'orders/mm-2/approve', {}, ow);
    r0 = await call('POST', 'payments', { mode: 'upi', amount: '20000', date: '2026-11-25T11:00', txnId: 'MM-B2', imageId: imgP, orderCode: 'mm-2', schedule: [{ date: '2030-05-01', amount: 30000 }], noDue: true }, up);
    ok('plan that does not match is sent for approval', r0.s === 200 && /does not match/.test(r0.j.notice || ''), JSON.stringify(r0.j));
    r0 = await call('GET', 'requests', null, ow); const rq = (r0.j.requests || []).find(x => x.orderCode === 'mm-2' && x.kind === 'change_plan'); ok('request is listed for the manager', !!rq);
    r0 = await call('POST', 'requests/' + rq.id + '/approve', {}, mg); ok('manager can approve a plan change', r0.s === 200, JSON.stringify(r0.j));
  }
  { const imgC = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
    let r0 = await call('POST', 'orders', { phone: P(), code: 'close-1', customer: 'x', total: 5000, firstPayment: { mode: 'upi', amount: '5000', date: '2026-11-25T10:00', txnId: 'CLOSE0001', imageId: imgC } }, up);
    r0 = await call('POST', 'orders/close-1/approve', {}, ow);
    r0 = await call('GET', 'payments?order=close-1', null, ow); const cp = (r0.j.payments || [])[0];
    r0 = await call('POST', 'payments/' + cp.id + '/verify', { note: 'seen in the bank app' }, mg);
    r0 = await call('GET', 'orders', null, ow); const co = (r0.j.orders || []).find(o => o.code === 'close-1');
    ok('order closes by itself once the last payment is validated', co && co.status === 'closed', JSON.stringify(co && co.status));
  }
  { const r0 = await call('POST', 'ocr', { text: 'Completed\n\u20b95,000\nRemarks: advance for DEMO-1001\nUPI transaction ID\n632912345678' }, up);
    ok('screenshot remark naming an open order is matched to it', r0.s === 200 && r0.j.parsed && r0.j.parsed.orderMatches && r0.j.parsed.orderMatches.includes('DEMO-1001'), JSON.stringify(r0.j)); }
  { const imgP = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id; const fpp = n => ({ mode: 'upi', amount: '1000', date: '2026-11-25T10:00', txnId: 'PH' + n, imageId: imgP });
    let r0 = await call('POST', 'orders', { phone: '98765432', code: 'ph-1', customer: 'x', total: 1000, firstPayment: fpp('1') }, up); ok('9-digit phone is refused', r0.s === 400 && r0.j.badPhone === true, JSON.stringify(r0.j));
    r0 = await call('POST', 'orders', { phone: '987654321012', code: 'ph-2', customer: 'x', total: 1000, firstPayment: fpp('2') }, up); ok('12-digit phone without +91 is refused', r0.s === 400 && r0.j.badPhone === true, JSON.stringify(r0.j));
    r0 = await call('POST', 'orders', { phone: '+91 98765 43211', code: 'ph-3', customer: 'x', total: 1000, firstPayment: fpp('3') }, up); ok('+91 and 10 digits is accepted', r0.s === 200, JSON.stringify(r0.j)); }
  { // business bank accounts: a statement must belong to one of them
    const imgA = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
    let r0 = await call('PUT', 'settings', { accounts: [{ name: 'HDFC Current', bank: 'HDFC', last4: '4321', upi: ['Shop@okhdfcbank', 'bad id'] }, { name: 'ICICI Savings', bank: 'ICICI', last4: '9876' }] }, ow); ok('owner saves two business accounts', r0.s === 200, JSON.stringify(r0.j));
    r0 = await call('PUT', 'settings', { accounts: [{ name: 'Bad', last4: '12' }] }, ow); ok('account without 4 digits is refused', r0.s === 400);
    r0 = await call('GET', 'settings', null, mg); const accs = r0.j.settings.accounts || []; ok('manager sees the accounts (UPI IDs cleaned)', accs.length === 2 && accs.find(a => a.last4 === '4321').upi.join() === 'shop@okhdfcbank', JSON.stringify(r0.j.settings.accounts));
    const hdfc = accs.find(a => a.last4 === '4321').id, icici = accs.find(a => a.last4 === '9876').id;
    const o1 = await call('POST', 'orders', { phone: '9300000001', code: 'acct-1', customer: 'x', total: 3000, firstPayment: { mode: 'upi', amount: '3000', date: '2026-11-25T10:00', txnId: 'ACCT0001', imageId: imgA } }, up); await call('POST', 'orders/acct-1/approve', {}, ow);
    const rows = [{ date: '2026-11-25', amount: 3000, ref: 'ACCT0001', desc: 'UPI' }];
    r0 = await call('POST', 'statement', { rows }, mg); ok('statement without an account choice is refused', r0.s === 400 && r0.j.needAccount === true, JSON.stringify(r0.j));
    r0 = await call('POST', 'statement', { rows, accountId: hdfc, headText: 'Account No: XXXXXXXX7777\nAccount Name: RAMESH PERSONAL' }, mg); ok('statement of a different account is refused', r0.s === 409 && r0.j.wrongAccount === true, JSON.stringify(r0.j));
    r0 = await call('POST', 'statement', { rows, accountId: hdfc, headText: '' }, mg); ok('file that does not show the account needs a confirmation', r0.s === 409 && r0.j.needConfirm === true, JSON.stringify(r0.j));
    r0 = await call('POST', 'statement', { rows, accountId: hdfc, headText: 'A/c No: XXXXXXXX4321' }, mg); ok('digits alone are not enough: name and bank missing needs confirmation', r0.s === 409 && r0.j.needConfirm === true && r0.j.missing.length === 2, JSON.stringify(r0.j));
    r0 = await call('POST', 'statement', { rows, accountId: hdfc, headText: 'HDFC Bank Statement\nAccount Name: HDFC Current\nA/c No: XXXXXXXX4321' }, mg); ok('statement showing digits, name and bank validates the payment', r0.s === 200 && r0.j.matched.length === 1, JSON.stringify(r0.j));
    r0 = await call('GET', 'summary?period=all&account=' + hdfc, null, mg); const inH = r0.j.received; r0 = await call('GET', 'summary?period=all&account=' + icici, null, mg); const inI = r0.j.received;
    r0 = await call('GET', 'orders/acct-1', null, mg); ok('payment row says which account it was received in', (r0.j.payments || []).some(p => /Received in HDFC HDFC Current ····4321/.test(p.account || '')), JSON.stringify((r0.j.payments || []).map(p => p.account)));
    ok('summary can be limited to one account', inH >= 3000 && inI === 0, JSON.stringify([inH, inI]));
    r0 = await call('PUT', 'settings', { accounts: [] }, ow); }
  { // more than one business system
    let r1 = await call('PUT', 'settings', { extraSystems: [{ name: 'Accounts', url: 'https://example.com/hook', key: 'k1' }, { name: 'CRM', url: 'https://crm.example.com/hook' }] }, ow); ok('owner saves two extra systems', r1.s === 200, JSON.stringify(r1.j));
    r1 = await call('GET', 'settings', null, ow); const ex = r1.j.settings.connectors.extra; ok('extra systems listed, key never returned', ex.length === 2 && ex[0].keySet === true && !('key' in ex[0]), JSON.stringify(ex));
    r1 = await call('PUT', 'settings', { extraSystems: [] }, ow); }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL API TESTS PASSED');
  srv.close(); mock.close(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
