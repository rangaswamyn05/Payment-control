'use strict';
/* Payment Control: order and payment screens. Everything here is drag and drop first:
   drop or paste a screenshot anywhere on the page and the form fills itself. */

// ---------- drop and paste ----------
const DROP = { cur: null };
function dropZone(id, text, small) {
  return `<div class="drop${small ? ' sm' : ''}" id="${id}" tabindex="0" role="button" aria-label="${esc(text)}"><div class="di">⬇</div><div><b>${esc(text)}</b><div class="muted" style="font-size:13px">or paste it, or tap to choose</div></div><input type="file" accept="image/*" hidden></div>`;
}
function wireDrop(id, onFile) {
  const z = document.getElementById(id); if (!z) return;
  const inp = z.querySelector('input');
  z.addEventListener('click', () => inp.click());
  z.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
  inp.addEventListener('change', () => { if (inp.files[0]) onFile(inp.files[0]); });
  DROP.cur = onFile;
}
['dragover', 'dragenter'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); document.querySelectorAll('.drop').forEach(z => z.classList.add('hot')); }));
['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => { if (ev === 'drop' || !e.relatedTarget) document.querySelectorAll('.drop').forEach(z => z.classList.remove('hot')); }));
window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f && DROP.cur) DROP.cur(f); });
window.addEventListener('paste', e => {
  if (!DROP.cur || !e.clipboardData) return;
  const it = [...e.clipboardData.items].find(i => i.type.startsWith('image/')); if (!it) return;
  const f = it.getAsFile(); if (f) { e.preventDefault(); DROP.cur(f); }
});
window.addEventListener('hashchange', () => { DROP.cur = null; });

// ---------- the payment capture block (used by New order and Add payment) ----------
function newPay() {
  const t = new Date(), p = n => String(n).padStart(2, '0');
  return { mode: 'upi', imageId: '', preview: '', amount: '', date: '', today: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`, time: '', txnId: '', payer: '', payee: '', ocr: '', ocrMsg: '', busy: false };
}
function payFields(P) {
  const cash = P.mode === 'cash';
  return `<div class="seg" role="group" aria-label="Payment mode" style="margin-bottom:14px">${['upi', 'transfer', 'cheque', 'card', 'cash'].map(m => `<button type="button" class="${P.mode === m ? 'on' : ''}" data-pmode="${m}">${m === 'upi' ? 'UPI' : m === 'transfer' ? 'Bank transfer' : m === 'cheque' ? 'Cheque' : m === 'card' ? 'Card / Razorpay' : 'Cash'}</button>`).join('')}</div>
  ${cash ? '<div class="note warn" style="margin-bottom:14px">Cash is approved by the owner before it counts as confirmed.</div>' : `${P.preview ? `<div class="card" style="padding:12px;display:flex;gap:12px;align-items:center;margin-bottom:14px"><img class="thumb" alt="Your screenshot" src="${P.preview}"><div style="flex:1"><b>${P.busy ? 'Reading the screenshot…' : 'Screenshot added'}</b><div class="muted" style="font-size:13px">${esc(P.ocrMsg || '')}</div></div><button type="button" class="btn s" data-pclear>Replace</button></div>` : dropZone('pz', 'Drop the payment screenshot here')}`}
  <div class="two field"><div><label for="p_a">Amount (₹)</label><input id="p_a" class="in" data-p="amount" inputmode="decimal" value="${esc(P.amount)}"></div>${cash ? '' : `<div><label for="p_r">${P.mode === 'cheque' ? 'Cheque number' : P.mode === 'card' ? 'Payment ID' : 'Transaction ID'} <span class="opt">(required)</span></label><input id="p_r" class="in" data-p="txnId" value="${esc(P.txnId)}" autocomplete="off"></div>`}</div>
  <div class="muted" style="font-size:13px;margin-bottom:6px">Date: ${esc(P.date || P.today)} ${P.date ? '(read from the screenshot)' : '(today; the screenshot date is used when it can be read)'}</div>`;
}
function wirePay(P, redraw) {
  document.querySelectorAll('[data-p]').forEach(el => el.addEventListener('input', () => { P[el.dataset.p] = el.value; }));
  document.querySelectorAll('[data-pmode]').forEach(b => b.addEventListener('click', () => { P.mode = b.dataset.pmode; redraw(); }));
  const c = document.querySelector('[data-pclear]'); if (c) c.addEventListener('click', () => { P.imageId = ''; P.preview = ''; P.ocrMsg = ''; redraw(); });
  const onFile = f => readShot(P, f, redraw);
  if (document.getElementById('pz')) wireDrop('pz', onFile); else DROP.cur = onFile;
}
async function downscale(file, max = 2000, q = 0.85) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', q);
}
async function readShot(P, file, redraw) {
  if (!file.type.startsWith('image/')) { toast('Please drop a screenshot or photo (an image).', true); return; }
  P.busy = true; P.ocrMsg = ''; P.err = '';
  try {
    P.preview = await downscale(file); redraw();
    const { id } = await api('POST', 'images', { dataUrl: P.preview }); P.imageId = id;
    const r = await api('POST', 'ocr', { imageId: id });
    if (!r.configured) P.ocrMsg = 'Automatic reading is off. Type the amount and transaction ID.';
    else if (r.error) P.ocrMsg = r.error;
    else {
      const p = r.parsed;
      if (p.amount) P.amount = String(p.amount);
      if (p.date) { P.date = p.date; P.time = p.time || ''; }
      if (p.txnId) P.txnId = p.txnId;
      if (p.payer) P.payer = p.payer; if (p.payee) P.payee = p.payee;
      if (p.mode === 'transfer' && P.mode === 'upi') P.mode = 'transfer';
      P.ocr = p.confidence;
      P.ocrMsg = !p.txnId && P.mode !== 'cash' ? 'No transaction ID found. Without it this cannot be saved. Type it, or use a screenshot that shows it.' : p.confidence === 'low' ? 'We could only read a little. Please check every field.' : 'We read these details. Please check them.';
    }
  } catch (ex) { P.err = ex.message || 'Could not use that image'; P.imageId = ''; P.preview = ''; }
  P.busy = false; redraw();
}
function payCheck(P) {
  if (!(Number(String(P.amount).replace(/,/g, '')) > 0)) return 'Enter the amount.';
    if (P.mode !== 'cash' && !P.imageId) return 'Add the payment screenshot.';
  if (P.mode !== 'cash' && !String(P.txnId).trim()) return (P.mode === 'cheque' ? 'No cheque number. Type it from the photo, or use a photo that shows it.' : P.mode === 'card' ? 'No payment ID. Type it from the receipt, or use a screenshot that shows it.' : 'No transaction ID. Type it from the screenshot, or use a screenshot that shows it.');
  return '';
}
const payBody = P => ({ mode: P.mode, amount: String(P.amount).replace(/,/g, ''), date: (P.date || P.today) + (P.date && P.time ? 'T' + P.time : ''), txnId: P.txnId, payer: P.payer, payee: P.payee, imageId: P.imageId, ocr: P.ocr });

// ---------- Add payment (sales) ----------
function viewAdd() {
  const A = S.add || (S.add = { P: newPay(), orderCode: '', info: null, orderErr: '', seq: '', seqReason: '', needReason: null, err: '', busy: false, done: null });
  if (A.done) {
    const d = A.done;
    return { active: '#/add', html: `<div style="max-width:520px;margin:0 auto"><div class="card" style="text-align:center;padding:32px 20px"><div class="tick">✓</div><h2 style="font-size:20px">Payment ${d.seq} saved</h2><p>${inr(d.amount)} on <b>${esc(d.orderCode)}</b></p>${A.notice ? `<div class="note warn" style="margin:12px 0;text-align:left">${esc(A.notice)}</div>` : ''}${d.needsOwner && !A.notice ? '<div class="note" style="margin:12px 0">The owner will approve this entry.</div>' : ''}<button class="btn p" style="width:100%;margin-top:14px" data-act="addAnother">Add another payment</button></div></div>`, after() { DROP.cur = null; } };
  }
  const P = A.P, i = A.info;
  const opts = i ? Array.from({ length: Math.max(8, i.nextPayment + 3) }, (_, k) => k + 1).map(n => `<option value="${n}" ${String(A.seq || i.nextPayment) === String(n) ? 'selected' : ''}>Payment ${n}${n === i.nextPayment ? ' (next)' : ''}</option>`).join('') : '';
  return { active: '#/add', html: `<div style="max-width:520px;margin:0 auto"><div class="head" style="margin-bottom:12px"><div><h1 style="font-size:24px">Add payment</h1><div class="muted" style="font-size:13px;margin-top:4px">For a later instalment on an order that already exists. New customer? Use New order.</div></div></div>
  <div class="card" style="margin-bottom:14px"><div class="field"><label for="f_ph">Customer phone number <span class="opt">(finds their orders)</span></label><input id="f_ph" class="in" inputmode="tel" value="${esc(A.phone || '')}" autocomplete="off">${(A.byPhone || []).length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${A.byPhone.map(o => `<button type="button" class="btn s" data-pick="${esc(o.code)}">${esc(o.code)} · ${esc(o.customer)}</button>`).join('')}</div>` : A.phoneTried ? '<div class="muted" style="font-size:13px;margin-top:6px">No open orders for that number.</div>' : ''}</div><div class="field" style="margin:0"><label for="f_o">Order ID</label><input id="f_o" class="in" value="${esc(A.orderCode)}" autocapitalize="characters" autocomplete="off"><div id="ohint" class="${A.orderErr ? 'err' : 'ok'}" style="min-height:20px;margin-top:6px">${A.orderErr ? esc(A.orderErr) : i ? `${esc(i.customer)} · order total ${inr(i.total)}` : ''}</div></div>
  ${i && !A.orderErr ? `<div class="field" style="margin:8px 0 0"><label for="f_s">Which payment is this?</label><select id="f_s" class="in">${opts}</select></div>` : ''}
  ${A.needReason ? `<div class="field" style="margin:12px 0 0"><div class="note warn" style="margin-bottom:8px">This looks like payment ${A.needReason}, but you picked ${esc(A.seq)}. Write why, then save again.</div><input id="f_sr" class="in" placeholder="Reason" value="${esc(A.seqReason)}"></div>` : ''}</div>
  <div class="card"><form id="af" novalidate>${payFields(P)}<div class="err" id="aerr" style="min-height:18px;margin-bottom:6px">${esc(A.err || P.err || '')}</div><button class="btn p" type="submit" style="width:100%;min-height:52px" ${A.busy || P.busy ? 'disabled' : ''}>Save payment</button></form></div></div>`,
    after() {
      const redraw = () => render();
      wirePay(P, redraw);
      const fp = document.getElementById('f_ph'); let pt;
      fp.addEventListener('input', () => {
        A.phone = fp.value; clearTimeout(pt);
        pt = setTimeout(async () => {
          if (A.phone.replace(/\D/g, '').length < 7) { A.byPhone = []; A.phoneTried = false; return; }
          try { A.byPhone = (await api('GET', 'orders/by-phone/' + encodeURIComponent(A.phone))).orders; A.phoneTried = true; } catch (e) { A.byPhone = []; }
          render().then(() => { const e2 = document.getElementById('f_ph'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } });
        }, 400);
      });
      document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { A.orderCode = b.dataset.pick; A.info = null; A.orderErr = ''; A.seq = ''; A.byPhone = []; A.phoneTried = false; A.phone = ''; fo.value = A.orderCode; fo.dispatchEvent(new Event('input')); }));
      const fo = document.getElementById('f_o');
      let tm; fo.addEventListener('input', () => {
        A.orderCode = fo.value; A.info = null; A.orderErr = ''; A.seq = ''; A.needReason = null; clearTimeout(tm);
        const h = document.getElementById('ohint'); h.textContent = '';
        if (!A.orderCode.trim()) return;
        tm = setTimeout(async () => {
          try {
            const r = await api('GET', 'orders/lookup/' + encodeURIComponent(A.orderCode.trim()));
            if (r.pending) A.orderErr = 'That order is waiting for manager approval.'; else if (r.rejected) A.orderErr = 'That order was sent back. Fix it first.'; else if (r.closed) A.orderErr = 'That order is closed.'; else A.info = r;
          } catch (ex) { A.orderErr = ex.status === 404 ? 'No order with that ID.' : ex.message; }
          const keep = document.activeElement && document.activeElement.id === 'f_o'; render().then(() => { if (keep) { const e2 = document.getElementById('f_o'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } } });
        }, 350);
      });
      if (A.orderCode && !A.info && !A.orderErr) fo.dispatchEvent(new Event('input'));
      const fs = document.getElementById('f_s'); if (fs) fs.addEventListener('change', () => { A.seq = fs.value; A.needReason = null; });
      const fr = document.getElementById('f_sr'); if (fr) fr.addEventListener('input', () => { A.seqReason = fr.value; });
      document.getElementById('af').addEventListener('submit', async e => {
        e.preventDefault(); A.err = ''; P.err = '';
        if (!A.orderCode.trim() || !A.info) A.err = 'Enter a valid order ID.'; else A.err = payCheck(P);
        if (A.err) { document.getElementById('aerr').textContent = A.err; return; }
        A.busy = true; render();
        try {
          const r = await api('POST', 'payments', { ...payBody(P), orderCode: A.orderCode.trim(), seq: A.seq || A.info.nextPayment, seqReason: A.seqReason });
          A.notice = r.notice; A.done = r.payment; A.P = newPay(); A.info = null; A.orderCode = ''; A.seq = ''; A.seqReason = ''; A.needReason = null;
        } catch (ex) { if (ex.data && ex.data.needReason) { A.needReason = ex.data.expected; A.err = ''; } else A.err = ex.message; }
        A.busy = false; render();
      });
    } };
}

// ---------- New order (sales) ----------
async function viewNewOrder() {
  const { settings } = await api('GET', 'settings');
  const N = S.newOrder || (S.newOrder = { code: '', phone: '', customer: '', total: '', extra: {}, P: newPay(), err: '', busy: false, done: null });
  if (N.done) return { active: '#/new-order', html: `<div style="max-width:520px;margin:0 auto"><div class="card" style="text-align:center;padding:32px 20px"><div class="tick">✓</div><h2 style="font-size:20px">Sent for approval</h2><p><b>${esc(N.done.code)}</b> · ${esc(N.done.customer)}</p><p class="muted">A manager or the owner will approve it. You will see a note in your Inbox if anything changes.</p><button class="btn p" style="width:100%;margin-top:14px" data-act="anotherOrder">Create another order</button></div></div>`, after() { DROP.cur = null; } };
  const P = N.P, auto = settings.orderIdMode === 'auto';
  const extras = (settings.customerFields || []).map(f => `<div class="field"><label for="x_${f.key}">${esc(f.label)}</label><input id="x_${f.key}" class="in" data-x="${f.key}" value="${esc(N.extra[f.key] || '')}"></div>`).join('');
  return { active: '#/new-order', html: `<div style="max-width:520px;margin:0 auto"><div class="head" style="margin-bottom:12px"><div><h1 style="font-size:24px">New order</h1><div class="muted" style="font-size:13px;margin-top:4px">Start here for a new customer booking: phone number, order total and the first advance screenshot.</div></div></div>
  <form id="nf" novalidate><div class="card" style="margin-bottom:14px"><div class="field"><label for="oph">Customer phone number</label><input id="oph" class="in" data-n="phone" inputmode="tel" value="${esc(N.phone)}" autocomplete="off">${(N.found || []).length && !N.skipFound ? `<div class="note warn" style="margin-top:10px"><b>This customer already has open orders.</b> Pick one to add a payment to it, or continue to create a new order.<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${N.found.map(o => `<button type="button" class="btn s p" data-existing="${esc(o.code)}">${esc(o.code)} · ${esc(o.customer)}</button>`).join('')}<button type="button" class="btn s" data-newone>It's a new order</button></div></div>` : ''}</div><div class="two field">${auto ? '<div><label>Order ID</label><div class="muted" style="padding:12px 0">Created for you</div></div>' : `<div><label for="oc">Order ID</label><input id="oc" class="in" data-n="code" value="${esc(N.code)}" autocapitalize="characters" autocomplete="off"></div>`}<div><label for="ot">Total order value (₹)</label><input id="ot" class="in" data-n="total" inputmode="decimal" value="${esc(N.total)}"></div></div>
  <div class="field"><label for="ocu">Client name</label><input id="ocu" class="in" data-n="customer" value="${esc(N.customer)}"></div>${extras}</div>
  <div class="card"><h2 style="margin-bottom:10px">First advance payment</h2>${payFields(P)}<div class="err" id="nerr" style="min-height:18px;margin-bottom:6px">${esc(N.err || P.err || '')}</div><button class="btn p" type="submit" style="width:100%;min-height:52px" ${N.busy || P.busy ? 'disabled' : ''}>Send for approval</button></div></form></div>`,
    after() {
      wirePay(P, () => render());
      document.querySelectorAll('[data-n]').forEach(el => el.addEventListener('input', () => { N[el.dataset.n] = el.value; }));
      let ft; document.getElementById('oph').addEventListener('input', e => {
        clearTimeout(ft); N.skipFound = false;
        ft = setTimeout(async () => {
          if (N.phone.replace(/\D/g, '').length < 7) { if ((N.found || []).length) { N.found = []; render(); } return; }
          try { N.found = (await api('GET', 'orders/by-phone/' + encodeURIComponent(N.phone))).orders; } catch (er) { N.found = []; }
          if (N.found.length) render().then(() => { const e2 = document.getElementById('oph'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } });
        }, 400);
      });
      document.querySelectorAll('[data-existing]').forEach(b => b.addEventListener('click', () => { S.add = { P: N.P, orderCode: b.dataset.existing, info: null, orderErr: '', seq: '', seqReason: '', needReason: null, err: '', busy: false, done: null, phone: '', byPhone: [] }; S.newOrder = null; go('#/add'); }));
      const nw = document.querySelector('[data-newone]'); if (nw) nw.addEventListener('click', () => { N.skipFound = true; render(); });
      document.querySelectorAll('[data-x]').forEach(el => el.addEventListener('input', () => { N.extra[el.dataset.x] = el.value; }));
      document.getElementById('nf').addEventListener('submit', async e => {
        e.preventDefault(); N.err = ''; P.err = '';
        if (N.phone.replace(/\D/g, '').length < 7) N.err = 'Enter the customer’s phone number.'; else if (!auto && !N.code.trim()) N.err = 'Enter the order ID.'; else if (!N.customer.trim()) N.err = 'Enter the client name.'; else if (!(Number(String(N.total).replace(/,/g, '')) > 0)) N.err = 'Enter the total order value.';
        else N.err = payCheck(P);
        if (N.err) { document.getElementById('nerr').textContent = N.err; return; }
        N.busy = true; render();
        const send = confirmSame => api('POST', 'orders', { code: N.code.trim(), phone: N.phone, confirmSamePhone: confirmSame, customer: N.customer, total: String(N.total).replace(/,/g, ''), customerExtra: N.extra, firstPayment: payBody(P) });
        try { let r; try { r = await send(false); } catch (ex) { if (ex.data && ex.data.samePhone) { const l = ex.data.samePhone.map(o => `${o.code} (${o.customer})`).join(', '); if (!(await confirmBox({ title: 'Same customer?', text: `This phone number already has: ${l}. If it is the same customer, check you are not creating a duplicate. Create a new order anyway?`, ok: 'Yes, new order' }))) { N.busy = false; render(); return; } r = await send(true); } else throw ex; } N.done = r.order; }
        catch (ex) { N.err = ex.message; }
        N.busy = false; render();
      });
    } };
}

// ---------- fix and resend a rejected order (sales) ----------
async function viewFix(code) {
  const [{ orders }, { settings }] = await Promise.all([api('GET', 'orders/mine'), api('GET', 'settings')]);
  const o = orders.find(x => x.code === code);
  if (!o || o.status !== 'rejected') return { active: '#/mine', html: `${backBtn('#/mine')}<div class="note">This order is not waiting for changes.</div>` };
  const extras = (settings.customerFields || []).map(f => `<div class="field"><label>${esc(f.label)}</label><input class="in" data-x="${f.key}" value="${esc((o.customerExtra || {})[f.key] || '')}"></div>`).join('');
  return { active: '#/mine', html: `${backBtn('#/mine')}<div style="max-width:520px;margin:0 auto"><h1 style="font-size:24px;margin-bottom:10px">Fix ${esc(o.code)}</h1><div class="note warn" style="margin-bottom:14px">Sent back: ${esc(o.rejectReason)}</div>
  <form class="card" id="ff"><div class="field"><label for="fc">Client name</label><input id="fc" class="in" value="${esc(o.customer)}"></div><div class="field"><label for="ft">Total order value (₹)</label><input id="ft" class="in" inputmode="decimal" value="${esc(o.total)}"></div>${extras}<div class="err" id="ferr" style="min-height:18px"></div><button class="btn p" style="width:100%" type="submit">Send again for approval</button></form></div>`,
    after() { document.getElementById('ff').addEventListener('submit', async e => { e.preventDefault(); const ex = {}; document.querySelectorAll('[data-x]').forEach(i => { ex[i.dataset.x] = i.value; }); try { await api('POST', `orders/${encodeURIComponent(code)}/resubmit`, { customer: document.getElementById('fc').value, total: document.getElementById('ft').value.replace(/,/g, ''), customerExtra: ex }); toast('Sent again'); go('#/mine'); } catch (er) { document.getElementById('ferr').textContent = er.message; } }); } };
}

// ---------- My submissions ----------
async function viewMine() {
  const mgr = RANK[S.user.role] >= RANK.manager;
  const [{ payments }, mo] = await Promise.all([api('GET', 'payments/mine'), mgr ? { orders: [] } : api('GET', 'orders/mine')]);
  const orders = mo.orders || [];
  const ob = o => o.status === 'pending' ? '<span class="badge warn">Waiting for approval</span>' : o.status === 'rejected' ? '<span class="badge bad">Sent back</span>' : '<span class="badge good">Approved</span>';
  const orows = orders.map(o => `<div class="tr" style="min-width:420px"><div class="c1"><b>${esc(o.code)}</b><div class="muted" style="font-size:13px">${esc(o.customer)}</div>${o.status === 'rejected' ? `<div class="err">${esc(o.rejectReason)}</div>` : ''}</div><div class="c r">${ob(o)}</div>${o.status === 'rejected' ? `<div class="c r"><a class="btn s p" href="#/fix/${encodeURIComponent(o.code)}">Fix and resend</a></div>` : ''}</div>`).join('');
  const rows = payments.map(p => `<div class="tr" style="min-width:420px"><div class="c1"><b>${esc(p.orderCode)}</b><div class="muted" style="font-size:13px">${esc(fdate(p.date))}${p.seq ? ' · payment ' + p.seq : ''}</div></div><div class="c">${esc(MODE[p.mode] || p.mode)}</div><div class="c r"><b>${inr(p.amount)}</b></div></div>`).join('');
  return { active: '#/mine', html: `<div class="head"><div><h1>${mgr ? 'My entries' : 'My submissions'}</h1><div class="muted">${payments.length} payment${payments.length === 1 ? '' : 's'} added by you</div></div><a class="btn p" href="#/add">Add payment</a></div>
  ${orows ? `<div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:6px">My orders</h2><div class="tbl">${orows}</div></div>` : ''}
  <div class="card">${rows ? `<div class="tbl">${rows}</div>` : '<p class="muted">Nothing yet.</p>'}</div>` };
}

// ---------- Inbox ----------
async function viewInbox() {
  const { notifications } = await api('GET', 'notifications');
  api('POST', 'notifications/read', {}).then(() => { S.unread = 0; document.querySelectorAll('.nav a[href="#/inbox"] .pill').forEach(p => p.remove()); }).catch(() => { });
  const rows = notifications.map(n => `<div class="tr" style="min-width:0;align-items:flex-start"><div class="c1" ${n.read ? '' : 'style="font-weight:600"'}>${esc(n.text)}<div class="muted" style="font-size:12px;font-weight:400">${esc(new Date(n.created).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</div></div>${n.orderCode && RANK[S.user.role] >= RANK.manager ? `<a class="btn s" href="#/orders/${encodeURIComponent(n.orderCode)}">Open</a>` : ''}</div>`).join('');
  return { active: '#/inbox', html: `<div class="head"><div><h1>Inbox</h1><div class="muted">Approvals, changes and alerts that need you.</div></div></div><div class="card">${rows || '<p class="muted">Nothing new.</p>'}</div>` };
}
async function loadBadges() {
  try {
    const mgr = RANK[S.user.role] >= RANK.manager;
    const [n, s] = await Promise.all([api('GET', 'notifications'), mgr ? api('GET', 'summary') : null]);
    S.unread = n.unread;
    if (s) S.badge = s.flaggedCount + s.cashPendingCount + s.pendingOrders + (s.adjustRequests || 0) + (S.user.role === 'owner' ? s.ownerPending || 0 : 0);
    const set = (h, label, c) => document.querySelectorAll(`.nav a[href="${h}"]`).forEach(a => { a.innerHTML = label + (c ? `<span class="pill">${c}</span>` : ''); });
    set('#/inbox', 'Inbox', S.unread); if (mgr) set('#/review', 'Review', S.badge);
  } catch (e) { /* badges are optional */ }
}

// ---------- Review (managers and owner) ----------
const REASON2 = { possible_duplicate: 'Possible duplicate', overpayment: 'More than the order total' };
async function viewReview() {
  const owner = S.user.role === 'owner';
  const [{ payments: all }, { orders: allOrders }, { requests }] = await Promise.all([api('GET', 'payments'), api('GET', 'orders'), api('GET', 'requests')]);
  const toApprove = allOrders.filter(o => o.status === 'pending');
  const waitOwner = all.filter(p => (p.approval === 'pending_owner' || p.status === 'cash_pending') && p.status !== 'rejected' && p.status !== 'flagged');
  const flags = all.filter(p => p.status === 'flagged');
  const wait = all.filter(p => p.status === 'client_reported');
  const line = p => `<div style="border-top:1px solid #EEF2F6;padding:14px 0"><div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px"><div><b>${inr(p.amount)}</b> · <a href="#/orders/${encodeURIComponent(p.orderCode)}" style="color:var(--acc);font-weight:600">${esc(p.orderCode)}</a> <span class="muted">${esc(p.customer || '')}</span><div class="muted" style="font-size:13px">${esc(MODE[p.mode] || p.mode)} · ${esc(fdate(p.date))} · by ${esc(p.createdByName || '')}${p.seqReason ? ' · out of order: ' + esc(p.seqReason) : ''}</div>${p.reason ? `<div class="err">${esc(REASON2[p.reason] || p.reason)}</div>` : ''}</div><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">${payActions(p)}</div></div></div>`;
  const orderRow = o => `<div style="border-top:1px solid #EEF2F6;padding:14px 0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px"><div><b>${esc(o.code)}</b> · ${esc(o.customer)} · <b>${inr(o.total)}</b><div class="muted" style="font-size:13px">Created by ${esc(o.createdBy)}</div></div><button class="btn s p" data-act="reviewOrder" data-code="${esc(o.code)}">Review</button></div>`;
  const reqRow = r => `<div style="border-top:1px solid #EEF2F6;padding:14px 0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px"><div><b>${esc(r.orderCode)}</b> · ${r.kind === 'close_offline' ? `close with ${inr(r.amount)} received offline` : `change total ${inr(r.oldTotal)} to ${inr(r.newTotal)}`}<div class="muted" style="font-size:13px">${esc(r.by)}: ${esc(r.comment)}</div></div>${owner ? `<div style="display:flex;gap:6px"><button class="btn s p" data-act="reqApprove" data-id="${r.id}">Approve</button><button class="btn s d" data-act="reqReject" data-id="${r.id}">Decline</button></div>` : '<span class="muted">Waiting for the owner</span>'}</div>`;
  S.badge = flags.length + waitOwner.length + toApprove.length + requests.length;
  const sec = (t, n, sub, body, w) => `<div class="card a" style="flex-basis:${w || 480}px"><h2>${t} <span class="muted" style="font-weight:500">· ${n}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">${sub}</div>${body || '<p class="muted">Nothing here.</p>'}</div>`;
  return { active: '#/review', html: `<div class="head"><div><h1>Needs your review</h1><div class="muted">New orders, owner approvals and anything unusual.</div></div></div>
  ${toApprove.length ? `<div class="card a" style="margin-bottom:16px"><h2>Orders to approve <span class="muted" style="font-weight:500">· ${toApprove.length}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">Created by the sales team. Approve, change and approve, or send back.</div>${toApprove.map(orderRow).join('')}</div>` : ''}
  <div class="grid2">${sec('Waiting for the owner', waitOwner.length, owner ? 'Cash, entries over the limit and entries by managers.' : 'Cash, entries over the limit and entries by managers. Only the owner can approve these.', waitOwner.map(line).join(''))}
  ${sec('Changes to outstanding', requests.length, 'A manager asked to close an order or change its total.', requests.map(reqRow).join(''))}</div>
  <div class="grid2" style="margin-top:16px">${sec('Flagged', flags.length, 'Possible duplicates and payments above the order total.', flags.map(line).join(''))}
  ${sec('Validation pending', wait.length, `Best way to clear these: <a href="#/statement" style="color:var(--acc);font-weight:600">drop a bank statement</a>. These are not wrong, just not checked yet.`, wait.map(line).join(''))}</div>` };
}
function payActions(p) {
  const owner = S.user.role === 'owner', a = [];
  if ((p.status === 'cash_pending' || p.approval === 'pending_owner') && p.status !== 'flagged') a.push(owner ? `<button class="btn s p" data-act="ownerApprove" data-id="${p.id}">Approve</button>` : '<span class="muted" style="font-size:12px">Owner approves</span>');
  if (p.status === 'client_reported' && p.createdBy !== S.user.id) a.push(`<button class="btn s" data-act="verify" data-id="${p.id}">Verify manually</button>`);
  if (p.status === 'flagged') a.push(`<button class="btn s" data-act="release" data-id="${p.id}">Keep it</button>`);
  if (!['rejected', 'verified', 'cash_confirmed'].includes(p.status)) a.push(`<button class="btn s d" data-act="reject" data-id="${p.id}">Reject</button>`);
  return a.join(' ');
}

// ---------- Order detail ----------
async function viewOrder(code) {
  const { order: o, payments, invoice } = await api('GET', 'orders/' + encodeURIComponent(code));
  const owner = S.user.role === 'owner';
  const pct = v => o.total ? Math.min(100, Math.round(v * 100 / o.total)) : 0;
  const rows = payments.map(p => `<div class="tr" style="min-width:820px"><div class="c" style="flex:.6">${p.seq ? '#' + p.seq : ''}</div><div class="c" style="flex:1.2">${esc(fdate(p.date))}</div><div class="c" style="flex:.8">${esc(MODE[p.mode] || p.mode)}</div><div class="c r" style="flex:1"><b>${inr(p.amount)}</b></div><div class="c1">${statusBadge(p)}<div class="muted" style="font-size:12px">${esc(p.validationNote || '')}</div>${p.seqReason ? `<div class="muted" style="font-size:12px">Out of order: ${esc(p.seqReason)}</div>` : ''}</div><div class="c" style="flex:1.2">${p.imageId ? `<a href="${imgUrl(p.imageId)}" target="_blank" rel="noopener" style="color:var(--acc);font-weight:600">Screenshot</a>` : ''}</div><div class="c1" style="display:flex;gap:6px;flex-wrap:wrap">${payActions(p)}</div></div>`).join('');
  const closed = o.status === 'closed';
  const vnote = o.validationNote ? `<div class="badge ${o.validation === 'unable' ? 'warn' : o.validation === 'validated' ? 'good' : ''}" style="margin-top:6px">${esc(o.validationNote)}</div>` : '';
  const mods = (o.modifications || []).map(m => `<div class="muted" style="font-size:13px">${esc(m.field)}: ${esc(m.from)} → ${esc(m.to)} by ${esc(m.by)}${m.comment ? ' (' + esc(m.comment) + ')' : ''}</div>`).join('');
  return { active: '#/orders', html: `${backBtn('#/orders')}<div class="head"><div><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h1>${esc(o.code)}</h1>${orderBadge(o)}</div><div class="muted">${esc(o.customer)}</div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">${invoice ? `<a class="btn" target="_blank" rel="noopener" href="/api/invoices/${encodeURIComponent(o.code)}?t=${encodeURIComponent(S.tok)}">Invoice</a>` : ''}${o.status === 'open' ? '<button class="btn" data-act="adjust" data-code="' + esc(o.code) + '">Adjust outstanding</button>' : ''}${closed ? `<button class="btn" data-act="reopen" data-code="${esc(o.code)}">Reopen</button>` : `<button class="btn p" data-act="closeOrder" data-code="${esc(o.code)}">Close order</button>`}</div></div>
  <div class="card" style="margin-bottom:16px"><div class="row" style="gap:16px 36px;margin-bottom:14px"><div><div class="muted">Order total</div><div style="font-size:24px;font-weight:700">${inr(o.total)}</div></div><div><div class="muted">Collected</div><div style="font-size:24px;font-weight:700">${inr(o.collected)}</div></div><div><div class="muted">Outstanding</div><div style="font-size:24px;font-weight:700;color:${o.outstanding ? 'var(--warn)' : 'var(--good)'}">${inr(o.outstanding)}</div></div></div>
  <div class="row" style="gap:12px 30px;margin-bottom:12px"><div><span class="dot" style="background:#12B76A"></span>Validated by statement <b>${inr(o.validated)}</b></div><div><span class="dot" style="background:#7A5AF8"></span>Manually validated, not system validated <b>${inr(o.manual)}</b></div><div><span class="dot" style="background:#F79009"></span>Not validated <b>${inr(o.notValidated)}</b></div></div>
  <div class="bar" aria-hidden="true"><i style="width:${pct(o.validated)}%;background:#12B76A"></i><i style="width:${pct(o.manual)}%;background:#7A5AF8"></i><i style="width:${pct(o.notValidated)}%;background:#F79009"></i></div>${vnote}${mods ? `<div style="margin-top:10px">${mods}</div>` : ''}</div>
  <div class="card"><h2 style="margin-bottom:8px">Payments on this order</h2>${rows ? `<div class="tbl"><div class="tr h" style="min-width:820px"><div class="c" style="flex:.6">No.</div><div class="c" style="flex:1.2">Date</div><div class="c" style="flex:.8">Mode</div><div class="c r" style="flex:1">Amount</div><div class="c1">Status</div><div class="c" style="flex:1.2">Proof</div><div class="c1"></div></div>${rows}</div>` : '<p class="muted">No payments yet.</p>'}</div>` };
}

// ---------- Reports and clear data (owner) ----------
async function viewReports() {
  const per = S.rep || new Date().toISOString().slice(0, 7);
  const kind = per === 'all' ? 'all' : /^\d{4}$/.test(per) ? 'year' : 'month';
  const { report: r, orders } = await api('GET', 'reports?period=' + per);
  const yrs = []; for (let y = +new Date().toISOString().slice(0, 4); y >= 2020; y--) yrs.push(y);
  const k = (l, v, sub) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${inr(v)}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>`;
  const rows = orders.map(o => `<a class="tr" href="#/orders/${encodeURIComponent(o.code)}" style="min-width:700px"><div class="c1"><b>${esc(o.code)}</b><div class="muted" style="font-size:13px">${esc(o.customer)}</div></div><div class="c r">${inr(o.total)}</div><div class="c r">${inr(o.collected)}</div><div class="c r">${inr(o.outstanding)}</div><div class="c r">${inr(o.validated)}</div><div class="c r">${inr(o.manual)}</div></a>`).join('');
  return { active: '#/reports', html: `<div class="head"><div><h1>Reports</h1><div class="muted">${r.orders} order${r.orders === 1 ? '' : 's'} · ${esc(periodName(per))}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap"><select id="rk" class="in" style="width:auto"><option value="month" ${kind === 'month' ? 'selected' : ''}>Month</option><option value="year" ${kind === 'year' ? 'selected' : ''}>Year</option><option value="all" ${kind === 'all' ? 'selected' : ''}>Overall</option></select>${kind === 'month' ? `<input id="rm" type="month" class="in" style="width:auto" value="${esc(per)}">` : ''}${kind === 'year' ? `<select id="ry" class="in" style="width:auto">${yrs.map(y => `<option ${String(y) === per ? 'selected' : ''}>${y}</option>`).join('')}</select>` : ''}<a class="btn p" id="dl" href="/api/reports?period=${encodeURIComponent(per)}&csv=1&t=${encodeURIComponent(S.tok)}" download>Download report</a></div></div>
  <div class="row" style="margin-bottom:16px">${k('Revenue (order totals)', r.revenue)}${k('Collected', r.collected)}${k('Outstanding', r.outstanding)}${k('Validated by statement', r.validated)}${k('Manually validated', r.manual, 'not system validated')}</div>
  <div class="card"><div class="tbl"><div class="tr h" style="min-width:700px"><div class="c1">Order</div><div class="c r">Total</div><div class="c r">Collected</div><div class="c r">Outstanding</div><div class="c r">Validated</div><div class="c r">Manual</div></div>${rows || '<p class="muted">No orders in this period.</p>'}</div></div>
  <div class="card" style="margin-top:16px"><h2>Clear old files</h2><p class="muted" style="margin:6px 0 12px">Frees storage by removing invoice files and payment screenshots of <b>closed orders</b>. Order records and totals stay, so your revenue history is kept. You must download the report first.</p><button class="btn d" data-act="clearData">Clear invoice files and screenshots</button></div>`,
    after() {
      const set = v => { S.rep = v; render(); };
      document.getElementById('rk').addEventListener('change', e => { const v = e.target.value; set(v === 'all' ? 'all' : v === 'year' ? new Date().toISOString().slice(0, 4) : new Date().toISOString().slice(0, 7)); });
      const rm = document.getElementById('rm'); if (rm) rm.addEventListener('change', e => { if (e.target.value) set(e.target.value); });
      const ry = document.getElementById('ry'); if (ry) ry.addEventListener('change', e => set(e.target.value));
    } };
}

// ---------- Settings (owner) ----------
const KINDS = ['Sole proprietor', 'Partnership', 'Private limited company', 'LLP', 'Other'];
const INDUSTRIES = ['Photography and events', 'Retail', 'Manufacturing', 'Services', 'Education', 'Healthcare', 'Real estate', 'Other'];
const GSTS = ['', 'GST registered (regular)', 'GST composition scheme', 'Not registered'];
const STORES = [['app', 'Payment Control only'], ['app_sheet', 'Payment Control + Google Sheet'], ['app_api', 'Payment Control + my own system (API)'], ['all', 'All three']];
async function viewSettings() {
  const { settings: s } = await api('GET', 'settings');
  const a = s.connectors.api, b = s.business, lm = s.limits;
  const sel = (id, list, cur, blank) => `<select id="${id}" class="in">${blank ? '<option value="">Choose…</option>' : ''}${list.map(x => { const v = Array.isArray(x) ? x[0] : x, t = Array.isArray(x) ? x[1] : x; return `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t || 'Choose…')}</option>`; }).join('')}</select>`;
  return { active: '#/settings', html: `<div class="head"><div><h1>Settings</h1><div class="muted">Set up your business once. Change anything later.</div></div></div>
  <form id="sf2" class="grid2"><div class="card a">
  <h2 style="margin-bottom:10px">Your business</h2>
  <div class="two field"><div><label for="bz">Business name</label><input id="bz" class="in" value="${esc(b.name || s.businessName)}"></div><div><label for="bk">Kind of business</label>${sel('bk', KINDS, b.kind, 1)}</div></div>
  <div class="two field"><div><label for="bi">Industry</label>${sel('bi', INDUSTRIES, b.industry, 1)}</div><div><label for="bg">GST</label>${sel('bg', GSTS, b.gstRate)}</div></div>
  <div class="field"><label for="bt">GST or tax number</label><input id="bt" class="in" value="${esc(b.taxId)}" ${b.taxNA ? 'disabled' : ''}><label style="font-weight:400;margin-top:8px"><input type="checkbox" id="bn" ${b.taxNA ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">GST or tax is not applicable to my business</label></div>
  <div class="field"><label for="ba">Address</label><input id="ba" class="in" value="${esc(b.address)}"></div><div class="field"><label for="bc">Phone and email on the invoice</label><input id="bc" class="in" value="${esc(b.contact)}"></div>
  <div class="field"><label for="cf">What to collect about each customer <span class="opt">(comma separated, e.g. Phone number)</span></label><input id="cf" class="in" value="${esc((s.customerFields || []).map(f => f.label).join(', '))}"><div class="muted" style="font-size:13px;margin-top:4px">Sales enters these once, when creating an order. They appear on the invoice.</div></div>
  <div class="field"><label>Sample invoice <span class="opt">(optional)</span></label>${dropZone('iz', s.invoiceSampleId ? 'Sample added. Drop a new one to replace it' : 'Drop a sample invoice here', 1)}<div class="muted" style="font-size:13px;margin-top:4px">Invoices follow this style. If it shows details we do not collect, we will ask you.</div></div>
  <h2 style="margin:20px 0 10px">Order IDs</h2>
  <div class="field"><label for="om">How are orders numbered?</label>${sel('om', [['own', 'I use my own order IDs (sales types them)'], ['auto', 'Create order IDs for me']], s.orderIdMode)}<div class="muted" style="font-size:13px;margin-top:4px">Every order also needs the customer's phone number. It lets sales find a customer's orders and warns about duplicates.</div></div>
  <h2 style="margin:20px 0 10px">Where records are kept</h2>
  <div class="field"><label for="st">Storage</label>${sel('st', STORES, s.storage)}<div class="muted" style="font-size:13px;margin-top:4px">Payment Control always keeps every record. The others receive a copy of each approved order and payment. They are only added to, never edited or deleted. Approvals and roles stay here.</div></div>
  <h2 style="margin:20px 0 10px">Limits and alerts</h2><div class="two field"><div><label for="l1">Owner approval above (₹)</label><input id="l1" class="in" inputmode="decimal" value="${lm.singlePayment || ''}" placeholder="No limit"></div><div><label for="l2">Alert when an order collects more than (₹)</label><input id="l2" class="in" inputmode="decimal" value="${lm.collectionThreshold || ''}" placeholder="No alert"></div></div>
  <div class="muted" style="font-size:13px;margin-bottom:12px">Limits never block an entry. They flag it and notify you.</div>
  <h2 style="margin:20px 0 6px">Business API connector</h2><div class="field"><label><input type="checkbox" id="ae" ${a.enabled ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">Send payments to my system</label></div>
  <div class="field"><label for="au">Endpoint URL</label><input id="au" class="in" placeholder="https://your-panel.example.com/api/record-payment" value="${esc(a.url)}"></div>
  <div class="field"><label for="ak">Secret key ${a.keySet ? '<span class="opt">(saved, leave blank to keep it)</span>' : ''}</label><input id="ak" type="password" class="in" autocomplete="off"></div>
  <div class="err" id="serr" style="min-height:18px"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn p" type="submit">Save settings</button><button class="btn" type="button" data-act="testApi">Send a test call</button></div></div>
  <div class="card b"><h2 style="margin-bottom:10px">This workspace</h2><div style="display:flex;flex-direction:column;gap:8px"><div>Storage: <b>${S.health.db === 'supabase' ? 'Database connected' : 'Demo (temporary)'}</b></div><div>Screenshot reading: <b>${S.health.ocr ? 'On' : 'Off'}</b></div></div><p class="muted" style="font-size:13px;margin-top:14px">Approval rules, dashboard views and alerts you can set here today are the limits above. Setting them by chat is planned.</p></div></form>`,
    after() {
      const bn = document.getElementById('bn'); bn.addEventListener('change', () => { document.getElementById('bt').disabled = bn.checked; });
      let sampleId = s.invoiceSampleId || '';
      wireDrop('iz', async f => { try { const d = await downscale(f); const r = await api('POST', 'images', { dataUrl: d }); sampleId = r.id; document.querySelector('#iz b').textContent = 'Sample added. Save to keep it'; } catch (ex) { toast(ex.message, true); } });
      document.getElementById('sf2').addEventListener('submit', async e => {
        e.preventDefault(); const er = document.getElementById('serr'); er.textContent = '';
        const v = id => document.getElementById(id).value;
        try {
          await api('PUT', 'settings', { businessName: v('bz'), onboarded: true, storage: v('st'), orderIdMode: v('om'), invoiceSampleId: sampleId,
            business: { name: v('bz'), kind: v('bk'), industry: v('bi'), gstRate: v('bg'), taxId: v('bt'), taxNA: bn.checked, address: v('ba'), contact: v('bc') },
            customerFields: v('cf').split(',').map(x => ({ label: x.trim() })).filter(x => x.label),
            limits: { singlePayment: v('l1').replace(/,/g, ''), collectionThreshold: v('l2').replace(/,/g, '') },
            connectors: { api: { enabled: document.getElementById('ae').checked, url: v('au'), key: v('ak') } } });
          toast('Settings saved'); render();
        } catch (ex) { er.textContent = ex.message; }
      });
    } };
}

// ---------- actions for these screens ----------
Object.assign(ACT, {
  mode() { }, pickImg() { },
  anotherOrder() { S.newOrder = null; render(); },
  addAnother() { S.add = null; render(); },
  async ownerApprove(el) { try { await api('POST', `payments/${el.dataset.id}/approve`, {}); toast('Approved'); render(); } catch (ex) { toast(ex.message, true); } },
  async reqApprove(el) { try { await api('POST', `requests/${el.dataset.id}/approve`, {}); toast('Approved and applied'); render(); } catch (ex) { toast(ex.message, true); } },
  async reqReject(el) { try { await api('POST', `requests/${el.dataset.id}/reject`, {}); toast('Declined'); render(); } catch (ex) { toast(ex.message, true); } },
  async reviewOrder(el) {
    const code = el.dataset.code;
    const [{ order: o, payments }, { settings }] = await Promise.all([api('GET', 'orders/' + encodeURIComponent(code)), api('GET', 'settings')]);
    const p = payments[0];
    const extras = (settings.customerFields || []).map(f => `<div class="field"><label>${esc(f.label)}</label><input class="in" data-rx="${f.key}" value="${esc((o.customerExtra || {})[f.key] || '')}"></div>`).join('');
    const { ov, close } = modal(`<h2>${esc(o.code)}</h2><p class="muted" style="margin:4px 0 12px">Created by ${esc(o.createdBy)}. Change anything that is wrong, then approve.</p>
    ${p ? `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">${p.imageId ? `<a href="${imgUrl(p.imageId)}" target="_blank" rel="noopener"><img class="thumb" src="${imgUrl(p.imageId)}" alt="Advance screenshot"></a>` : ''}<div>First advance <b>${inr(p.amount)}</b><div class="muted" style="font-size:13px">${esc(MODE[p.mode] || p.mode)} · ${esc(p.txnId || '')}</div></div></div>` : ''}
    <div class="field"><label>Client name</label><input class="in" id="rc" value="${esc(o.customer)}"></div><div class="field"><label>Total order value (₹)</label><input class="in" id="rt" inputmode="decimal" value="${esc(o.total)}"></div>${extras}
    <div class="field"><label>Comment <span class="opt">(shown to sales if you change anything)</span></label><input class="in" id="rm2"></div><div class="err" id="rerr" style="min-height:18px"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="btn" data-x="no">Cancel</button><button class="btn d" data-x="rej">Send back</button><button class="btn p" data-x="ok">Approve</button></div>`);
    const changed = () => ov.querySelector('#rc').value.trim() !== o.customer || Number(ov.querySelector('#rt').value.replace(/,/g, '')) !== o.total || [...ov.querySelectorAll('[data-rx]')].some(i => i.value.trim() !== ((o.customerExtra || {})[i.dataset.rx] || ''));
    const lab = () => { ov.querySelector('[data-x=ok]').textContent = changed() ? 'Change and approve' : 'Approve'; };
    ov.addEventListener('input', lab);
    ov.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]'); if (!x) return;
      if (x.dataset.x === 'no') return close();
      if (x.dataset.x === 'rej') { close(); return ACT.rejectOrder({ dataset: { code } }); }
      const ex = {}; ov.querySelectorAll('[data-rx]').forEach(i => { ex[i.dataset.rx] = i.value; });
      try { await api('POST', `orders/${encodeURIComponent(code)}/approve`, { customer: ov.querySelector('#rc').value, total: ov.querySelector('#rt').value.replace(/,/g, ''), customerExtra: ex, comment: ov.querySelector('#rm2').value }); close(); toast('Approved. Invoice created.'); render(); } catch (er) { ov.querySelector('#rerr').textContent = er.message; }
    });
  },
  async approveOrder(el) { return ACT.reviewOrder(el); },
  async adjust(el) {
    const code = el.dataset.code;
    const { order: o } = await api('GET', 'orders/' + encodeURIComponent(code));
    const owner = S.user.role === 'owner';
    const { ov, close } = modal(`<h2>Adjust outstanding on ${esc(code)}</h2><p class="muted" style="margin:4px 0 12px">Outstanding now <b>${inr(o.outstanding)}</b>. ${owner ? 'Your change applies straight away.' : 'Your change goes to the owner for approval.'}</p>
    <div class="seg" style="margin-bottom:12px"><button type="button" class="on" data-k="close_offline">Received offline</button><button type="button" data-k="change_total">Change the total</button></div>
    <div id="adj1"><div class="note" style="margin-bottom:8px">Closes the order, recording ${inr(o.outstanding)} as received offline.</div></div><div id="adj2" style="display:none" class="field"><label>New total (₹)</label><input class="in" id="nt" inputmode="decimal" value="${esc(o.total)}"></div>
    <div class="field"><label>Comment <span class="opt">(required)</span></label><input class="in" id="ac"></div><div class="err" id="aerr2" style="min-height:18px"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-x="no">Cancel</button><button class="btn p" data-x="ok">${owner ? 'Apply' : 'Send to owner'}</button></div>`);
    let kind = 'close_offline';
    ov.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => { kind = b.dataset.k; ov.querySelectorAll('[data-k]').forEach(x => x.classList.toggle('on', x === b)); ov.querySelector('#adj1').style.display = kind === 'close_offline' ? '' : 'none'; ov.querySelector('#adj2').style.display = kind === 'change_total' ? '' : 'none'; }));
    ov.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]'); if (!x) return; if (x.dataset.x === 'no') return close();
      try { const r = await api('POST', `orders/${encodeURIComponent(code)}/adjust`, { kind, amount: o.outstanding, newTotal: ov.querySelector('#nt').value.replace(/,/g, ''), comment: ov.querySelector('#ac').value }); close(); toast(r.applied ? 'Done' : 'Sent to the owner'); render(); } catch (er) { ov.querySelector('#aerr2').textContent = er.message; }
    });
  },
  async clearData() {
    try { await api('POST', 'data/clear', {}); }
    catch (ex) {
      if (ex.data && ex.data.needDownload) { toast('Download the report first, then clear.', true); return; }
      if (!(ex.data && ex.data.needConfirm)) { toast(ex.message, true); return; }
      const ok = await confirmBox({ title: 'Clear invoice files and screenshots?', text: 'This removes them for closed orders only. Order records and totals stay. It cannot be undone.', ok: 'Clear now', danger: true });
      if (!ok) return;
      try { const r = await api('POST', 'data/clear', { confirm: true }); toast(`Cleared ${r.invoices} invoice files and ${r.screenshots} screenshots`); render(); } catch (e2) { toast(e2.message, true); }
    }
  },
});
