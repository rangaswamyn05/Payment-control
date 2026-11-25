'use strict';
/* Payment Control: single-page app. No build step, no dependencies. */
const $app = document.getElementById('app');
const S = { tok: localStorage.getItem('pc_tok') || '', user: null, health: null, add: null, badge: 0 };
const RANK = { uploader: 1, manager: 2, owner: 3 };
const ICON = { shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5L15.5 10"/></svg>', back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>', img: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0B6E66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>' };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fdate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(d || '');
  if (!m) return d || '';
  let s = `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}`;
  if (m[4]) { let h = +m[4]; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; s += `, ${h}:${m[5]} ${ap}`; }
  return s;
}
const MODE = { upi: 'UPI', transfer: 'Bank transfer', cash: 'Cash' };
const STATUS = {
  client_reported: ['Awaiting verification', 'warn'], verified: ['Verified', 'good'], cash_pending: ['Cash to confirm', 'warn'],
  cash_confirmed: ['Cash confirmed', 'good'], flagged: ['Flagged', 'bad'], rejected: ['Rejected', ''],
};
const REASON = { possible_duplicate: 'Possible duplicate', no_matching_credit: 'No matching credit' };
function statusBadge(p) {
  const [t, c] = STATUS[p.status] || [p.status, ''];
  const extra = p.status === 'flagged' ? ': ' + (REASON[p.reason] || p.reason || '') : '';
  return `<span class="badge ${c}">${esc(t + extra)}</span>`;
}
function orderBadge(o) {
  if (o.status === 'pending') return '<span class="badge">Pending approval</span>';
  if (o.status === 'rejected') return '<span class="badge">Rejected</span>';
  if (o.status === 'closed') return '<span class="badge">Closed</span>';
  if (o.flaggedCount) return '<span class="badge bad">Flagged</span>';
  if (o.pendingCash) return '<span class="badge warn">Cash to confirm</span>';
  if (o.awaiting) return '<span class="badge warn">Awaiting verification</span>';
  if (o.outstandingVerified === 0) return '<span class="badge good">Ready to close</span>';
  return '<span class="badge">Open</span>';
}

// ---------- api / ui helpers ----------
async function api(method, path, body) {
  const r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(S.tok ? { Authorization: 'Bearer ' + S.tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) { /* not json */ }
  if (r.status === 401 && S.tok && path !== 'login') { logout(); throw new Error(j.error || 'Please sign in again'); }
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.data = j; e.status = r.status; throw e; }
  return j;
}
let toastT;
function toast(msg, bad) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(() => t.remove(), bad ? 6000 : 3500);
}
function modal(html) {
  const ov = document.createElement('div'); ov.className = 'ov'; ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') { close(); ov._resolve && ov._resolve(null); } };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', e => { if (e.target === ov) { close(); ov._resolve && ov._resolve(null); } });
  document.body.appendChild(ov);
  return { ov, close };
}
function ask({ title, label, text, ok = 'Confirm', danger, required = true, minLen = 3 }) {
  return new Promise(resolve => {
    const { ov, close } = modal(`<h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}<div class="field"><label for="askv">${esc(label)}</label><textarea id="askv" class="in" rows="3"></textarea><div class="err" id="askerr" style="min-height:18px"></div></div><div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? 'd' : 'p'}" data-x="yes">${esc(ok)}</button></div>`);
    ov._resolve = resolve;
    const ta = ov.querySelector('#askv'); ta.focus();
    ov.addEventListener('click', e => {
      const x = e.target.closest('[data-x]'); if (!x) return;
      if (x.dataset.x === 'no') { close(); return resolve(null); }
      const v = ta.value.trim();
      if (required && v.length < minLen) { ov.querySelector('#askerr').textContent = 'Please write a few words.'; return; }
      close(); resolve(v);
    });
  });
}
function confirmBox({ title, text, ok = 'Confirm', danger }) {
  return new Promise(resolve => {
    const { ov, close } = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? 'd' : 'p'}" data-x="yes">${esc(ok)}</button></div>`);
    ov._resolve = resolve;
    ov.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (!x) return; close(); resolve(x.dataset.x === 'yes'); });
  });
}
const imgUrl = id => `/api/images/${encodeURIComponent(id)}?t=${encodeURIComponent(S.tok)}`;

function logout() { S.tok = ''; S.user = null; localStorage.removeItem('pc_tok'); S.add = null; location.hash = '#/login'; render(); }
const go = h => { location.hash = h; };
function backBtn(fallback) { return `<button class="back" data-act="back" data-fallback="${fallback || '#/'}">${ICON.back}Back</button>`; }

function shell(active, inner) {
  const u = S.user; const mgr = RANK[u.role] >= RANK.manager;
  const items = [];
  if (mgr) items.push(['#/', 'Dashboard'], ['#/orders', 'Orders'], ['#/payments', 'Payments'], ['#/review', 'Review' + (S.badge ? `<span class="pill">${S.badge}</span>` : '')], ['#/statement', 'Statement']);
  if (!mgr) items.push(['#/new-order', 'New order']);
  items.push(['#/add', 'Add payment'], ['#/mine', mgr ? 'My entries' : 'My submissions']);
  if (mgr) items.push(['#/audit', 'Audit log']);
  if (u.role === 'owner') items.push(['#/team', 'Team'], ['#/settings', 'Settings']);
  const nav = items.map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('');
  return `<header class="top"><div class="brand"><div class="logo">${ICON.shield}</div><span>Payment Control</span></div><nav class="nav" aria-label="Main">${nav}</nav><div class="me"><div style="text-align:right"><div style="font-weight:600">${esc(u.name)}</div><div class="muted" style="font-size:12px;text-transform:capitalize">${esc(u.role)} · <a href="#/login" data-act="logout" style="text-decoration:underline">Sign out</a></div></div><div class="av">${esc(u.name[0] || '?')}</div></div></header>${S.health && S.health.db === 'memory' ? '<div class="note warn" style="border-radius:0;text-align:center">Demo storage: data is not saved permanently until the database is connected.</div>' : ''}<main class="wrap">${inner}</main>`;
}

// ---------- views ----------
function viewLogin() {
  const demo = S.health && S.health.demo;
  const setup = S.health && S.health.needsSetup;
  return { html: `<div class="login"><div class="logo" style="width:48px;height:48px;border-radius:12px">${ICON.shield.replace('width="18" height="18"', 'width="28" height="28"')}</div><h1 style="margin-top:14px">Payment Control</h1><p class="muted" style="margin:4px 0 20px">Know that every payment reached the business.</p>
  <form class="card" id="lf" autocomplete="on">${setup ? '<h2 style="margin-bottom:12px">Create the owner account</h2><div class="field"><label for="nm">Your name</label><input id="nm" class="in" autocomplete="name"></div>' : ''}
  <div class="field"><label for="un">Username</label><input id="un" class="in" autocomplete="username" autocapitalize="none" spellcheck="false"></div>
  <div class="field"><label for="pw">Password${setup ? ' <span class="opt">(at least 8 characters)</span>' : ''}</label><input id="pw" type="password" class="in" autocomplete="${setup ? 'new-password' : 'current-password'}"></div>
  <div class="err" id="lerr" style="min-height:18px;margin-bottom:6px"></div><button class="btn p" style="width:100%" type="submit">${setup ? 'Create account' : 'Sign in'}</button></form>
  ${demo ? '<div class="note" style="margin-top:16px"><b>Demo logins</b><div style="margin-top:4px">Usernames: owner, manager, uploader. Password: demo1234</div></div>' : ''}
  <p class="muted" style="font-size:13px;margin-top:16px">Uploaders add payments. Managers see balances and confirm cash. Owners manage people and settings.</p></div>`,
    after() {
      const f = document.getElementById('lf');
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = document.getElementById('lerr'); err.textContent = '';
        try {
          const r = setup
            ? await api('POST', 'setup', { name: document.getElementById('nm').value, username: document.getElementById('un').value, password: document.getElementById('pw').value })
            : await api('POST', 'login', { username: document.getElementById('un').value, password: document.getElementById('pw').value });
          S.tok = r.token; S.user = r.user; localStorage.setItem('pc_tok', S.tok);
          go(RANK[S.user.role] >= RANK.manager ? '#/' : '#/add'); render();
        } catch (ex) { err.textContent = ex.message; }
      });
    } };
}

const periodName = m => m === 'all' ? 'all time' : /^\d{4}$/.test(m) ? m : monthName(m);
const monthName = m => { const x = /^(\d{4})-(\d{2})$/.exec(m); return x ? ['January','February','March','April','May','June','July','August','September','October','November','December'][+x[2]-1] + ' ' + x[1] : m; };
async function viewDashboard(month) {
  month = month || new Date().toISOString().slice(0, 7);
  const s = await api('GET', 'summary?period=' + month);
  const kind = month === 'all' ? 'all' : /^\d{4}$/.test(month) ? 'year' : 'month';
  const yr = (month === 'all' ? new Date().toISOString().slice(0, 4) : month.slice(0, 4));
  const yrs = []; for (let y = +new Date().toISOString().slice(0, 4); y >= 2020; y--) yrs.push(y);
  S.badge = s.flaggedCount + s.cashPendingCount + s.pendingOrders;
  const tot = s.byStatus.verified + s.byStatus.awaiting + s.byStatus.flagged;
  const pc = v => tot ? Math.round(v * 100 / tot) : 0;
  const rows = s.top.map(o => `<a class="tr" href="#/orders/${encodeURIComponent(o.code)}"><div class="c1"><b>${esc(o.code)}</b><div class="muted" style="font-size:13px">${esc(o.customer)}</div></div><div class="c r">${inr(o.total)}</div><div class="c r">${inr(o.verified)}</div><div class="c r"><b>${inr(o.outstanding)}</b></div><div class="c">${orderBadge(o)}</div></a>`).join('');
  return { active: '#/', html: `<div class="head"><div><h1>Dashboard</h1><div class="muted">Every payment, matched to an order and checked against the bank.</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="pk" class="in" style="width:auto;min-height:44px" aria-label="View by"><option value="month"${kind === 'month' ? ' selected' : ''}>Month</option><option value="year"${kind === 'year' ? ' selected' : ''}>Year</option><option value="all"${kind === 'all' ? ' selected' : ''}>Overall</option></select>${kind === 'month' ? `<input id="mo" type="month" class="in" style="width:auto;min-height:44px" value="${esc(s.month)}" aria-label="Month">` : kind === 'year' ? `<select id="yr" class="in" style="width:auto;min-height:44px" aria-label="Year">${yrs.map(y => `<option${String(y) === month ? ' selected' : ''}>${y}</option>`).join('')}</select>` : ''}</div></div>
  <div class="row" style="margin-bottom:16px">
   <div class="card kpi"><div class="l">Outstanding from clients</div><div class="v">${inr(s.outstanding)}</div><div class="muted">across ${s.openOrders} open order${s.openOrders === 1 ? '' : 's'}</div></div>
   <div class="card kpi"><div class="l">Awaiting bank verification</div><div class="v">${inr(s.awaiting)}</div><div class="muted">claimed by screenshot, not yet in a statement</div></div>
   <div class="card kpi"><div class="l">Received${s.month === 'all' ? ' overall' : ' in ' + esc(periodName(s.month))}</div><div class="v">${inr(s.received)}</div><div class="muted">Online ${inr(s.receivedOnline)} · Cash ${inr(s.receivedCash)}</div></div>
   <a class="card kpi alert" href="#/review"><div class="l">Needs your review</div><div class="v">${s.flaggedCount + s.cashPendingCount} item${s.flaggedCount + s.cashPendingCount === 1 ? '' : 's'}</div><div class="muted">${s.flaggedCount} flagged · ${s.cashPendingCount} cash to confirm</div></a></div>
  <div class="grid2"><div class="card a"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>Largest outstanding balances</h2><a href="#/orders" style="color:var(--acc);font-weight:600">View all orders</a></div>
   ${rows ? `<div class="tbl"><div class="tr h"><div class="c1">Order</div><div class="c r">Total</div><div class="c r">Verified</div><div class="c r">Outstanding</div><div class="c">Status</div></div>${rows}</div>` : '<p class="muted">No open orders with a balance. Create an order to start.</p>'}</div>
   <div class="card b"><h2 style="margin-bottom:14px">${s.month === 'all' ? 'Overall' : esc(periodName(s.month))} by status</h2><div class="bar" aria-hidden="true"><i style="width:${pc(s.byStatus.verified)}%;background:#12B76A"></i><i style="width:${pc(s.byStatus.awaiting)}%;background:#F79009"></i><i style="width:${pc(s.byStatus.flagged)}%;background:#D92D20"></i></div>
   <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between"><span><span class="dot" style="background:#12B76A"></span>Verified</span><b>${inr(s.byStatus.verified)}</b></div><div style="display:flex;justify-content:space-between"><span><span class="dot" style="background:#F79009"></span>Awaiting verification</span><b>${inr(s.byStatus.awaiting)}</b></div><div style="display:flex;justify-content:space-between"><span><span class="dot" style="background:#D92D20"></span>Flagged</span><b>${inr(s.byStatus.flagged)}</b></div></div>
   <div class="muted" style="border-top:1px solid var(--line);margin-top:18px;padding-top:14px;font-size:13px">Cash entries stay pending until a second person confirms them. <a href="#/statement" style="color:var(--acc);font-weight:600">Upload a bank statement</a> to verify the amounts waiting.</div></div></div>`,
    after() {
      const set = v => { S.month = v; render(); };
      document.getElementById('pk').addEventListener('change', e => { const k = e.target.value; set(k === 'all' ? 'all' : k === 'year' ? yr : new Date().toISOString().slice(0, 7)); });
      const mo = document.getElementById('mo'); if (mo) mo.addEventListener('change', e => { if (e.target.value) set(e.target.value); });
      const ys = document.getElementById('yr'); if (ys) ys.addEventListener('change', e => set(e.target.value));
    } };
}

async function viewOrders() {
  const { orders } = await api('GET', 'orders');
  const list = q => orders.filter(o => !q || (o.code + ' ' + o.customer).toLowerCase().includes(q.toLowerCase()));
  const draw = q => list(q).map(o => `<a class="tr" href="#/orders/${encodeURIComponent(o.code)}"><div class="c1"><b>${esc(o.code)}</b>${o.demo ? ' <span class="badge">Demo</span>' : ''}<div class="muted" style="font-size:13px">${esc(o.customer)}</div></div><div class="c r">${inr(o.total)}</div><div class="c r">${inr(o.verified)}</div><div class="c r">${inr(o.awaiting)}</div><div class="c r"><b>${inr(o.outstanding)}</b></div><div class="c">${orderBadge(o)}</div></a>`).join('') || '<p class="muted" style="padding:12px 0">No orders match.</p>';
  return { active: '#/orders', html: `<div class="head"><div><h1>Orders</h1><div class="muted">${orders.length} order${orders.length === 1 ? '' : 's'}</div></div><button class="btn p" data-act="newOrder">New order</button></div>
  <div class="card" id="newbox" style="display:none;margin-bottom:16px"><h2 style="margin-bottom:12px">New order</h2><form id="nf"><div class="row"><div class="field" style="flex:1 1 160px"><label for="oc">Order ID <span class="opt">(blank = automatic)</span></label><input id="oc" class="in" autocapitalize="characters"></div><div class="field" style="flex:2 1 220px"><label for="ocu">Client name</label><input id="ocu" class="in" required></div><div class="field" style="flex:1 1 160px"><label for="ot">Order total (₹)</label><input id="ot" class="in" inputmode="decimal" required></div></div><div class="err" id="nerr" style="min-height:18px"></div><button class="btn p" type="submit">Create order</button></form></div>
  <div class="card"><div class="field"><label for="q" class="muted">Search</label><input id="q" class="in" placeholder="Order ID or client name" style="max-width:360px"></div><div class="tbl"><div class="tr h"><div class="c1">Order</div><div class="c r">Total</div><div class="c r">Verified</div><div class="c r">Awaiting</div><div class="c r">Outstanding</div><div class="c">Status</div></div><div id="ol">${draw('')}</div></div></div>`,
    after() {
      document.getElementById('q').addEventListener('input', e => { document.getElementById('ol').innerHTML = draw(e.target.value); });
      document.getElementById('nf').addEventListener('submit', async e => {
        e.preventDefault(); const er = document.getElementById('nerr'); er.textContent = '';
        try { const r = await api('POST', 'orders', { code: document.getElementById('oc').value, customer: document.getElementById('ocu').value, total: document.getElementById('ot').value.replace(/,/g, '') }); toast('Order ' + r.order.code + ' created'); go('#/orders/' + encodeURIComponent(r.order.code)); } catch (ex) { er.textContent = ex.message; }
      });
    } };
}

function viewNewOrder() {
  if (S.newOrder) { const d = S.newOrder; return { active: '#/new-order', html: `<div style="max-width:520px;margin:0 auto"><div class="card" style="text-align:center;padding:32px 20px"><div style="width:56px;height:56px;border-radius:28px;background:var(--goodbg);color:var(--good);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:28px" aria-hidden="true">✓</div><h1 style="font-size:24px">Sent for approval</h1><p class="muted"><b>${esc(d.code)}</b> for ${esc(d.customer)}<br>A manager must approve it before payments can be added.</p><div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px"><button class="btn p" data-act="anotherOrder">Create another</button><a class="btn" href="#/add">Add payment</a></div></div></div>` }; }
  return { active: '#/new-order', html: `<div style="max-width:520px;margin:0 auto"><div class="head" style="margin-bottom:12px"><h1 style="font-size:24px">New order</h1></div><div class="card"><form id="nf"><div class="field"><label for="ocu">Client name</label><input id="ocu" class="in" required></div><div class="field"><label for="ot">Order total (₹)</label><input id="ot" class="in" inputmode="decimal" required></div><div class="field"><label for="oc">Order ID <span class="opt">(blank = automatic)</span></label><input id="oc" class="in" autocapitalize="characters"></div><div class="err" id="nerr" style="min-height:18px"></div><button class="btn p" type="submit" style="width:100%">Create order</button></form></div></div>`,
    after() { document.getElementById('nf').addEventListener('submit', async e => {
      e.preventDefault(); const er = document.getElementById('nerr'); er.textContent = '';
      try { const r = await api('POST', 'orders', { code: document.getElementById('oc').value, customer: document.getElementById('ocu').value, total: document.getElementById('ot').value.replace(/,/g, '') }); S.newOrder = r.order; render(); } catch (ex) { er.textContent = ex.message; }
    }); } };
}

function payActions(p, o) {
  const a = [];
  if (p.status === 'cash_pending') a.push(p.createdBy === S.user.id ? '<span class="muted" style="font-size:12px">You logged this, so someone else must confirm it</span>' : `<button class="btn s p" data-act="confirmCash" data-id="${p.id}">Confirm cash received</button>`);
  if (p.status === 'client_reported') a.push(p.createdBy === S.user.id ? '' : `<button class="btn s" data-act="verify" data-id="${p.id}">Verify manually</button>`);
  if (p.status === 'flagged') a.push(`<button class="btn s" data-act="release" data-id="${p.id}">Keep it</button>`);
  if (p.status !== 'rejected' && p.status !== 'verified' && p.status !== 'cash_confirmed') a.push(`<button class="btn s d" data-act="reject" data-id="${p.id}">Reject</button>`);
  return a.join(' ');
}

async function viewOrder(code) {
  const { order: o, payments } = await api('GET', 'orders/' + encodeURIComponent(code));
  const pct = v => o.total ? Math.min(100, Math.round(v * 100 / o.total)) : 0;
  const rows = payments.map(p => `<div class="tr" style="min-width:820px"><div class="c" style="flex:1.2">${esc(fdate(p.date))}</div><div class="c" style="flex:.8">${esc(MODE[p.mode] || p.mode)}</div><div class="c r" style="flex:1"><b>${inr(p.amount)}</b></div><div class="c" style="flex:1.3;color:var(--muted);word-break:break-all">${esc(p.txnId || '')}</div><div class="c" style="flex:1.1">${esc(p.createdByName || '')}</div><div class="c" style="flex:1.2">${statusBadge(p)}</div><div class="c" style="flex:.6">${p.imageId ? `<button class="btn s" data-act="showImg" data-id="${p.imageId}">View</button>` : ''}</div><div class="c" style="flex:1.8;display:flex;gap:6px;flex-wrap:wrap">${payActions(p, o)}</div></div>`).join('');
  const closed = o.status === 'closed';
  const blockers = [];
  if (!closed) { if (o.outstandingVerified > 0) blockers.push(inr(o.outstandingVerified) + ' not yet verified'); if (o.flaggedCount) blockers.push(o.flaggedCount + ' flagged'); if (o.pendingCash) blockers.push(o.pendingCash + ' cash to confirm'); }
  const canClose = !closed && !blockers.length;
  return { active: '#/orders', html: `${backBtn('#/orders')}<div class="head"><div><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h1>${esc(o.code)}</h1>${orderBadge(o)}${o.demo ? '<span class="badge">Demo</span>' : ''}</div><div class="muted">${esc(o.customer)} · created ${esc(fdate(o.created.slice(0, 10)))}</div></div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">${closed ? '<button class="btn" data-act="reopen" data-code="' + esc(o.code) + '">Reopen order</button>' : `<button class="btn ${canClose ? 'p' : ''}" data-act="closeOrder" data-code="${esc(o.code)}" ${canClose || S.user.role === 'owner' ? '' : 'disabled'}>Close order</button>${blockers.length ? `<div class="err">Cannot close: ${esc(blockers.join('; '))}${S.user.role === 'owner' ? ' (owner can override)' : ''}</div>` : ''}`}</div></div>
  <div class="card" style="margin-bottom:16px"><div class="row" style="gap:16px 40px;margin-bottom:16px"><div><div class="muted">Order total</div><div style="font-size:24px;font-weight:700">${inr(o.total)}</div>${S.user.role === 'owner' ? `<button class="btn s" data-act="editTotal" data-code="${esc(o.code)}" data-total="${o.total}" style="margin-top:6px">Change total</button>` : ''}</div><div><div class="muted">Verified</div><div style="font-size:24px;font-weight:700;color:var(--good)">${inr(o.verified)}</div></div><div><div class="muted">Awaiting verification</div><div style="font-size:24px;font-weight:700;color:var(--warn)">${inr(o.awaiting)}</div></div><div><div class="muted">Outstanding</div><div style="font-size:24px;font-weight:700">${inr(o.outstanding)}</div></div>${o.flagged ? `<div><div class="muted">Flagged</div><div style="font-size:24px;font-weight:700;color:var(--bad)">${inr(o.flagged)}</div></div>` : ''}</div>
  <div class="bar" aria-hidden="true"><i style="width:${pct(o.verified)}%;background:#12B76A"></i><i style="width:${pct(o.awaiting)}%;background:#F79009"></i></div><div class="muted" style="margin-top:8px;font-size:13px">An order can close only when verified payments equal the total. Flagged payments are not counted.</div></div>
  <div class="card"><h2 style="margin-bottom:8px">Payments on this order</h2>${rows ? `<div class="tbl"><div class="tr h" style="min-width:820px"><div class="c" style="flex:1.2">Date</div><div class="c" style="flex:.8">Mode</div><div class="c r" style="flex:1">Amount</div><div class="c" style="flex:1.3">Reference</div><div class="c" style="flex:1.1">Logged by</div><div class="c" style="flex:1.2">Status</div><div class="c" style="flex:.6">Proof</div><div class="c" style="flex:1.8"></div></div>${rows}</div>` : '<p class="muted">No payments yet.</p>'}<div class="muted" style="margin-top:12px;font-size:13px">Every change is recorded in the <a href="#/audit" style="text-decoration:underline">audit log</a>.</div></div>`, after() { } };
}

async function viewPayments() {
  const st = S.pfilter || '';
  const { payments } = await api('GET', 'payments' + (st ? '?status=' + st : ''));
  const rows = payments.map(p => `<a class="tr" href="#/orders/${encodeURIComponent(p.orderCode)}" style="min-width:760px"><div class="c" style="flex:1.2">${esc(fdate(p.date))}</div><div class="c1"><b>${esc(p.orderCode)}</b><div class="muted" style="font-size:13px">${esc(p.customer)}</div></div><div class="c">${esc(MODE[p.mode] || p.mode)}</div><div class="c r"><b>${inr(p.amount)}</b></div><div class="c" style="color:var(--muted);word-break:break-all">${esc(p.txnId || '')}</div><div class="c">${esc(p.createdByName || '')}</div><div class="c">${statusBadge(p)}</div></a>`).join('');
  const opts = [['', 'All'], ['client_reported', 'Awaiting verification'], ['verified', 'Verified'], ['cash_pending', 'Cash to confirm'], ['cash_confirmed', 'Cash confirmed'], ['flagged', 'Flagged'], ['rejected', 'Rejected']].map(([v, t]) => `<option value="${v}" ${v === st ? 'selected' : ''}>${t}</option>`).join('');
  return { active: '#/payments', html: `<div class="head"><div><h1>Payments</h1><div class="muted">${payments.length} shown</div></div><div><label for="pf" class="muted" style="display:inline;margin-right:8px">Show</label><select id="pf" class="in" style="width:auto">${opts}</select></div></div><div class="card"><div class="tbl"><div class="tr h" style="min-width:760px"><div class="c" style="flex:1.2">Date</div><div class="c1">Order</div><div class="c">Mode</div><div class="c r">Amount</div><div class="c">Reference</div><div class="c">Logged by</div><div class="c">Status</div></div>${rows || '<p class="muted" style="padding:12px 0">Nothing here.</p>'}</div></div>`,
    after() { document.getElementById('pf').addEventListener('change', e => { S.pfilter = e.target.value; render(); }); } };
}

async function viewReview() {
  const [{ payments: all }, { orders: allOrders }] = await Promise.all([api('GET', 'payments'), api('GET', 'orders')]);
  const toApprove = allOrders.filter(o => o.status === 'pending');
  const cash = all.filter(p => p.status === 'cash_pending'), flags = all.filter(p => p.status === 'flagged'), wait = all.filter(p => p.status === 'client_reported');
  S.badge = cash.length + flags.length + toApprove.length;
  const item = p => `<div style="border-top:1px solid #EEF2F6;padding:14px 0"><div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px"><div><b>${inr(p.amount)}</b> · <a href="#/orders/${encodeURIComponent(p.orderCode)}" style="color:var(--acc);font-weight:600">${esc(p.orderCode)}</a><div class="muted" style="font-size:13px">${esc(p.customer)} · ${esc(MODE[p.mode])} · ${esc(fdate(p.date))} · logged by ${esc(p.createdByName)}</div></div>${statusBadge(p)}</div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${p.imageId ? `<button class="btn s" data-act="showImg" data-id="${p.imageId}">View proof</button>` : ''}${payActions(p)}</div></div>`;
  return { active: '#/review', html: `<div class="head"><div><h1>Needs your review</h1><div class="muted">Cash can only be confirmed by someone other than the person who logged it.</div></div></div>
  ${toApprove.length ? `<div class="card a" style="margin-bottom:16px"><h2>Orders to approve <span class="muted" style="font-weight:500">· ${toApprove.length}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">Created by the sales team. Payments can be added only after you approve the order and its total.</div>${toApprove.map(o => `<div style="border-top:1px solid #EEF2F6;padding:14px 0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center"><div><b>${esc(o.code)}</b> · ${esc(o.customer)}<div class="muted" style="font-size:13px">Total ${inr(o.total)}</div></div><div style="display:flex;gap:8px"><button class="btn s p" data-act="approveOrder" data-code="${esc(o.code)}">Approve</button><button class="btn s" data-act="rejectOrder" data-code="${esc(o.code)}">Reject</button></div></div>`).join('')}</div>` : ''}
  <div class="grid2"><div class="card a" style="flex-basis:480px"><h2>Cash to confirm <span class="muted" style="font-weight:500">· ${cash.length}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">Reported by the client. The system cannot check cash, so a named person confirms it.</div>${cash.map(item).join('') || '<p class="muted">Nothing waiting.</p>'}</div>
  <div class="card a" style="flex-basis:480px"><h2>Flagged <span class="muted" style="font-weight:500">· ${flags.length}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">Possible duplicates and payments with no matching credit in the bank statement.</div>${flags.map(item).join('') || '<p class="muted">Nothing flagged.</p>'}</div></div>
  <div class="card" style="margin-top:16px"><h2>Awaiting bank verification <span class="muted" style="font-weight:500">· ${wait.length}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">Best way to clear these: <a href="#/statement" style="color:var(--acc);font-weight:600">upload the bank statement</a>. You can also verify one by hand with a note.</div>${wait.map(item).join('') || '<p class="muted">Nothing waiting.</p>'}</div>` };
}

// ---------- statement ----------
function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  t = t.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
function stDate(s) {
  s = String(s || '').trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})/.exec(s))) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  if ((m = /^(\d{1,2})[\/\-. ]([A-Za-z]{3})[a-z]*[\/\-. ,]+(\d{2,4})/.exec(s))) { const mo = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); if (mo >= 0) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(mo + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; } }
  return '';
}
const stNum = s => { const n = Number(String(s || '').replace(/[,₹\s]|Cr|Dr|INR/gi, '').replace(/^\((.*)\)$/, '-$1')); return isFinite(n) ? n : 0; };
function guessCols(head) {
  const find = re => head.findIndex(h => re.test(h));
  return { date: find(/date/i), desc: find(/narration|description|particulars|remarks|details/i), ref: find(/ref|chq|cheque|utr|transaction id|txn/i), credit: find(/credit|deposit|\bcr\b/i), debit: find(/debit|withdraw|\bdr\b/i), amount: find(/^amount|amount\s*\(/i), type: find(/^type|cr\s*\/\s*dr|dr\s*\/\s*cr/i) };
}
async function viewStatement() {
  S.st = S.st || null;
  return { active: '#/statement', html: `<div class="head"><div><h1>Bank statement check</h1><div class="muted">Upload one month's statement (CSV). Each online payment is matched to a credit and marked verified, or flagged if no credit is found.</div></div></div>
  <div class="card"><div class="field"><label for="sf">Statement file (CSV)</label><input id="sf" type="file" accept=".csv,text/csv,text/plain" class="in" style="padding:10px"></div><div class="muted" style="font-size:13px">Most banks let you download a statement as CSV or Excel. If you only have Excel, save it as CSV first. PDF is not supported yet.</div><div id="stbody"></div></div>`,
    after() {
      const body = document.getElementById('stbody');
      document.getElementById('sf').addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        const rows = parseCSV(await f.text());
        let hi = rows.findIndex(r => r.some(c => /date/i.test(c)) && r.some(c => /credit|deposit|amount|cr\b/i.test(c)));
        if (hi < 0) { body.innerHTML = '<div class="note bad" style="margin-top:14px">Could not find the column headings. The file needs a Date column and a Credit (or Amount) column.</div>'; return; }
        const head = rows[hi].map(x => x.trim()), data = rows.slice(hi + 1); S.st = { head, data, cols: guessCols(head) };
        const sel = (k, label, req) => `<div class="field" style="flex:1 1 180px"><label for="c_${k}">${label}${req ? '' : ' <span class="opt">(optional)</span>'}</label><select id="c_${k}" class="in" data-col="${k}"><option value="-1">None</option>${head.map((h, i) => `<option value="${i}" ${S.st.cols[k] === i ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></div>`;
        body.innerHTML = `<h2 style="margin:18px 0 8px">Check the columns</h2><div class="row">${sel('date', 'Date', 1)}${sel('credit', 'Credit / deposit amount', 1)}${sel('ref', 'Reference', 0)}${sel('desc', 'Narration', 0)}</div><div class="muted" style="font-size:13px">If your statement has one Amount column plus a Credit/Debit type column, choose Amount as "Credit amount" and the type column below.</div><div class="row" style="margin-top:8px">${sel('type', 'Credit/Debit type', 0)}</div><div id="stprev"></div>`;
        body.querySelectorAll('select[data-col]').forEach(s => s.addEventListener('change', () => { S.st.cols[s.dataset.col] = +s.value; prev(); }));
        prev();
      });
      function credits() {
        const c = S.st.cols, out = [];
        for (const r of S.st.data) {
          const date = stDate(r[c.date]); if (!date) continue;
          let amt = c.credit >= 0 ? stNum(r[c.credit]) : 0;
          if (c.type >= 0 && /dr|debit/i.test(r[c.type] || '')) amt = 0;
          if (amt > 0) out.push({ date, amount: amt, ref: c.ref >= 0 ? (r[c.ref] || '').trim() : '', desc: c.desc >= 0 ? (r[c.desc] || '').trim() : '' });
        }
        return out;
      }
      function prev() {
        const cr = credits(); const box = document.getElementById('stprev');
        if (!cr.length) { box.innerHTML = '<div class="note warn" style="margin-top:14px">No credits found with these columns. Change the selections above.</div>'; return; }
        const ds = cr.map(x => x.date).sort();
        box.innerHTML = `<div class="note" style="margin:16px 0 12px">Found <b>${cr.length}</b> credits from <b>${esc(fdate(ds[0]))}</b> to <b>${esc(fdate(ds[ds.length - 1]))}</b>, totalling <b>${inr(cr.reduce((s, x) => s + x.amount, 0))}</b>.</div><button class="btn p" id="runst">Check payments against this statement</button><div id="stres"></div>`;
        document.getElementById('runst').addEventListener('click', async ev => {
          ev.target.disabled = true; ev.target.textContent = 'Checking…';
          try {
            const r = await api('POST', 'statement', { rows: cr });
            document.getElementById('stres').innerHTML = `<div style="margin-top:18px"><h2>Result</h2><div class="row" style="margin:10px 0"><div class="card kpi"><div class="l">Verified</div><div class="v" style="color:var(--good)">${r.matched.length}</div><div class="muted">matched to a bank credit</div></div><div class="card kpi ${r.flagged.length ? 'alert' : ''}"><div class="l">Flagged</div><div class="v">${r.flagged.length}</div><div class="muted">no matching credit found</div></div><div class="card kpi"><div class="l">Credits with no payment record</div><div class="v">${r.unmatchedCredits.length}</div><div class="muted">money in the bank nobody logged</div></div></div>
            ${r.unmatchedCredits.length ? `<h2 style="margin:12px 0 6px">Bank credits with no payment record</h2><div class="tbl"><div class="tr h" style="min-width:560px"><div class="c">Date</div><div class="c r">Amount</div><div class="c1">Narration</div></div>${r.unmatchedCredits.map(x => `<div class="tr" style="min-width:560px"><div class="c">${esc(fdate(x.date))}</div><div class="c r"><b>${inr(x.amount)}</b></div><div class="c1 muted">${esc(x.desc || x.ref)}</div></div>`).join('')}</div>` : ''}
            ${r.untouched ? `<p class="muted">${r.untouched} payment(s) fall outside this statement's dates and were left unchanged.</p>` : ''}<p><a href="#/review" style="color:var(--acc);font-weight:600">Go to Review</a></p></div>`;
            toast('Statement checked');
          } catch (ex) { toast(ex.message, true); }
          ev.target.disabled = false; ev.target.textContent = 'Check payments against this statement';
        });
      }
    } };
}

async function viewAudit() {
  const { audit } = await api('GET', 'audit?limit=300');
  const rows = audit.map(a => `<div class="tr" style="min-width:700px"><div class="c" style="flex:1.3">${esc(new Date(a.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</div><div class="c" style="flex:1.4">${esc(a.by)}</div><div class="c" style="flex:1.4"><b>${esc(a.action.replace(/_/g, ' '))}</b></div><div class="c1 muted">${esc(a.entityId || '')} ${esc(a.detail || '')}</div></div>`).join('');
  return { active: '#/audit', html: `<div class="head"><div><h1>Audit log</h1><div class="muted">Every change, with who made it and when. Newest first.</div></div></div><div class="card"><div class="tbl"><div class="tr h" style="min-width:700px"><div class="c" style="flex:1.3">When</div><div class="c" style="flex:1.4">Who</div><div class="c" style="flex:1.4">Action</div><div class="c1">Details</div></div>${rows}</div></div>` };
}

async function viewTeam() {
  const { users } = await api('GET', 'users');
  const rows = users.map(u => `<div class="tr" style="min-width:560px"><div class="c1"><b>${esc(u.name)}</b><div class="muted" style="font-size:13px">${esc(u.username)}</div></div><div class="c" style="text-transform:capitalize">${esc(u.role)}</div><div class="c">${u.active ? '<span class="badge good">Active</span>' : '<span class="badge">Disabled</span>'}</div><div class="c1" style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn s" data-act="userReset" data-id="${u.id}">Reset password</button>${u.id === S.user.id ? '' : `<button class="btn s ${u.active ? 'd' : ''}" data-act="userToggle" data-id="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>`}</div></div>`).join('');
  return { active: '#/team', html: `<div class="head"><div><h1>Team</h1><div class="muted">Uploaders add payments. Managers see balances and confirm cash. Owners manage people and settings.</div></div></div>
  <div class="grid2"><div class="card a"><div class="tbl"><div class="tr h" style="min-width:560px"><div class="c1">Person</div><div class="c">Role</div><div class="c">Status</div><div class="c1"></div></div>${rows}</div></div>
  <div class="card b"><h2 style="margin-bottom:12px">Add a person</h2><form id="uf"><div class="field"><label for="un1">Name</label><input id="un1" class="in" required></div><div class="field"><label for="uu">Username</label><input id="uu" class="in" autocapitalize="none" required></div><div class="field"><label for="up">Password <span class="opt">(at least 8 characters)</span></label><input id="up" type="password" class="in" autocomplete="new-password" required></div><div class="field"><label for="ur">Role</label><select id="ur" class="in"><option value="uploader">Uploader</option><option value="manager">Manager</option><option value="owner">Owner</option></select></div><div class="err" id="uerr" style="min-height:18px"></div><button class="btn p" type="submit">Add person</button></form></div></div>`,
    after() {
      document.getElementById('uf').addEventListener('submit', async e => {
        e.preventDefault(); const er = document.getElementById('uerr'); er.textContent = '';
        try { await api('POST', 'users', { name: document.getElementById('un1').value, username: document.getElementById('uu').value, password: document.getElementById('up').value, role: document.getElementById('ur').value }); toast('Person added'); render(); } catch (ex) { er.textContent = ex.message; }
      });
    } };
}

async function viewSettings() {
  const { settings: s } = await api('GET', 'settings');
  const a = s.connectors.api;
  return { active: '#/settings', html: `<div class="head"><div><h1>Settings</h1><div class="muted">Where each payment is sent, and how this workspace runs.</div></div></div>
  <div class="grid2"><div class="card a"><form id="sf2"><div class="field"><label for="bn">Business name</label><input id="bn" class="in" value="${esc(s.businessName)}"></div>
  <div class="field"><label for="me2">Manager emails for summaries <span class="opt">(comma separated, emailing is coming next)</span></label><input id="me2" class="in" value="${esc((s.managerEmails || []).join(', '))}"></div>
  <h2 style="margin:20px 0 6px">Business API connector</h2><div class="muted" style="font-size:13px;margin-bottom:10px">Every payment event is sent to your system as a secure HTTPS call, so nobody has to type it again. Your tech team adds one endpoint (see the README).</div>
  <div class="field"><label><input type="checkbox" id="ae" ${a.enabled ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">Send payments to my system</label></div>
  <div class="field"><label for="au">Endpoint URL</label><input id="au" class="in" placeholder="https://your-panel.example.com/api/record-payment" value="${esc(a.url)}"></div>
  <div class="field"><label for="ak">Secret key ${a.keySet ? '<span class="opt">(saved, leave blank to keep it)</span>' : ''}</label><input id="ak" type="password" class="in" autocomplete="off"></div>
  <div class="err" id="serr" style="min-height:18px"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn p" type="submit">Save settings</button><button class="btn" type="button" data-act="testApi">Send a test call</button></div></form></div>
  <div class="card b"><h2 style="margin-bottom:10px">This workspace</h2><div style="display:flex;flex-direction:column;gap:8px"><div>Storage: <b>${S.health.db === 'supabase' ? 'Database connected' : 'Demo (temporary)'}</b></div><div>Screenshot reading: <b>${S.health.ocr ? 'On' : 'Off (enter details by hand)'}</b></div><div>Google Sheets connector: <b>Not available yet</b></div></div></div></div>`,
    after() {
      document.getElementById('sf2').addEventListener('submit', async e => {
        e.preventDefault(); const er = document.getElementById('serr'); er.textContent = '';
        try { await api('PUT', 'settings', { businessName: document.getElementById('bn').value, managerEmails: document.getElementById('me2').value.split(',').map(x => x.trim()).filter(Boolean), connectors: { api: { enabled: document.getElementById('ae').checked, url: document.getElementById('au').value, key: document.getElementById('ak').value } } }); toast('Settings saved'); render(); } catch (ex) { er.textContent = ex.message; }
      });
    } };
}

// ---------- add payment ----------
function newAdd() { const t = new Date(); const p = n => String(n).padStart(2, '0'); return { mode: 'upi', imageId: '', preview: '', orderCode: '', customer: '', orderErr: '', amount: '', date: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`, time: '', txnId: '', payer: '', payee: '', ocr: '', ocrMsg: '', busy: false, done: null, err: '' }; }
async function downscale(file, max = 2000, q = 0.85) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', q);
}
function viewAdd() {
  const A = S.add || (S.add = newAdd());
  if (A.done) {
    const d = A.done;
    return { active: '#/add', html: `<div style="max-width:520px;margin:0 auto"><div class="card" style="text-align:center;padding:32px 20px"><div style="width:56px;height:56px;border-radius:28px;background:var(--goodbg);color:var(--good);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:28px" aria-hidden="true">✓</div><h1 style="font-size:24px">Payment saved</h1><p class="muted">${inr(d.amount)} for order <b>${esc(d.orderCode)}</b>${d.flagged ? '<br><span class="err">It looks like a repeat of an earlier entry, so it was sent to a manager to check.</span>' : ''}</p><div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px"><button class="btn p" data-act="addAnother">Add another</button><a class="btn" href="#/mine">My ${RANK[S.user.role] >= RANK.manager ? 'entries' : 'submissions'}</a></div></div></div>` };
  }
  const cash = A.mode === 'cash';
  return { active: '#/add', html: `<div style="max-width:520px;margin:0 auto"><div class="head" style="margin-bottom:12px"><h1 style="font-size:24px">Add payment</h1></div>
  <div class="seg" role="group" aria-label="Payment mode" style="margin-bottom:14px">${['upi', 'transfer', 'cash'].map(m => `<button type="button" class="${A.mode === m ? 'on' : ''}" data-act="mode" data-m="${m}">${m === 'upi' ? 'UPI' : m === 'transfer' ? 'Bank transfer' : 'Cash'}</button>`).join('')}</div>
  <div class="card" style="padding:12px;display:flex;gap:12px;align-items:center;margin-bottom:14px">${A.preview ? `<img class="thumb" alt="Your screenshot" src="${A.preview}">` : `<div class="thumb" style="display:flex;align-items:center;justify-content:center">${ICON.img}</div>`}<div style="flex:1"><div style="font-weight:600">${A.imageId ? 'Screenshot attached' : cash ? 'Client message screenshot (optional)' : 'Payment screenshot'}</div>${A.ocrMsg ? `<div class="${A.ocr === 'none' ? 'muted' : 'ok'}" style="font-size:13px">${esc(A.ocrMsg)}</div>` : '<div class="muted" style="font-size:13px">' + (cash ? 'Add the client’s message if you have it.' : 'Choose it from your photos. We read the details for you.') + '</div>'}<button type="button" class="btn s" data-act="pickImg" style="margin-top:6px" ${A.busy ? 'disabled' : ''}>${A.busy ? 'Reading…' : A.imageId ? 'Change screenshot' : 'Choose screenshot'}</button><input type="file" id="fi" accept="image/*" hidden></div></div>
  <form id="af" novalidate><div class="field"><label for="f_o">Order ID</label><input id="f_o" class="in" data-f="orderCode" value="${esc(A.orderCode)}" autocapitalize="characters" autocomplete="off"><div id="ohint" class="${A.orderErr ? 'err' : 'ok'}" style="margin-top:4px">${A.orderErr ? esc(A.orderErr) : A.customer ? 'Found: ' + esc(A.customer) : ''}</div></div>
  <div class="two field"><div><label for="f_a">Amount (₹)</label><input id="f_a" class="in" data-f="amount" inputmode="decimal" value="${esc(A.amount)}"></div><div><label for="f_d">Date</label><input id="f_d" type="date" class="in" data-f="date" value="${esc(A.date)}"></div></div>
  <div class="two field"><div><label for="f_t">Time <span class="opt">(if shown)</span></label><input id="f_t" type="time" class="in" data-f="time" value="${esc(A.time)}"></div><div></div></div>
  ${cash ? '' : `<div class="field"><label for="f_r">Transaction ID <span class="opt">(if shown)</span></label><input id="f_r" class="in" data-f="txnId" value="${esc(A.txnId)}" autocomplete="off"></div><div class="field"><label for="f_p">Paid by <span class="opt">(if shown)</span></label><input id="f_p" class="in" data-f="payer" value="${esc(A.payer)}"></div>`}
  <div class="err" id="aerr" style="min-height:18px;margin-bottom:6px">${esc(A.err)}</div><button class="btn p" type="submit" style="width:100%;min-height:52px" ${A.busy ? 'disabled' : ''}>Save payment</button></form></div>`,
    after() {
      document.querySelectorAll('[data-f]').forEach(el => el.addEventListener('input', () => { A[el.dataset.f] = el.value; if (el.dataset.f === 'orderCode') lookup(); }));
      document.getElementById('fi').addEventListener('change', async e => { const f = e.target.files[0]; if (f) pickFile(f); });
      document.getElementById('af').addEventListener('submit', submit);
      let tm; function lookup() {
        clearTimeout(tm); const h = document.getElementById('ohint'); A.customer = ''; A.orderErr = '';
        if (!A.orderCode.trim()) { h.textContent = ''; return; }
        tm = setTimeout(async () => {
          try { const r = await api('GET', 'orders/lookup/' + encodeURIComponent(A.orderCode.trim())); A.customer = r.customer; if (r.pending) { A.orderErr = 'That order is waiting for manager approval.'; A.customer = ''; } else if (r.rejected) { A.orderErr = 'That order was rejected by a manager.'; A.customer = ''; } else if (r.closed) { A.orderErr = 'That order is closed.'; A.customer = ''; } } catch (ex) { A.orderErr = ex.message; }
          h.className = A.orderErr ? 'err' : 'ok'; h.textContent = A.orderErr ? A.orderErr : 'Found: ' + A.customer;
        }, 350);
      }
      if (A.orderCode && !A.customer && !A.orderErr) lookup();
    } };
}
async function pickFile(file) {
  const A = S.add; A.busy = true; A.err = ''; A.ocrMsg = ''; render();
  try {
    const dataUrl = await downscale(file); A.preview = dataUrl;
    const { id } = await api('POST', 'images', { dataUrl }); A.imageId = id;
    const r = await api('POST', 'ocr', { imageId: id });
    if (!r.configured) { A.ocr = 'none'; A.ocrMsg = 'Automatic reading is off. Please type the details from the screenshot.'; }
    else if (r.error) { A.ocr = 'none'; A.ocrMsg = r.error; }
    else {
      const p = r.parsed; A.ocr = p.confidence;
      if (p.amount) A.amount = String(p.amount);
      if (p.date) { A.date = p.date; A.time = p.time || ''; }
      if (p.txnId) A.txnId = p.txnId;
      if (p.payer) A.payer = p.payer;
      if (p.payee) A.payee = p.payee;
      if (p.mode === 'transfer' && A.mode === 'upi') A.mode = 'transfer';
      A.ocrMsg = p.confidence === 'low' ? 'We could only read a little. Please check every field.' : 'We read these details. Please check them against the screenshot.';
    }
  } catch (ex) { A.err = ex.message || 'Could not use that image'; A.imageId = ''; A.preview = ''; }
  A.busy = false; render();
}
async function submit(e) {
  e.preventDefault(); const A = S.add; A.err = '';
  if (!A.orderCode.trim()) A.err = 'Enter the order ID.';
  else if (!(Number(String(A.amount).replace(/,/g, '')) > 0)) A.err = 'Enter the amount.';
  else if (!A.date) A.err = 'Enter the payment date.';
  else if (A.mode !== 'cash' && !A.imageId) A.err = 'Attach the payment screenshot.';
  if (A.err) { document.getElementById('aerr').textContent = A.err; return; }
  A.busy = true; render();
  try {
    const r = await api('POST', 'payments', { orderCode: A.orderCode.trim(), mode: A.mode, amount: String(A.amount).replace(/,/g, ''), date: A.date + (A.time ? 'T' + A.time : ''), txnId: A.txnId, payer: A.payer, payee: A.payee, imageId: A.imageId, ocr: A.ocr });
    S.add = newAdd(); S.add.done = r.payment;
  } catch (ex) { A.err = ex.message; }
  A.busy = false; render();
}

async function viewMine() {
  const { payments } = await api('GET', 'payments/mine');
  const rows = payments.map(p => `<div class="tr" style="min-width:420px"><div class="c1"><b>${esc(p.orderCode)}</b><div class="muted" style="font-size:13px">${esc(fdate(p.date))}</div></div><div class="c">${esc(MODE[p.mode] || p.mode)}</div><div class="c r"><b>${inr(p.amount)}</b></div></div>`).join('');
  return { active: '#/mine', html: `<div class="head"><div><h1>${RANK[S.user.role] >= RANK.manager ? 'My entries' : 'My submissions'}</h1><div class="muted">${payments.length} payment${payments.length === 1 ? '' : 's'} added by you</div></div><a class="btn p" href="#/add">Add payment</a></div><div class="card"><div class="tbl">${rows ? `<div class="tr h" style="min-width:420px"><div class="c1">Order</div><div class="c">Mode</div><div class="c r">Amount</div></div>${rows}` : '<p class="muted">Nothing yet.</p>'}</div></div>` };
}

// ---------- actions ----------
const ACT = {
  logout() { logout(); },
  back(el) { if (history.length > 1) history.back(); else go(el.dataset.fallback || '#/'); },
  newOrder() { const b = document.getElementById('newbox'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; if (b.style.display === 'block') document.getElementById('oc').focus(); },
  async confirmCash(el) { const note = await ask({ title: 'Confirm cash received', label: 'Note (optional)', text: 'Confirm only if you have seen or received this cash.', ok: 'Confirm', required: false }); if (note === null) return; try { await api('POST', `payments/${el.dataset.id}/confirm-cash`, { note }); toast('Cash confirmed'); render(); } catch (ex) { toast(ex.message, true); } },
  async verify(el) { const note = await ask({ title: 'Verify by hand', label: 'How did you check it?', text: 'For example: seen in the bank app. Prefer uploading the bank statement.', ok: 'Mark verified', minLen: 5 }); if (!note) return; try { await api('POST', `payments/${el.dataset.id}/verify`, { note }); toast('Marked verified'); render(); } catch (ex) { toast(ex.message, true); } },
  async release(el) { try { await api('POST', `payments/${el.dataset.id}/release`, {}); toast('Kept: it now counts as awaiting verification'); render(); } catch (ex) { toast(ex.message, true); } },
  async reject(el) { const reason = await ask({ title: 'Reject this payment', label: 'Reason', ok: 'Reject', danger: true }); if (!reason) return; try { await api('POST', `payments/${el.dataset.id}/reject`, { reason }); toast('Payment rejected'); render(); } catch (ex) { toast(ex.message, true); } },
  showImg(el) { const { ov, close } = modal(`<img alt="Payment screenshot" src="${imgUrl(el.dataset.id)}"><div style="text-align:right;margin-top:12px"><button class="btn" data-x="1">Close</button></div>`); ov.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(); }); },
  async closeOrder(el) {
    const code = el.dataset.code;
    try { const ok = await confirmBox({ title: 'Close ' + code + '?', text: 'This order is fully verified. Closing stops further payments being added.', ok: 'Close order' }); if (!ok) return; await api('POST', `orders/${encodeURIComponent(code)}/close`, {}); toast('Order closed'); render(); }
    catch (ex) {
      if (ex.status === 409 && ex.data && ex.data.canOverride) { const reason = await ask({ title: 'Close anyway?', text: ex.message + '. As owner you can close it with a written reason, which is recorded in the audit log.', label: 'Reason', ok: 'Close anyway', danger: true, minLen: 5 }); if (!reason) return; try { await api('POST', `orders/${encodeURIComponent(code)}/close`, { override: true, reason }); toast('Order closed'); render(); } catch (e2) { toast(e2.message, true); } }
      else toast(ex.message, true);
    }
  },
  async reopen(el) { try { await api('POST', `orders/${encodeURIComponent(el.dataset.code)}/reopen`, {}); toast('Order reopened'); render(); } catch (ex) { toast(ex.message, true); } },
  async editTotal(el) { const v = await ask({ title: 'Change order total', label: 'New total (₹)', text: 'The change is recorded in the audit log.', ok: 'Save', minLen: 1 }); if (!v) return; try { await api('PATCH', `orders/${encodeURIComponent(el.dataset.code)}`, { total: v.replace(/,/g, '') }); toast('Total updated'); render(); } catch (ex) { toast(ex.message, true); } },
  mode(el) { S.add.mode = el.dataset.m; render(); },
  pickImg() { document.getElementById('fi').click(); },
  async approveOrder(el) { try { await api('POST', `orders/${encodeURIComponent(el.dataset.code)}/approve`, {}); toast('Order approved'); render(); } catch (ex) { toast(ex.message, true); } },
  async rejectOrder(el) { const reason = await ask({ title: 'Reject this order', label: 'Reason', ok: 'Reject', danger: true }); if (!reason) return; try { await api('POST', `orders/${encodeURIComponent(el.dataset.code)}/reject`, { reason }); toast('Order rejected'); render(); } catch (ex) { toast(ex.message, true); } },
  anotherOrder() { S.newOrder = null; render(); },
  addAnother() { S.add = newAdd(); render(); },
  async userToggle(el) { try { await api('PATCH', 'users/' + el.dataset.id, { active: el.dataset.active !== '1' }); render(); } catch (ex) { toast(ex.message, true); } },
  async userReset(el) { const pw = await ask({ title: 'Reset password', label: 'New password (at least 8 characters)', ok: 'Reset', minLen: 8 }); if (!pw) return; try { await api('PATCH', 'users/' + el.dataset.id, { password: pw }); toast('Password reset'); } catch (ex) { toast(ex.message, true); } },
  async testApi() { try { const r = await api('POST', 'settings/test-api'); const x = r.result; toast(x && x.ok ? 'Your system answered (' + x.status + ')' : 'Your system did not accept the call: ' + (x ? (x.status || x.error) : 'no result'), !(x && x.ok)); } catch (ex) { toast(ex.message, true); } },
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (t && ACT[t.dataset.act]) { if (t.tagName === 'A') { if (t.dataset.act === 'logout') e.preventDefault(); } ACT[t.dataset.act](t, e); } });

// ---------- router ----------
let rid = 0;
async function render() {
  const my = ++rid;
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!S.health) { try { S.health = await api('GET', 'health'); } catch (e) { $app.innerHTML = '<div class="login"><div class="note bad">Cannot reach the server. Please try again.</div></div>'; return; } }
  if (!S.tok) { const v = viewLogin(); $app.innerHTML = v.html; v.after(); return; }
  if (!S.user) { try { S.user = (await api('GET', 'me')).user; } catch (e) { return; } }
  const mgr = RANK[S.user.role] >= RANK.manager, owner = S.user.role === 'owner';
  const [a, b] = parts;
  let v;
  try {
    if (!a) { if (!mgr) return go('#/add'); v = await viewDashboard(S.month); }
    else if (a === 'login') { return go(mgr ? '#/' : '#/add'); }
    else if (a === 'add') v = viewAdd();
    else if (a === 'new-order') v = viewNewOrder();
    else if (a === 'mine') v = await viewMine();
    else if (!mgr) return go('#/add');
    else if (a === 'orders') v = b ? await viewOrder(b) : await viewOrders();
    else if (a === 'payments') v = await viewPayments();
    else if (a === 'review') v = await viewReview();
    else if (a === 'statement') v = await viewStatement();
    else if (a === 'audit') v = await viewAudit();
    else if (a === 'team' && owner) v = await viewTeam();
    else if (a === 'settings' && owner) v = await viewSettings();
    else return go('#/');
  } catch (ex) { if (my !== rid) return; v = { active: '', html: `<div class="note bad">${esc(ex.message)}</div><p><a class="btn" href="#/">Back to start</a></p>` }; }
  if (my !== rid || !S.user) return;
  if (mgr && !S.badgeLoaded) { S.badgeLoaded = true; api('GET', 'summary').then(s => { S.badge = s.flaggedCount + s.cashPendingCount + s.pendingOrders; document.querySelectorAll('.nav a[href="#/review"]').forEach(a => { a.innerHTML = 'Review' + (S.badge ? `<span class="pill">${S.badge}</span>` : ''); }); }).catch(() => { }); }
  $app.innerHTML = shell(v.active, v.html);
  if (S.lastHash !== location.hash) { window.scrollTo(0, 0); S.lastHash = location.hash; }
  if (v.after) v.after();
  document.title = 'Payment Control';
}
window.addEventListener('hashchange', () => { S.badgeLoaded = false; render(); });
render();
