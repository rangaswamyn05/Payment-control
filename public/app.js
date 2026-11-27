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
const MODE = { upi: 'UPI', transfer: 'Bank transfer', cheque: 'Cheque', card: 'Card / Razorpay', cash: 'Cash' };
const STATUS = {
  client_reported: ['Validation pending', 'warn'], verified: ['Verified', 'good'], cash_pending: ['Cash: owner to approve', 'warn'],
  cash_confirmed: ['Cash approved', 'good'], flagged: ['Flagged', 'bad'], rejected: ['Rejected', ''],
};
const REASON = { possible_duplicate: 'Possible duplicate', overpayment: 'More than order total' };
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
  if (o.pendingCash) return '<span class="badge warn">Cash: owner to approve</span>';
  if (o.awaiting) return '<span class="badge warn">Validation pending</span>';
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

function logout() { S.tok = ''; S.user = null; S.setupChecked = false; localStorage.removeItem('pc_tok'); S.add = null; location.hash = '#/login'; render(); }
const go = h => { location.hash = h; };
function backBtn(fallback) { return `<button class="back" data-act="back" data-fallback="${fallback || '#/'}">${ICON.back}Back</button>`; }

function shell(active, inner) {
  const u = S.user; const mgr = RANK[u.role] >= RANK.manager;
  const items = [];
  if (mgr) items.push(['#/', 'Dashboard'], ['#/orders', 'Orders'], ['#/payments', 'Payments'], ['#/review', 'Review' + (S.badge ? `<span class="pill">${S.badge}</span>` : '')], ['#/statement', 'Statement']);
  if (!mgr) items.push(['#/home', 'Home', 'Your orders: what is collected, what is outstanding and who to chase next.'], ['#/new-order', 'New order', 'Start here for a new customer booking: phone number, order total and the first advance screenshot.']);
  items.push(['#/add', 'Add payment', 'For a later instalment on an order that already exists.'], ['#/mine', mgr ? 'My entries' : 'My submissions', mgr ? 'Payments you entered yourself, with their status.' : 'The orders and payments you have sent in, with their status.'], ['#/inbox', 'Inbox' + (S.unread ? `<span class="pill">${S.unread}</span>` : ''), 'Updates for you: approvals, changes asked for and alerts.']);
  if (mgr) items.push(['#/audit', 'Audit log']);
  if (u.role === 'owner') items.push(['#/reports', 'Reports'], ['#/team', 'Team'], ['#/settings', 'Settings']);
  items.push(['#/box', mgr ? 'Fix my business' : 'Feedback', mgr ? 'Describe a business problem or upload your flow, and we come back with a solution.' : 'Tell us what works and what does not.']);
  const nav = items.map(([h, t, hint]) => `<a href="${h}" class="${active === h ? 'on' : ''}${h === '#/box' ? ' hl' : ''}"${hint ? ` data-tip="${hint}"` : ''}>${h === '#/box' ? '✨ ' : ''}${t}</a>`).join('');
  return `<header class="top"><div class="brand"><div class="logo">${ICON.shield}</div><span>Payment Control</span></div><nav class="nav" aria-label="Main">${nav}</nav><div class="me"><div style="text-align:right"><div style="font-weight:600">${esc(u.name)}</div><div class="muted" style="font-size:12px;text-transform:capitalize">${esc(u.role)} · <a href="#/login" data-act="logout" style="text-decoration:underline">Sign out</a></div></div><div class="av">${esc(u.name[0] || '?')}</div></div></header>${S.health && S.health.db === 'memory' ? '<div class="note warn" style="border-radius:0;text-align:center">Demo storage: data is not saved permanently until the database is connected.</div>' : ''}<main class="wrap">${inner}</main>`;
}

// ---------- views ----------
function viewLogin() {
  const demo = S.health && S.health.demo;
  const setup = S.health && S.health.needsSetup;
  return { html: `<div class="login"><div class="logo" style="width:48px;height:48px;border-radius:12px">${ICON.shield.replace('width="18" height="18"', 'width="28" height="28"')}</div><h1 style="margin-top:14px">Payment Control</h1><p class="muted" style="margin:4px 0 20px">Know that every payment reached the business.</p>
  ${setup ? rolesCard() : ''}<form class="card" id="lf" autocomplete="on">${setup ? '<h2 style="margin-bottom:12px">Create the owner account</h2><div class="field"><label for="nm">Your name</label><input id="nm" class="in" autocomplete="name"></div>' : ''}
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
          go(RANK[S.user.role] >= RANK.manager ? '#/' : '#/home'); render();
        } catch (ex) { err.textContent = ex.message; }
      });
    } };
}

const periodName = m => m === 'all' ? 'all time' : /^\d{4}$/.test(m) ? m : monthName(m);
const monthName = m => { const x = /^(\d{4})-(\d{2})$/.exec(m); return x ? ['January','February','March','April','May','June','July','August','September','October','November','December'][+x[2]-1] + ' ' + x[1] : m; };
async function viewDashboard(month) {
  month = month || new Date().toISOString().slice(0, 7);
  const s = await api('GET', 'summary?period=' + month + (S.acct && S.acct !== 'all' ? '&account=' + encodeURIComponent(S.acct) : ''));
  const kind = month === 'all' ? 'all' : /^\d{4}$/.test(month) ? 'year' : 'month';
  const yr = (month === 'all' ? new Date().toISOString().slice(0, 4) : month.slice(0, 4));
  const yrs = []; for (let y = +new Date().toISOString().slice(0, 4); y >= 2020; y--) yrs.push(y);
  S.badge = s.flaggedCount + s.ownerPending + s.pendingOrders + s.adjustRequests;
  const tot = s.byStatus.verified + s.byStatus.awaiting + s.byStatus.flagged;
  const pc = v => tot ? Math.round(v * 100 / tot) : 0;
  const rows = s.top.map(o => `<a class="tr" href="#/orders/${encodeURIComponent(o.code)}"><div class="c1"><b>${esc(o.code)}</b><div class="muted" style="font-size:13px">${esc(o.customer)}</div></div><div class="c r">${inr(o.total)}</div><div class="c r">${inr(o.verified)}</div><div class="c r"><b>${inr(o.outstanding)}</b></div><div class="c">${orderBadge(o)}</div></a>`).join('');
  return { active: '#/', html: `<div class="head"><div><h1>Dashboard</h1><div class="muted">Every payment, matched to an order and checked against the bank.</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${s.accounts && s.accounts.length ? `<select id="ac" class="in" style="width:auto;min-height:44px" aria-label="Bank account"><option value="all"${(S.acct || 'all') === 'all' ? ' selected' : ''}>All accounts</option>${s.accounts.map(a => `<option value="${esc(a.id)}"${S.acct === a.id ? ' selected' : ''}>${esc(a.name)} ····${esc(a.last4)}</option>`).join('')}<option value="cash"${S.acct === 'cash' ? ' selected' : ''}>Cash only</option><option value="unmatched"${S.acct === 'unmatched' ? ' selected' : ''}>Online, not yet matched to an account</option></select>` : ''}<select id="pk" class="in" style="width:auto;min-height:44px" aria-label="View by"><option value="month"${kind === 'month' ? ' selected' : ''}>Month</option><option value="year"${kind === 'year' ? ' selected' : ''}>Year</option><option value="all"${kind === 'all' ? ' selected' : ''}>Overall</option></select>${kind === 'month' ? `<input id="mo" type="month" class="in" style="width:auto;min-height:44px" value="${esc(s.month)}" aria-label="Month">` : kind === 'year' ? `<select id="yr" class="in" style="width:auto;min-height:44px" aria-label="Year">${yrs.map(y => `<option${String(y) === month ? ' selected' : ''}>${y}</option>`).join('')}</select>` : ''}</div></div>
  ${(() => { const d = s.dues || [], n = k => d.filter(x => x.bucket === k), sum = k => n(k).reduce((a, x) => a + x.amount, 0), chip = (k, t, cls) => `<span class="badge ${cls}">${t} ${n(k).length}${n(k).length ? ' · ' + inr(sum(k)) : ''}</span>`, show = d.slice(0, 4), row = x => `<a class="tr" href="#/orders/${encodeURIComponent(x.code)}" style="min-width:0;padding:6px 0;font-size:13px"><div class="c1"><b>${esc(x.code)}</b> <span class="muted">${esc(x.customer)}</span></div><div class="c" style="flex:.7">${esc(fdate(x.date))}</div><div class="c r"><b>${inr(x.amount)}</b></div></a>`; return `<div class="card" style="margin-bottom:12px;padding:12px 16px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Payments due</b>${chip('overdue', 'Overdue', 'bad')}${chip('today', 'Today', 'warn')}${chip('tomorrow', 'Tomorrow', '')}${chip('week', 'Next 7 days', '')}</div>${show.length ? `<div class="tbl" style="margin-top:6px">${show.map(row).join('')}</div>${d.length > 4 ? `<div class="muted" style="font-size:12px">+ ${d.length - 4} more on the Orders page</div>` : ''}` : ''}</div>`; })()}
  <div class="row" style="margin-bottom:16px">
   <div class="card kpi"><div class="l">Outstanding from clients</div><div class="v">${inr(s.outstanding)}</div><div class="muted">across ${s.openOrders} open order${s.openOrders === 1 ? '' : 's'}</div></div>
   <div class="card kpi"><div class="l">Validation</div><div class="v">${inr(s.validatedTotal)}</div><div class="muted">validated by statement · ${inr(s.manualTotal)} manually validated, not system validated · ${inr(s.notValidatedTotal)} validation pending</div></div>
   <div class="card kpi"><div class="l">Received${s.month === 'all' ? ' overall' : ' in ' + esc(periodName(s.month))}</div><div class="v">${inr(s.received)}</div><div class="muted">Online ${inr(s.receivedOnline)} · Cash ${inr(s.receivedCash)}</div></div>
   <a class="card kpi alert" href="#/review"><div class="l">Needs your review</div><div class="v">${s.flaggedCount + s.ownerPending + s.pendingOrders} item${s.flaggedCount + s.ownerPending + s.pendingOrders === 1 ? '' : 's'}</div><div class="muted">${s.flaggedCount} flagged · ${s.cashPendingCount} cash to confirm</div></a></div>
  <div class="grid2"><div class="card a"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>Largest outstanding balances</h2><a href="#/orders" style="color:var(--acc);font-weight:600">View all orders</a></div>
   ${rows ? `<div class="tbl"><div class="tr h"><div class="c1">Order</div><div class="c r">Total</div><div class="c r">Verified</div><div class="c r">Outstanding</div><div class="c">Status</div></div>${rows}</div>` : '<p class="muted">No open orders with a balance. Create an order to start.</p>'}</div>
   <div class="card b"><h2 style="margin-bottom:14px">${s.month === 'all' ? 'Overall' : esc(periodName(s.month))} by status</h2><div class="bar" aria-hidden="true"><i style="width:${pc(s.byStatus.verified)}%;background:#12B76A"></i><i style="width:${pc(s.byStatus.awaiting)}%;background:#F79009"></i><i style="width:${pc(s.byStatus.flagged)}%;background:#D92D20"></i></div>
   <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between"><span><span class="dot" style="background:#12B76A"></span>Verified</span><b>${inr(s.byStatus.verified)}</b></div><div style="display:flex;justify-content:space-between"><span><span class="dot" style="background:#F79009"></span>Awaiting verification</span><b>${inr(s.byStatus.awaiting)}</b></div><div style="display:flex;justify-content:space-between"><span><span class="dot" style="background:#D92D20"></span>Flagged</span><b>${inr(s.byStatus.flagged)}</b></div></div>
   <div class="muted" style="border-top:1px solid var(--line);margin-top:18px;padding-top:14px;font-size:13px">Cash needs the owner's approval. <a href="#/statement" style="color:var(--acc);font-weight:600">Upload a bank statement</a> to verify the amounts waiting.</div></div></div>`,
    after() {
      const set = v => { S.month = v; render(); };
      const ac = document.getElementById('ac'); if (ac) ac.addEventListener('change', e => { S.acct = e.target.value; render(); });
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

async function viewPayments() {
  const st = S.pfilter || '';
  const { payments } = await api('GET', 'payments' + (st ? '?status=' + st : ''));
  const rows = payments.map(p => `<a class="tr" href="#/orders/${encodeURIComponent(p.orderCode)}" style="min-width:760px"><div class="c" style="flex:1.2">${esc(fdate(p.date))}</div><div class="c1"><b>${esc(p.orderCode)}</b><div class="muted" style="font-size:13px">${esc(p.customer)}</div></div><div class="c">${esc(MODE[p.mode] || p.mode)}</div><div class="c r"><b>${inr(p.amount)}</b></div><div class="c" style="color:var(--muted);word-break:break-all">${esc(p.txnId || '')}</div><div class="c">${esc(p.createdByName || '')}</div><div class="c">${statusBadge(p)}</div></a>`).join('');
  const opts = [['', 'All'], ['client_reported', 'Validation pending'], ['verified', 'Verified'], ['owner', 'Waiting for the owner'], ['cash_confirmed', 'Cash approved'], ['flagged', 'Flagged'], ['rejected', 'Rejected']].map(([v, t]) => `<option value="${v}" ${v === st ? 'selected' : ''}>${t}</option>`).join('');
  return { active: '#/payments', html: `<div class="head"><div><h1>Payments</h1><div class="muted">${payments.length} shown</div></div><div><label for="pf" class="muted" style="display:inline;margin-right:8px">Show</label><select id="pf" class="in" style="width:auto">${opts}</select></div></div><div class="card"><div class="tbl"><div class="tr h" style="min-width:760px"><div class="c" style="flex:1.2">Date</div><div class="c1">Order</div><div class="c">Mode</div><div class="c r">Amount</div><div class="c">Reference</div><div class="c">Logged by</div><div class="c">Status</div></div>${rows || '<p class="muted" style="padding:12px 0">Nothing here.</p>'}</div></div>`,
    after() { document.getElementById('pf').addEventListener('change', e => { S.pfilter = e.target.value; render(); }); } };
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
  S.st = S.st || null; let accts = []; try { accts = ((await api('GET', 'settings')).settings.accounts) || []; } catch (e) {}
  return { active: '#/statement', html: `<div class="head"><div><h1>Bank statement check</h1><div class="muted">Drop a statement (CSV). Each online payment is matched by transaction ID and marked validated. Anything not found stays pending, never marked wrong.</div></div></div>
  <div class="card"><div class="drop" id="sf" tabindex="0" role="button" aria-label="Drop the statement"><div class="di">⬇</div><div><b>Drop the bank statement here</b><div class="muted" style="font-size:13px">CSV file, or tap to choose</div></div><input type="file" accept=".csv,text/csv,text/plain" hidden></div><div class="muted" style="font-size:13px">Most banks let you download a statement as CSV or Excel. If you only have Excel, save it as CSV first. PDF is not supported yet.</div>${accts.length ? `<div class="field" style="margin-top:14px"><label for="sa">Which business account is this statement for?</label><select id="sa" class="in">${accts.length > 1 ? '<option value="">Choose…</option>' : ''}${accts.map(a => `<option value="${esc(a.id)}">${esc(a.name)} ····${esc(a.last4)}</option>`).join('')}</select><div class="muted" style="font-size:13px;margin-top:4px">The statement must show this account, or it is refused. A personal or another account never validates payments.</div></div>` : '<div class="note warn" style="margin-top:14px">No business bank account is set up. Ask the owner to add one in Settings so statements can be checked as yours.</div>'}<div id="stbody"></div></div>`,
    after() {
      const body = document.getElementById('stbody');
      const z = document.getElementById('sf'), zi = z.querySelector('input');
      z.addEventListener('click', () => zi.click()); zi.addEventListener('change', () => { if (zi.files[0]) load(zi.files[0]); });
      DROP.cur = f => load(f);
      async function load(f) {
        const txt = await f.text(); S.stHead = txt.split(/\r?\n/).slice(0, 25).join('\n'); const rows = parseCSV(txt);
        let hi = rows.findIndex(r => r.some(c => /date/i.test(c)) && r.some(c => /credit|deposit|amount|cr\b/i.test(c)));
        if (hi < 0) { body.innerHTML = '<div class="note bad" style="margin-top:14px">Could not find the column headings. The file needs a Date column and a Credit (or Amount) column.</div>'; return; }
        const head = rows[hi].map(x => x.trim()), data = rows.slice(hi + 1); S.st = { head, data, cols: guessCols(head) };
        const sel = (k, label, req) => `<div class="field" style="flex:1 1 180px"><label for="c_${k}">${label}${req ? '' : ' <span class="opt">(optional)</span>'}</label><select id="c_${k}" class="in" data-col="${k}"><option value="-1">None</option>${head.map((h, i) => `<option value="${i}" ${S.st.cols[k] === i ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></div>`;
        body.innerHTML = `<h2 style="margin:18px 0 8px">Check the columns</h2><div class="row">${sel('date', 'Date', 1)}${sel('credit', 'Credit / deposit amount', 1)}${sel('ref', 'Reference', 0)}${sel('desc', 'Narration', 0)}</div><div class="muted" style="font-size:13px">If your statement has one Amount column plus a Credit/Debit type column, choose Amount as "Credit amount" and the type column below.</div><div class="row" style="margin-top:8px">${sel('type', 'Credit/Debit type', 0)}</div><div id="stprev"></div>`;
        body.querySelectorAll('select[data-col]').forEach(s => s.addEventListener('change', () => { S.st.cols[s.dataset.col] = +s.value; prev(); }));
        prev();
      }
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
            const saEl = document.getElementById('sa'); let r;
            try { r = await api('POST', 'statement', { rows: cr, accountId: saEl ? saEl.value : '', headText: S.stHead || '', confirmed: !!S.stOk }); }
            catch (ex) {
              ev.target.disabled = false; ev.target.textContent = 'Check payments against this statement';
              const box = document.getElementById('stres');
              if (ex.data && ex.data.needConfirm) { box.innerHTML = `<div class="note warn" style="margin-top:14px">${esc(ex.message)}<label style="display:block;margin-top:8px;font-weight:400"><input type="checkbox" id="stok" style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">Yes, this is that business account's statement</label></div>`; document.getElementById('stok').addEventListener('change', e => { S.stOk = e.target.checked; }); }
              else box.innerHTML = `<div class="note bad" style="margin-top:14px">${esc(ex.message)}</div>`;
              return;
            }
            document.getElementById('stres').innerHTML = `<div style="margin-top:18px"><h2>Result</h2><div class="row" style="margin:10px 0"><div class="card kpi"><div class="l">Validated</div><div class="v" style="color:var(--good)">${r.matched.length}</div><div class="muted">matched to a bank credit</div></div><div class="card kpi"><div class="l">Still pending</div><div class="v">${r.flagged.length}</div><div class="muted">unable to validate with this statement. Upload another statement or review manually.</div></div><div class="card kpi"><div class="l">Credits with no payment record</div><div class="v">${r.unmatchedCredits.length}</div><div class="muted">money in the bank nobody logged</div></div></div>
            ${r.flagged.length ? `<h2 style="margin:12px 0 6px">Unable to validate, and why</h2><div class="tbl">${r.flagged.map(f => `<div class="tr" style="min-width:520px"><div class="c1"><b>${esc(f.orderCode)}</b></div><div class="c r">${inr(f.amount)}</div><div class="c" style="flex:3">${esc(f.reason || '')}</div></div>`).join('')}</div>` : ''}
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

// Who can do what. Shown on the Team page and on first-time setup.
function rolesCard(compact) {
  const r = (t, who, items) => `<div style="border-top:1px solid #EEF2F6;padding:12px 0"><b>${t}</b> <span class="muted" style="font-size:13px">${who}</span><ul style="margin:6px 0 0 18px;padding:0;font-size:14px;line-height:1.5">${items.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
  return `<div class="card" style="margin:0 0 16px;text-align:left"><h2 style="margin-bottom:4px">Who can do what</h2><div class="muted" style="font-size:13px">Three roles. Every payment is checked by the system or a second person, never only by the one who added it.</div>
  ${r('Uploader', 'sales team', ['Creates orders and adds payments by dropping a screenshot.', 'Sees only their own orders and what is collected and outstanding.', 'Later payments need no approval. They are validated against the bank statement.'])}
  ${r('Manager', 'finance or operations', ['Approves new orders (can correct the client name or total).', 'Verifies payments the system could not match, and reviews flagged ones.', 'Approves a payment plan that does not match the order. Cash, offline entries, large amounts and anything a manager enters go to the owner.'])}
  ${r('Owner', 'business owner', ['Approves cash, offline entries and amounts above the limit.', 'Changes order totals and closes orders with an override.', 'Manages people, settings, reports and the audit log.'])}</div>`;
}

async function viewTeam() {
  const { users } = await api('GET', 'users');
  const rows = users.map(u => `<div class="tr" style="min-width:560px"><div class="c1"><b>${esc(u.name)}</b><div class="muted" style="font-size:13px">${esc(u.username)}</div></div><div class="c" style="text-transform:capitalize">${esc(u.role)}</div><div class="c">${u.active ? '<span class="badge good">Active</span>' : '<span class="badge">Disabled</span>'}</div><div class="c1" style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn s" data-act="userReset" data-id="${u.id}">Reset password</button>${u.id === S.user.id ? '' : `<button class="btn s ${u.active ? 'd' : ''}" data-act="userToggle" data-id="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>`}</div></div>`).join('');
  return { active: '#/team', html: `<div class="head"><div><h1>Team</h1><div class="muted">Uploaders add payments. Managers see balances and confirm cash. Owners manage people and settings.</div></div></div>
  ${rolesCard()}<div class="grid2"><div class="card a"><div class="tbl"><div class="tr h" style="min-width:560px"><div class="c1">Person</div><div class="c">Role</div><div class="c">Status</div><div class="c1"></div></div>${rows}</div></div>
  <div class="card b"><h2 style="margin-bottom:12px">Add a person</h2><form id="uf"><div class="field"><label for="un1">Name</label><input id="un1" class="in" required></div><div class="field"><label for="uu">Username</label><input id="uu" class="in" autocapitalize="none" required></div><div class="field"><label for="up">Password <span class="opt">(at least 8 characters)</span></label><input id="up" type="password" class="in" autocomplete="new-password" required></div><div class="field"><label for="ur">Role</label><select id="ur" class="in"><option value="uploader">Uploader</option><option value="manager">Manager</option><option value="owner">Owner</option></select></div><div class="err" id="uerr" style="min-height:18px"></div><button class="btn p" type="submit">Add person</button></form></div></div>`,
    after() {
      document.getElementById('uf').addEventListener('submit', async e => {
        e.preventDefault(); const er = document.getElementById('uerr'); er.textContent = '';
        try { await api('POST', 'users', { name: document.getElementById('un1').value, username: document.getElementById('uu').value, password: document.getElementById('up').value, role: document.getElementById('ur').value }); toast('Person added'); render(); } catch (ex) { er.textContent = ex.message; }
      });
    } };
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
  async rejectOrder(el) { const reason = await ask({ title: 'Reject this order', label: 'Reason', ok: 'Reject', danger: true }); if (!reason) return; try { await api('POST', `orders/${encodeURIComponent(el.dataset.code)}/reject`, { reason }); toast('Order rejected'); render(); } catch (ex) { toast(ex.message, true); } },
  async userToggle(el) { try { await api('PATCH', 'users/' + el.dataset.id, { active: el.dataset.active !== '1' }); render(); } catch (ex) { toast(ex.message, true); } },
  async userReset(el) { const pw = await ask({ title: 'Reset password', label: 'New password (at least 8 characters)', ok: 'Reset', minLen: 8 }); if (!pw) return; try { await api('PATCH', 'users/' + el.dataset.id, { password: pw }); toast('Password reset'); } catch (ex) { toast(ex.message, true); } },
  async testSheet() { try { const r = await api('POST', 'settings/test-sheet'); toast(r.ok ? 'Test row added to your sheet' : (r.error || 'Could not add a row'), !r.ok); } catch (ex) { toast(ex.message, true); } },
  async testApi() { try { const r = await api('POST', 'settings/test-api'); const x = r.result; toast(x && x.ok ? 'Your system answered (' + x.status + ')' : 'Your system did not accept the call: ' + (x ? (x.status || x.error) : 'no result'), !(x && x.ok)); } catch (ex) { toast(ex.message, true); } },
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (t && ACT[t.dataset.act]) { if (t.tagName === 'A') { if (t.dataset.act === 'logout') e.preventDefault(); } ACT[t.dataset.act](t, e); } });

// ---------- router ----------
let rid = 0;
async function render() {
  const my = ++rid;
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!S.health) { try { S.health = await api('GET', 'health'); } catch (e) { $app.innerHTML = `<div class="login"><div class="note bad">${esc(e.data && e.data.error ? e.data.error : 'Cannot reach the server. Please try again.')}</div></div>`; return; } }
  if (!S.tok) { const v = viewLogin(); $app.innerHTML = v.html; v.after(); return; }
  if (!S.user) { try { S.user = (await api('GET', 'me')).user; } catch (e) { return; } }
  const mgr = RANK[S.user.role] >= RANK.manager, owner = S.user.role === 'owner';
  const [a, b] = parts;
  let v;
  try {
    if (!a) { if (!mgr) return go('#/home'); v = await viewDashboard(S.month); }
    else if (a === 'login') { return go(mgr ? '#/' : '#/home'); }
    else if (a === 'home' && !mgr) v = await viewHome();
    else if (a === 'add') v = viewAdd();
    else if (a === 'new-order') v = await viewNewOrder();
    else if (a === 'mine') v = await viewMine();
    else if (a === 'inbox') v = await viewInbox();
    else if (a === 'box') v = await viewBox();
    else if (a === 'fix' && b) v = await viewFix(b);
    else if (!mgr) return go('#/home');
    else if (a === 'orders') v = b ? await viewOrder(b) : await viewOrders();
    else if (a === 'payments') v = await viewPayments();
    else if (a === 'review') v = await viewReview();
    else if (a === 'statement') v = await viewStatement();
    else if (a === 'audit') v = await viewAudit();
    else if (a === 'team' && owner) v = await viewTeam();
    else if (a === 'settings' && owner) v = await viewSettings();
    else if (a === 'reports' && owner) v = await viewReports();
    else return go('#/');
  } catch (ex) { if (my !== rid) return; v = { active: '', html: `<div class="note bad">${esc(ex.message)}</div><p><a class="btn" href="#/">Back to start</a></p>` }; }
  if (my !== rid || !S.user) return;
  if (!S.badgeLoaded) { S.badgeLoaded = true; loadBadges(); }
  $app.innerHTML = shell(v.active, v.html);
  if (S.lastHash !== location.hash) { window.scrollTo(0, 0); S.lastHash = location.hash; }
  if (v.after) v.after();
  document.title = 'Payment Control';
  setupPrompt();
}
// First sign-in for the owner: a short "Set up your business" checklist, shown until the basics are filled in
async function setupPrompt() {
  if (S.setupChecked || !S.user || S.user.role !== 'owner') return;
  S.setupChecked = true;
  try {
    const st = (await api('GET', 'settings')).settings, us = (await api('GET', 'users')).users;
    const b = st.business || {};
    const steps = [
      { done: !!((b.name || st.businessName) && b.address && (b.taxId || b.taxNA)), t: 'Business details', d: 'Name, address and GST or tax number (they print on invoices)', go: '#/settings' },
      { done: (st.accounts || []).length > 0, t: 'Bank accounts', d: 'Where your payments arrive, so bank statements can be matched', go: '#/settings' },
      { done: us.some(u => u.role !== 'owner' && u.active !== false), t: 'Your team', d: 'Add the uploaders and managers who will use the app', go: '#/team' }
    ];
    if (steps.every(x => x.done)) return;
    const nx = steps.findIndex(x => !x.done);
    const { ov, close } = modal(`<h2>Set up your business</h2><p class="muted">Three quick steps before your team starts. You can come back to any of them later.</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin:14px 0">${steps.map((x, i) => `<a href="${x.go}" data-x="go" style="display:flex;gap:12px;align-items:flex-start;text-decoration:none;color:inherit;padding:10px 12px;border:1px solid var(--line,#e3e6ea);border-radius:10px"><span aria-hidden="true" style="font-weight:700;color:${x.done ? 'var(--acc)' : 'var(--mut,#667)'}">${x.done ? '✓' : (i + 1)}</span><span><b>${esc(x.t)}</b>${x.done ? ' <span class="muted">(done)</span>' : ''}<div class="muted" style="font-size:13px">${esc(x.d)}</div></span></a>`).join('')}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" data-x="no">Not now</button><a class="btn p" href="${steps[nx].go}" data-x="go">Start with: ${esc(steps[nx].t)}</a></div>`);
    ov.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) close(); });
  } catch (e) { /* the prompt is a convenience: never block the app */ }
}
window.addEventListener('hashchange', () => { S.badgeLoaded = false; render(); });
render();
