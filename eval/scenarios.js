'use strict';
// Ten business scenarios on demo data, run against the real API. Run: node eval/scenarios.js
process.env.ALLOW_LOCAL_CONNECTORS = '1';
const { start } = require('../test/serve');
let base; const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function call(method, path, body, tok) {
  const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) { /* none */ } return { s: r.status, j };
}
const login = async u => (await call('POST', 'login', { username: u, password: 'demo1234' })).j.token;
let ph = 9100000000; const P = () => String(++ph); const results = [];
const scen = (id, title, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${pass ? '' : '  -> ' + detail}`); };
(async () => {
  const srv = await start(0); base = 'http://localhost:' + srv.address().port;
  const up = await login('uploader'), mg = await login('manager'), ow = await login('owner');
  const img = (await call('POST', 'images', { dataUrl: PNG }, up)).j.id;
  const pay = (code, n, amt, extra = {}) => ({ orderCode: code, mode: 'upi', amount: String(amt), date: '2026-11-25T10:00', txnId: n, imageId: img, ...extra });
  const mkOrder = async (code, total, first, n, extra = {}) => { const r = await call('POST', 'orders', { phone: P(), code, customer: 'Eval ' + code, total, firstPayment: { mode: 'upi', amount: String(first), date: '2026-11-25T10:00', txnId: n, imageId: img }, ...extra }, up); if (r.s === 200) await call('POST', `orders/${code}/approve`, {}, ow); return r; };
  const order = async code => ((await call('GET', 'orders', null, ow)).j.orders || []).find(o => o.code === code);
  let r;

  // S01 full payment in one go, matched on the bank statement, order closes by itself
  r = await mkOrder('S01', 20000, 20000, 'EV-S01-A', { skipDue: true });
  await call('POST', 'statement', { rows: [{ date: '2026-11-25', amount: 20000, ref: 'EV-S01-A', desc: 'UPI' }] }, mg);
  let o = await order('S01'); scen('S01', 'Full payment, found on the bank statement: order validated and closed', o && o.status === 'closed', JSON.stringify(o && [o.status, o.validation]));

  // S02 advance then a full plan that adds up: next due follows the plan
  r = await mkOrder('S02', 100000, 20000, 'EV-S02-A', { schedule: [{ date: '2030-02-01', amount: 40000 }, { date: '2030-03-01', amount: 40000 }], skipDue: undefined });
  r = await call('GET', 'orders/mine', null, up); o = (r.j.orders || []).find(x => x.code === 'S02');
  scen('S02', 'Plan on the order: next due date and amount are right', !!o && !!o.due && o.due.date === '2030-02-01' && o.due.amount === 20000, JSON.stringify(o && o.due));

  // S03 skipped plan, customer pays later with a plan that matches what is due
  await mkOrder('S03', 100000, 20000, 'EV-S03-A', { skipDue: true });
  r = await call('POST', 'payments', pay('S03', 'EV-S03-B', 20000, { schedule: [{ date: '2030-05-01', amount: 40000 }, { date: '2030-06-01', amount: 20000 }] }), up);
  scen('S03', 'Plan added with a later payment, matches what is due: saved at once', r.s === 200 && /Payment plan saved/.test(r.j.notice || ''), JSON.stringify(r.j));

  // S04 plan that does not match: goes to manager or owner, either can approve
  await mkOrder('S04', 100000, 20000, 'EV-S04-A', { skipDue: true });
  r = await call('POST', 'payments', pay('S04', 'EV-S04-B', 20000, { schedule: [{ date: '2030-05-01', amount: 30000 }] }), up);
  const rq = ((await call('GET', 'requests', null, mg)).j.requests || []).find(x => x.orderCode === 'S04' && x.kind === 'change_plan');
  const ap = rq && await call('POST', `requests/${rq.id}/approve`, {}, mg);
  scen('S04', 'Plan that does not match: payment saved, plan waits for a manager, manager approves', r.s === 200 && /does not match/.test(r.j.notice || '') && !!rq && ap.s === 200, JSON.stringify([r.s, !!rq, ap && ap.s]));

  // S05 same transaction ID used twice
  await mkOrder('S05', 50000, 10000, 'EV-S05-A', { skipDue: true });
  r = await call('POST', 'payments', pay('S05', 'EV-S05-A', 10000, { nextDue: '2030-01-01' }), up);
  scen('S05', 'Same transaction ID again is refused as a duplicate', r.s === 409 && r.j.duplicate === true, JSON.stringify([r.s, r.j]));

  // S06 payment with no transaction ID
  r = await call('POST', 'payments', pay('S05', '', 5000, { nextDue: '2030-01-01' }), up);
  scen('S06', 'UPI payment with no transaction ID cannot be saved', r.s === 400 && r.j.needTxn === true, JSON.stringify([r.s, r.j]));

  // S07 cash waits for the owner and the order does not close until approved
  await mkOrder('S07', 15000, 5000, 'EV-S07-A', { skipDue: true });
  r = await call('POST', 'payments', { orderCode: 'S07', mode: 'cash', amount: '10000', date: '2026-11-25T11:00', nextDue: '2030-01-01' }, up);
  o = await order('S07'); const waiting = o && o.status === 'open';
  scen('S07', 'Cash entry waits for owner approval (order stays open)', r.s === 200 && waiting, JSON.stringify([r.s, o && o.status]));

  // S08 bank statement has the wrong amount: not matched, never marked as paid
  await mkOrder('S08', 8000, 8000, 'EV-S08-A', { skipDue: true });
  r = await call('POST', 'statement', { rows: [{ date: '2026-11-25', amount: 800, ref: 'EV-S08-A', desc: 'UPI' }] }, mg);
  o = await order('S08'); scen('S08', 'Statement amount differs: payment is not marked validated', o && o.status === 'open' && o.validation !== 'validated', JSON.stringify(o && [o.status, o.validation]));

  // S09 uploader cannot see other people's money
  scen('S09', 'Uploader cannot open the order list or the summary', (await call('GET', 'orders', null, up)).s === 403 && (await call('GET', 'summary', null, up)).s === 403, '');

  // S10 manager asks to change an order total: goes to the owner, not applied yet
  r = await call('POST', 'orders/S02/adjust', { kind: 'change_total', newTotal: 90000, comment: 'Customer got a discount' }, mg);
  o = await order('S02'); scen('S10', 'Manager changes an order total: waits for the owner, total unchanged until approved', r.s === 200 && r.j.requested === true && o.total === 100000, JSON.stringify([r.s, r.j, o && o.total]));

  srv.close(); const fails = results.filter(x => !x).length;
  console.log(`\n${results.length - fails}/${results.length} scenarios passed.`); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
