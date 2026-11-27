'use strict';
/* Payment Control: order and payment screens. Everything here is drag and drop first:
   drop or paste a screenshot anywhere on the page and the form fills itself. */

// ---------- drop and paste ----------
const DROP = { cur: null };
function dropZone(id, text, small, accept) {
  return `<div class="drop${small ? ' sm' : ''}" id="${id}" tabindex="0" role="button" aria-label="${esc(text)}"><div class="di">⬇</div><div><b>${esc(text)}</b><div class="muted" style="font-size:13px">or paste it, or tap to choose</div></div><input type="file" accept="${accept || 'image/*'}" hidden></div>`;
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
  return `<div class="seg" role="group" aria-label="Payment mode" style="margin-bottom:14px">${['upi', 'transfer', 'cheque', 'cash', 'card'].map(m => `<button type="button" class="${P.mode === m ? 'on' : ''}" data-pmode="${m}">${m === 'upi' ? 'UPI' : m === 'transfer' ? 'Bank transfer' : m === 'cheque' ? 'Cheque' : m === 'card' ? 'Card / Razorpay' : 'Cash'}</button>`).join('')}</div>
  ${cash ? '<div class="note warn" style="margin-bottom:14px">Cash is approved by the owner before it counts as confirmed.</div>' : `${P.preview ? `<div class="card" style="padding:12px;display:flex;gap:12px;align-items:center;margin-bottom:14px"><img class="thumb" alt="Your screenshot" src="${P.preview}"><div style="flex:1"><b>${P.busy ? 'Reading the screenshot…' : 'Screenshot added'}</b><div class="muted" style="font-size:13px">${esc(P.ocrMsg || '')}</div></div><button type="button" class="btn s" data-pclear>Replace</button></div>${P.rawText ? `<details class="muted" style="font-size:12px;margin:-6px 0 12px"><summary>What the reader saw</summary><pre style="white-space:pre-wrap;margin:6px 0 0">${esc(P.rawText)}</pre></details>` : ''}` : dropZone('pz', 'Drop the payment screenshot here')}<div class="muted" style="font-size:13px;margin-top:6px">Upload the screenshot from your payment app, not a photo of the screen.</div>`}
  ${cash || (P.preview && !P.busy) ? `<div class="two field"><div><label for="p_a">Amount (₹)</label><input id="p_a" class="in" data-p="amount" inputmode="decimal" value="${esc(P.amount)}"></div>${cash ? '' : `<div><label for="p_r">${P.mode === 'cheque' ? 'Cheque number' : P.mode === 'card' ? 'Payment ID' : 'Transaction ID'} <span class="opt">(required)</span></label><input id="p_r" class="in" data-p="txnId" value="${esc(P.txnId)}" autocomplete="off" style="${String(P.txnId).trim() ? '' : 'border:2px solid #C62828;background:#FFF5F5'}"></div>`}</div>
  <div class="field"><label for="p_d">Payment date ${P.date ? '<span class="opt">(read from the screenshot)</span>' : '<span class="opt">(today, change it if the payment was earlier)</span>'}</label><input id="p_d" type="date" class="in" data-p="date" value="${esc(P.date || P.today)}" max="${esc(P.today)}"></div>` : ''}`;
}
function wirePay(P, redraw) {
  document.querySelectorAll('[data-p]').forEach(el => el.addEventListener('input', () => { P[el.dataset.p] = el.value; if (el.dataset.p === 'amount') P.amtOk = true; if (el.dataset.p === 'date') P.time = ''; if (el.dataset.p === 'txnId') { el.style.border = el.value.trim() ? '' : '2px solid #C62828'; el.style.background = el.value.trim() ? '' : '#FFF5F5'; } }));
  document.querySelectorAll('[data-amt]').forEach(b => b.addEventListener('click', () => { P.amount = b.dataset.amt; P.amtOk = true; redraw(); }));
  document.querySelectorAll('[data-pmode]').forEach(b => b.addEventListener('click', () => { P.mode = b.dataset.pmode; redraw(); }));
  const c = document.querySelector('[data-pclear]'); if (c) c.addEventListener('click', () => { P.imageId = ''; P.preview = ''; P.ocrMsg = ''; P.amtAlts = []; P.amtOk = false; redraw(); });
  const onFile = f => readShot(P, f, redraw);
  if (document.getElementById('pz')) wireDrop('pz', onFile); else DROP.cur = onFile;
}
// Reads the words in a picture inside the browser (free, no key). Used when the server has no Vision key.
async function browserRead(dataUrl) {
  if (!window.Tesseract) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; sc.onload = ok; sc.onerror = () => no(new Error('reader not loaded')); document.head.appendChild(sc); });
  // Make the picture easier to read: bigger, grey, dark screens flipped to dark-on-light, contrast stretched.
  const img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('image not readable')); im.src = dataUrl; });
  const k = Math.min(2, 2600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data; let sum = 0, lo = 255, hi = 0;
  for (let i = 0; i < px.length; i += 4) { const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000; px[i] = y; sum += y; if (y < lo) lo = y; if (y > hi) hi = y; }
  const dark = sum / (px.length / 4) < 110, span = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) { let y = (px[i] - lo) * 255 / span; if (dark) y = 255 - y; px[i] = px[i + 1] = px[i + 2] = y; }
  g.putImageData(d, 0, 0);
  const w = await window.Tesseract.createWorker('eng');
  try { await w.setParameters({ tessedit_pageseg_mode: '11' }); const r = await w.recognize(c); return (r && r.data && r.data.text) || ''; } finally { try { await w.terminate(); } catch (e) { /* ignore */ } }
}
async function ocrAny(imageId, dataUrl, kind) {
  const r = await api('POST', 'ocr', { imageId, kind });
  if (r.configured) return r;
  try { const text = await browserRead(dataUrl); if (text.trim()) return await api('POST', 'ocr', { text, kind }); return { configured: true, error: 'No text found in the image. Type the details.' }; } catch (e) { return r; }
}
// Indian mobile number: 10 digits, optional +91 or 0 in front. Returns the 10 digits or ''.
const tenDigitPhone = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return d.length === 10 ? d : ''; };
// Live red flag on a phone box: anything that is not 10 digits (a +91 or 0 in front is fine).
function phoneHintText(v) { const raw = String(v || ''); if (!raw.trim()) return ''; if (tenDigitPhone(raw)) return ''; const d = raw.replace(/\D/g, '').length; return d < 10 ? `Only ${d} digit${d === 1 ? '' : 's'}. A phone number has 10 digits.` : `${d} digits is too many. A phone number has 10 digits (a +91 or 0 in front is fine).`; }
function wirePhoneFlag(inputId, hintId) {
  const el = document.getElementById(inputId), h = document.getElementById(hintId); if (!el || !h) return;
  const upd = () => { const t = phoneHintText(el.value); h.textContent = t; el.style.border = t ? '2px solid #C62828' : ''; el.style.background = t ? '#FFF5F5' : ''; };
  el.addEventListener('input', upd); upd();
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
    const r = await ocrAny(id, P.preview);
    if (!r.configured) P.ocrMsg = 'Automatic reading is off. Type the amount and transaction ID.';
    else if (r.error) P.ocrMsg = r.error;
    else {
      const p = r.parsed;
      if (p.amount) P.amount = String(p.amount);
      { const st = String(p.amount || ''), alt = p.altAmount || (r.source === 'browser' && st.length > 1 && st[0] === '2' && Number(st.slice(1)) > 0 ? Number(st.slice(1)) : 0);
        P.amtAlts = (p.amountUnsure || r.source === 'browser') && p.amount ? [...new Set([p.amount, alt].filter(Boolean))] : []; P.amtOk = false; P.rawText = r.rawText || ''; }
      if (p.date) { P.date = p.date; P.time = p.time || ''; }
      if (p.txnId) P.txnId = p.txnId;
      if (p.payer) P.payer = p.payer; if (p.payee) P.payee = p.payee;
      if (p.mode === 'transfer' && P.mode === 'upi') P.mode = 'transfer';
      P.ocr = p.confidence;
      if (P.onRead) P.onRead(p);
      P.ocrMsg = !p.amount && !p.txnId && P.mode !== 'cash' ? 'We could not find a payment in this image. Please upload the screenshot from your payment app, or type the details yourself.' : !p.txnId && P.mode !== 'cash' ? 'No transaction ID on this screenshot. Without it this cannot be saved. In GPay or PhonePe open the payment details (View details) and screenshot that, or type the ID.' : p.confidence === 'low' ? 'We could only read a little. Please check every field.' : 'We read these details. Please check them.';
    }
  } catch (ex) { P.err = ex.message || 'Could not use that image'; P.imageId = ''; P.preview = ''; }
  P.busy = false; redraw();
}
function payCheck(P) {
  if (!(Number(String(P.amount).replace(/,/g, '')) > 0)) return 'Enter the amount.';
  if (P.amtAlts && P.amtAlts.length && !P.amtOk) return 'Confirm the amount first: tap the right one above.';
    if (P.mode !== 'cash' && !P.imageId) return 'Add the payment screenshot.';
  if (P.mode !== 'cash' && !String(P.txnId).trim()) return (P.mode === 'cheque' ? 'No cheque number. Type it from the photo, or use a photo that shows it.' : P.mode === 'card' ? 'No payment ID. Type it from the receipt, or use a screenshot that shows it.' : 'No transaction ID. Type it from the screenshot, or use a screenshot that shows it.');
  return '';
}
const payBody = P => ({ mode: P.mode, amount: String(P.amount).replace(/,/g, ''), date: (P.date || P.today) + (P.date && P.time ? 'T' + P.time : ''), txnId: P.txnId, payer: P.payer, payee: P.payee, imageId: P.imageId, ocr: P.ocr });

// ---------- Add payment (sales) ----------
function viewAdd() {
  const A = S.add || (S.add = { dueMode: 'next', P: newPay(), orderCode: '', info: null, orderErr: '', seq: '', seqReason: '', needReason: null, err: '', busy: false, done: null });
  if (A.done) {
    const d = A.done;
    return { active: '#/add', html: `<div style="max-width:520px;margin:0 auto"><div class="card" style="text-align:center;padding:32px 20px"><div class="tick">✓</div><h2 style="font-size:20px">Payment ${d.seq} saved</h2><p>${inr(d.amount)} on <b>${esc(d.orderCode)}</b></p>${A.notice ? `<div class="note warn" style="margin:12px 0;text-align:left">${esc(A.notice)}</div>` : ''}${d.needsOwner && !A.notice ? '<div class="note" style="margin:12px 0">The owner will approve this entry.</div>' : ''}<button class="btn p" style="width:100%;margin-top:14px" data-act="addAnother">Add another payment</button></div></div>`, after() { DROP.cur = null; } };
  }
  const P = A.P, i = A.info;
  P.onRead = p => { const m = (p.orderMatches || []); if (!A.orderCode.trim()) { if (m.length === 1) A.orderCode = m[0]; else if (p.orderHint) A.orderCode = p.orderHint; } if (p.phone && !A.phone) A.phone = p.phone; A.info = null; A.orderErr = ''; };
  const opts = i ? Array.from({ length: Math.max(8, i.nextPayment + 3) }, (_, k) => k + 1).map(n => `<option value="${n}" ${String(A.seq || i.nextPayment) === String(n) ? 'selected' : ''}>Payment ${n}${n === i.nextPayment ? ' (next)' : ''}</option>`).join('') : '';
  return { active: '#/add', html: `<div style="max-width:680px;margin:0 auto"><div class="head" style="margin-bottom:12px"><div><h1 style="font-size:24px">Add payment</h1><div class="muted" style="font-size:13px;margin-top:4px">For a later instalment on an order that already exists. New customer? Use New order.</div></div></div>
  <form id="af" novalidate><div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:4px"><span class="stepn">1</span> This payment</h2><div class="muted" style="font-size:13px;margin-bottom:12px">Drop the screenshot first. We read the amount, transaction ID, date and any order ID or phone number in the remark.</div>${payFields(P)}</div>
    <div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:12px"><span class="stepn">2</span> Which order?</h2><div class="two field"><div><label for="f_ph">Customer phone number</label><input id="f_ph" class="in" inputmode="tel" placeholder="10-digit mobile number" value="${esc(A.phone || '')}" autocomplete="off"><div id="phh" class="err" style="font-size:13px;margin-top:4px"></div></div><div><label for="f_o">Order ID</label><input id="f_o" class="in" value="${esc(A.orderCode)}" autocapitalize="characters" autocomplete="off"></div></div>
  <div id="ohint" class="${A.orderErr ? 'err' : 'ok'}" style="min-height:20px;margin:-6px 0 8px">${A.orderErr ? esc(A.orderErr) : i ? `${esc(i.customer)} · order total ${inr(i.total)}${i.item ? ' · ' + esc(i.item) + (i.units ? ' × ' + esc(String(i.units)) : '') : ''}` : ''}</div>${(A.byPhone || []).length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${A.byPhone.map(o => `<button type="button" class="btn s" data-pick="${esc(o.code)}">${esc(o.code)} · ${esc(o.customer)}</button>`).join('')}</div>` : A.phoneTried ? '<div class="muted" style="font-size:13px;margin-bottom:8px">No open orders for that number.</div>' : ''}
  ${i && !A.orderErr ? `<div class="field" style="margin:8px 0 0"><label for="f_s">Which payment is this?</label><select id="f_s" class="in">${opts}</select></div>` : ''}
  ${A.needReason ? `<div class="field" style="margin:12px 0 0"><div class="note warn" style="margin-bottom:8px">This looks like payment ${A.needReason}, but you picked ${esc(A.seq)}. Write why, then save again.</div><input id="f_sr" class="in" placeholder="Reason" value="${esc(A.seqReason)}"></div>` : ''}</div>
  ${i && !A.orderErr && !i.hasPlan ? `<div id="dueWrap" style="${(i.outstanding - (Number(String(P.amount).replace(/,/g, '')) || 0)) > 0.005 || !P.amount ? '' : 'display:none'}">${dueCard(A, 3, 'When will the customer pay the rest?', 'Only needed while a balance remains. If a plan does not match what is due, a manager or the owner approves it.')}</div>` : ''}${i && !A.orderErr ? `<div class="note" id="clearNote" style="margin-bottom:12px;${P.amount && i.outstanding - (Number(String(P.amount).replace(/,/g, '')) || 0) <= 0.005 ? '' : 'display:none'}">This payment clears the balance. The order closes by itself once it is validated.</div>` : ''}<div class="err" id="aerr" style="min-height:18px;margin-bottom:6px">${esc(A.err || P.err || '')}</div><button class="btn p" type="submit" style="width:100%;min-height:54px;font-size:16px" ${A.busy || P.busy ? 'disabled' : ''}>${P.mode === 'cash' ? 'Submit for approval' : 'Submit for validation'}</button></form></div>`,
    after() {
      const redraw = () => render();
      wirePay(P, redraw);
      wirePhoneFlag('f_ph', 'phh');
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
      const numA = v => Number(String(v).replace(/,/g, '')) || 0;
      if (document.getElementById('ond') || document.querySelector('[data-dmode]')) { const lf = wireDue(A, redraw, () => { const o = (A.info ? A.info.outstanding : 0) - numA(P.amount), sum = A.plan.reduce((t, r) => t + numA(r.amount), 0); return Math.abs(sum - o) < 0.005 ? 'Matches what is due: ' + inr(o) : 'Adds up to ' + inr(sum) + ' but ' + inr(Math.max(o, 0)) + ' is due. A manager or the owner will approve this.'; }); const am = document.getElementById('p_a'); const dw = document.getElementById('dueWrap'); const cn = document.getElementById('clearNote'); const tog = () => { if (cn) cn.style.display = (P.amount && A.info.outstanding - numA(P.amount) <= 0.005) ? '' : 'none'; if (dw) dw.style.display = (!P.amount || A.info.outstanding - numA(P.amount) > 0.005) ? '' : 'none'; }; if (am) am.addEventListener('input', () => { lf(); tog(); }); }
      const fr = document.getElementById('f_sr'); if (fr) fr.addEventListener('input', () => { A.seqReason = fr.value; });
      document.getElementById('af').addEventListener('submit', async e => {
        e.preventDefault(); A.err = ''; P.err = '';
        if (!A.orderCode.trim() || !A.info) A.err = 'Enter a valid order ID.'; else A.err = payCheck(P);
        if (A.err) { document.getElementById('aerr').textContent = A.err; return; }
        let planBody = {};
        if (!A.info.hasPlan && A.info.outstanding - numA(P.amount) > 0.005) {
          if (A.dueMode === 'skip') planBody = { skipDue: true };
          else if (A.dueMode === 'next') { if (!A.nextDue) A.err = 'Pick the next payment date, or choose Skip.'; else planBody = { nextDue: A.nextDue }; }
          else { const rows = A.plan.filter(r => r.date || r.amount); if (!rows.length) A.err = 'Upload the plan or type the dates and amounts, or choose another option.'; else if (rows.some(r => !r.date || !(numA(r.amount) > 0))) A.err = 'Each instalment needs a due date and an amount.'; else planBody = { schedule: rows.map(r => ({ date: r.date, amount: String(numA(r.amount)) })), planImageId: A.planImg || '' }; }
          if (A.err) { document.getElementById('aerr').textContent = A.err; return; }
        }
        A.busy = true; render();
        try {
          const r = await api('POST', 'payments', { ...payBody(P), orderCode: A.orderCode.trim(), seq: A.seq || A.info.nextPayment, seqReason: A.seqReason, ...planBody });
          A.notice = r.notice; A.done = r.payment; A.P = newPay(); A.info = null; A.orderCode = ''; A.seq = ''; A.seqReason = ''; A.needReason = null; A.nextDue = ''; A.dueMode = 'next'; A.plan = [{ date: '', amount: '' }]; A.planImg = ''; A.planMsg = '';
        } catch (ex) { if (ex.data && ex.data.needReason) { A.needReason = ex.data.expected; A.err = ''; } else A.err = ex.message; }
        A.busy = false; render();
      });
    } };
}

// ---------- "when will the customer pay the rest" picker (New order and Add payment) ----------
// D holds: dueMode ('plan' | 'next' | 'skip'), nextDue, plan [{date, amount}], planImg, planMsg, planBusy
function dueCard(D, step, title, hint) {
  D.dueMode = D.dueMode || 'plan'; D.plan = D.plan && D.plan.length ? D.plan : [{ date: '', amount: '' }]; D.nextDue = D.nextDue || '';
  const rows = D.plan.map((r, i) => `<div class="two field" style="align-items:end"><div><label>Due date</label><input type="date" class="in" data-pr="${i}:date" value="${esc(r.date)}"></div><div style="display:flex;gap:8px;align-items:end"><div style="flex:1"><label>Amount (₹)</label><input class="in" inputmode="decimal" data-pr="${i}:amount" value="${esc(r.amount)}"></div><button type="button" class="btn s" data-prm="${i}" aria-label="Remove this instalment">✕</button></div></div>`).join('');
  const seg = (m, t, tip) => `<button type="button" class="${D.dueMode === m ? 'on' : ''}" data-dmode="${m}" title="${tip}">${t}</button>`;
  return `<div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:6px"><span class="stepn">${step}</span> ${esc(title)}</h2><div class="muted" style="font-size:13px;margin-bottom:10px">${esc(hint)}</div>
  <div class="seg" role="group" aria-label="Payment plan" style="margin-bottom:12px">${seg('plan', 'I have a complete payment plan', 'Upload a picture of the plan, or type every date and amount')}${seg('next', 'I only know the next payment date', 'Just choose the date of the next payment')}${seg('skip', 'Skip', 'No reminder for this order')}</div>
  ${D.dueMode === 'skip' ? '' : D.dueMode === 'plan' ? `<div class="muted" style="font-size:13px;margin-bottom:8px">Upload a picture of the quotation or Excel with the dates.</div><label class="btn" style="width:100%;text-align:center;cursor:pointer">${D.planBusy ? 'Reading the picture…' : D.planImg ? 'Choose a different picture' : 'Upload picture'}<input type="file" id="plf" accept="image/*" hidden></label>${D.planMsg ? `<div class="note" style="margin-top:10px">${esc(D.planMsg)}</div>` : ''}${D.planImg && !D.planBusy ? `<div style="margin-top:12px">${rows}<button type="button" class="btn s" data-padd>+ Add instalment</button><div class="muted" id="pleft" style="font-size:13px;margin-top:8px"></div></div>` : ''}` : `<div class="muted" style="font-size:13px;margin-bottom:8px">Choose the date of the next payment.</div><div class="field"><label for="ond">Next payment due</label><input id="ond" type="date" class="in" data-d="nextDue" value="${esc(D.nextDue)}"></div>`}</div>`;
}
function wireDue(D, redraw, leftText) {
  const left = () => { const el = document.getElementById('pleft'); if (el) el.textContent = leftText(); };
  left();
  document.querySelectorAll('[data-dmode]').forEach(b => b.addEventListener('click', () => { D.dueMode = b.dataset.dmode; redraw(); }));
  document.querySelectorAll('[data-pr]').forEach(el => el.addEventListener('input', () => { const [i, k] = el.dataset.pr.split(':'); D.plan[+i][k] = el.value; left(); }));
  document.querySelectorAll('[data-prm]').forEach(b => b.addEventListener('click', () => { D.plan.splice(+b.dataset.prm, 1); redraw(); }));
  const pa = document.querySelector('[data-padd]'); if (pa) pa.addEventListener('click', () => { D.plan.push({ date: '', amount: '' }); redraw(); });
  document.querySelectorAll('[data-d]').forEach(el => el.addEventListener('input', () => { D[el.dataset.d] = el.value; }));
  const plf = document.getElementById('plf');
  if (plf) plf.addEventListener('change', async () => {
    const file = plf.files && plf.files[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image (a screenshot or photo).', true); return; }
    D.planBusy = true; D.planMsg = ''; redraw();
    try {
      const url = await downscale(file);
      const { id } = await api('POST', 'images', { dataUrl: url }); D.planImg = id;
      const r = await ocrAny(id, url, 'plan');
      if (!r.configured) D.planMsg = 'Automatic reading is off. Type each date and amount below.';
      else if (r.error) D.planMsg = r.error;
      else if (r.parsed && r.parsed.schedule && r.parsed.schedule.length) { D.plan = r.parsed.schedule.map(x => ({ date: x.date, amount: String(x.amount) })); D.planMsg = 'We read these rows. Please check each date and amount.'; }
      else D.planMsg = 'We could not find dates and amounts in that image. Type them below.';
    } catch (ex) { D.planMsg = ex.message || 'Could not use that image'; }
    D.planBusy = false; redraw();
  });
  return left;
}

// ---------- New order (sales) ----------
async function viewNewOrder() {
  const { settings } = await api('GET', 'settings');
  const N = S.newOrder || (S.newOrder = { code: '', phone: '', customer: '', item: '', units: '', total: '', extra: {}, P: newPay(), err: '', busy: false, done: null, dueMode: 'plan', nextDue: '', plan: [{ date: '', amount: '' }], planImg: '', planMsg: '', planBusy: false });
  if (N.done) return { active: '#/new-order', html: `<div style="max-width:520px;margin:0 auto"><div class="card" style="text-align:center;padding:32px 20px"><div class="tick">✓</div><h2 style="font-size:20px">Sent for approval</h2><p><b>${esc(N.done.code)}</b> · ${esc(N.done.customer)}</p><p class="muted">A manager or the owner will approve it. You will see a note in your Inbox if anything changes.</p><button class="btn p" style="width:100%;margin-top:14px" data-act="anotherOrder">Create another order</button></div></div>`, after() { DROP.cur = null; } };
  const P = N.P, auto = settings.orderIdMode === 'auto';
  P.onRead = p => { const got = []; if (p.orderHint && !auto && !String(N.code || '').trim()) { N.code = p.orderHint; got.push('order ID'); } if (p.phone && !String(N.phone || '').trim()) { N.phone = p.phone; got.push('phone number'); } if (p.payer && !String(N.customer || '').trim()) { N.customer = p.payer; got.push('name'); } N.fromShot = (got.length ? 'Filled from the screenshot: ' + got.join(', ') + '. Please check. ' : '') + ((p.orderMatches || []).length ? 'This screenshot mentions the open order ' + p.orderMatches.join(', ') + '. For a later payment on it, use Add payment.' : ''); };
  N.dueMode = N.dueMode || 'plan'; N.plan = N.plan && N.plan.length ? N.plan : [{ date: '', amount: '' }]; N.nextDue = N.nextDue || '';
  const planCard = dueCard(N, 3, 'When will the customer pay the rest?', 'Pick one. We use it to remind you what to collect next.');
  const extras = (settings.customerFields || []).map(f => `<div class="field"><label for="x_${f.key}">${esc(f.label)}</label><input id="x_${f.key}" class="in" data-x="${f.key}" value="${esc(N.extra[f.key] || '')}"></div>`).join('');
  return { active: '#/new-order', html: `<div style="max-width:680px;margin:0 auto"><div class="head" style="margin-bottom:12px"><div><h1 style="font-size:24px">New order</h1><div class="muted" style="font-size:13px;margin-top:4px">Start with the first advance screenshot. We fill in what we can read; you add the rest.</div></div></div>
  <form id="nf" novalidate>  <div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:4px"><span class="stepn">1</span> Payment screenshot</h2><div class="muted" style="font-size:13px;margin-bottom:12px">Drop it first. We read the amount, transaction ID, date and, when shown, the name and phone number.</div>${payFields(P)}</div>
<div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:4px"><span class="stepn">2</span> Customer and order</h2>${N.fromShot ? `<div class="muted" style="font-size:13px;margin-bottom:10px">${esc(N.fromShot)}</div>` : '<div class="muted" style="font-size:13px;margin-bottom:10px">Fill in what the screenshot did not show.</div>'}<div class="two field"><div><label for="oph">Customer phone number</label><input id="oph" class="in" data-n="phone" inputmode="tel" placeholder="10-digit mobile number" value="${esc(N.phone)}" autocomplete="off"><div id="phh" class="err" style="font-size:13px;margin-top:4px"></div></div><div><label for="ocu">Client name</label><input id="ocu" class="in" data-n="customer" value="${esc(N.customer)}"></div></div><div style="margin:-6px 0 12px">${(N.found || []).length && !N.skipFound ? `<div class="note warn" ><b>This customer already has open orders.</b> Pick one to add a payment to it, or continue to create a new order.<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${N.found.map(o => `<button type="button" class="btn s p" data-existing="${esc(o.code)}">${esc(o.code)} · ${esc(o.customer)}</button>`).join('')}<button type="button" class="btn s" data-newone>It's a new order</button></div></div>` : ''}</div><div class="two field">${auto ? '<div><label>Order ID</label><div class="muted" style="padding:12px 0">Created for you</div></div>' : `<div><label for="oc">Order ID</label><input id="oc" class="in" data-n="code" value="${esc(N.code)}" autocapitalize="characters" autocomplete="off"></div>`}<div><label for="ot">Total order value (₹)</label><input id="ot" class="in" data-n="total" inputmode="decimal" value="${esc(N.total)}"></div></div><div class="two field"><div><label for="oit">Product or service <span class="opt">(shown on the invoice)</span></label><input id="oit" class="in" data-n="item" value="${esc(N.item)}" placeholder="e.g. Wedding album"></div><div><label for="oun">Number of units</label><input id="oun" class="in" data-n="units" inputmode="decimal" value="${esc(N.units)}" placeholder="e.g. 2"></div></div>
  ${extras}</div>
  ${planCard}<div class="err" id="nerr" style="min-height:18px;margin-bottom:6px">${esc(N.err || P.err || '')}</div><button class="btn p" type="submit" style="width:100%;min-height:54px;font-size:16px" ${N.busy || P.busy ? 'disabled' : ''}>${P.mode === 'cash' ? 'Submit for approval' : 'Submit for validation'}</button></form></div>`,
    after() {
      wirePay(P, () => render());
      wirePhoneFlag('oph', 'phh');
      const num = v => Number(String(v).replace(/,/g, '')) || 0;
      const left = wireDue(N, () => render(), () => { const l = num(N.total) - N.plan.reduce((a, r) => a + num(r.amount), 0); return num(N.total) > 0 ? (l >= 0 ? 'Left to schedule: ' + inr(l) : 'The instalments add up to ' + inr(-l) + ' more than the order total.') : 'Enter the order total to see how much is left to schedule.'; });
      const totEl = document.querySelector('[data-n="total"]'); if (totEl) totEl.addEventListener('input', left);
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
        if (!tenDigitPhone(N.phone)) N.err = 'Enter the customer’s 10-digit phone number (a +91 or 0 in front is fine).'; else if (!auto && !N.code.trim()) N.err = 'Enter the order ID.'; else if (!N.customer.trim()) N.err = 'Enter the client name.'; else if (!(Number(String(N.total).replace(/,/g, '')) > 0)) N.err = 'Enter the total order value.';
        else N.err = payCheck(P);
        const rest = num(N.total) - num(P.amount); let planBody = {};
        if (!N.err && rest > 0.005) {
          if (N.dueMode === 'skip') planBody = { skipDue: true };
          else if (N.dueMode === 'next') { if (!N.nextDue) N.err = 'Pick the next payment date, or choose Skip.'; else planBody = { nextDue: N.nextDue }; }
          else {
            const rows = N.plan.filter(r => r.date || r.amount);
            if (!rows.length) N.err = 'Add the payment plan (date and amount for each instalment), or choose Pick next date or Skip.';
            else if (rows.some(r => !r.date || !(num(r.amount) > 0))) N.err = 'Each instalment needs a due date and an amount.';
            else planBody = { schedule: rows.map(r => ({ date: r.date, amount: String(num(r.amount)) })), planImageId: N.planImg || '' };
          }
        }
        if (N.err) { document.getElementById('nerr').textContent = N.err; return; }
        N.busy = true; render();
        const send = confirmSame => api('POST', 'orders', { code: N.code.trim(), phone: N.phone, confirmSamePhone: confirmSame, customer: N.customer, item: N.item, units: N.units, total: String(N.total).replace(/,/g, ''), customerExtra: N.extra, firstPayment: payBody(P), ...planBody });
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


// ---------- Home (sales): what is collected, what is outstanding, who to chase ----------
async function viewHome() {
  const { orders } = await api('GET', 'orders/mine');
  const open = orders.filter(o => o.status === 'open');
  const waiting = orders.filter(o => o.status === 'pending').length, back = orders.filter(o => o.status === 'rejected').length;
  const r2 = n => Math.round(n * 100) / 100;
  const coll = r2(open.reduce((a, o) => a + o.collected, 0)), out = r2(open.reduce((a, o) => a + o.outstanding, 0));
  const due = open.filter(o => o.due).sort((a, b) => a.due.date.localeCompare(b.due.date));
  const nodue = open.filter(o => !o.due && o.outstanding > 0);
  const dfmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const row = (o, right) => `<div class="tr" style="min-width:320px"><div class="c1"><b>${esc(o.code)}</b><div class="muted" style="font-size:13px">${esc(o.customer)}</div></div>${right}</div>`;
  const t0 = new Date(Date.now() + 19800000).toISOString().slice(0, 10), t1 = new Date(Date.now() + 19800000 + 86400000).toISOString().slice(0, 10), t7 = new Date(Date.now() + 19800000 + 7 * 86400000).toISOString().slice(0, 10);
  const bk = o => o.due.date < t0 ? 'o' : o.due.date === t0 ? 't' : o.due.date === t1 ? 'm' : o.due.date <= t7 ? 'w' : '';
  const chipH = (k, t, cls) => { const l = due.filter(o => bk(o) === k); return `<span class="badge ${cls}">${t} ${l.length}${l.length ? ' · ' + inr(r2(l.reduce((a, o) => a + o.due.amount, 0))) : ''}</span>`; };
  const dueStrip = `<div class="card" style="margin-bottom:12px;padding:12px 16px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Payments due</b>${chipH('o', 'Overdue', 'bad')}${chipH('t', 'Today', 'warn')}${chipH('m', 'Tomorrow', '')}${chipH('w', 'Next 7 days', '')}</div></div>`;
  const dueRows = due.map(o => row(o, `<div class="c r">${o.due.overdue ? '<span class="badge bad">Overdue</span> ' : ''}${esc(dfmt(o.due.date))}</div><div class="c r"><b>${inr(o.due.amount)}</b></div>`)).join('');
  const noRows = nodue.map(o => row(o, `<div class="c r muted">No due date</div><div class="c r"><b>${inr(o.outstanding)}</b></div>`)).join('');
  return { active: '#/home', html: `<div class="head"><div><h1>Home</h1><div class="muted">Your orders: what is collected, what is outstanding and who to chase next.</div></div></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px"><a class="btn p" href="#/new-order" style="flex:1 1 200px;text-align:center">New order<div style="font-size:12px;font-weight:400;opacity:.9">New customer booking</div></a><a class="btn p" href="#/add" style="flex:1 1 200px;text-align:center">Add payment<div style="font-size:12px;font-weight:400;opacity:.9">Later instalment on an existing order</div></a></div>
  <div class="row" style="margin-bottom:16px"><div class="card kpi"><div class="l">Collected</div><div class="v">${inr(coll)}</div><div class="muted">on your approved orders, including payments still waiting for validation</div></div><div class="card kpi"><div class="l">Outstanding</div><div class="v">${inr(out)}</div><div class="muted">across ${open.length} approved order${open.length === 1 ? '' : 's'}</div></div></div>
  ${waiting || back ? `<div class="note ${back ? 'warn' : ''}" style="margin-bottom:16px">${waiting ? waiting + ' order' + (waiting === 1 ? ' is' : 's are') + ' waiting for approval. ' : ''}${back ? back + ' sent back to you: <a href="#/mine">fix and resend</a>.' : ''}</div>` : ''}
  ${dueStrip}<div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:6px">Collect next</h2><div class="muted" style="font-size:13px;margin-bottom:8px">Soonest due first. Overdue ones are marked.</div>${dueRows ? `<div class="tbl">${dueRows}</div>` : '<p class="muted">Nothing due yet. Add a payment plan or next due date when you create an order.</p>'}</div>
  ${noRows ? `<div class="card"><h2 style="margin-bottom:6px">No due date set</h2><div class="tbl">${noRows}</div></div>` : ''}`, };
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
  const reqRow = r => `<div style="border-top:1px solid #EEF2F6;padding:14px 0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px"><div><b>${esc(r.orderCode)}</b> · ${r.kind === 'close_offline' ? `close with ${inr(r.amount)} received offline` : r.kind === 'change_plan' ? `payment plan: ${(r.schedule || []).map(x => fdate(x.date) + ' ' + inr(x.amount)).join(', ')}` : `change total ${inr(r.oldTotal)} to ${inr(r.newTotal)}`}<div class="muted" style="font-size:13px">${esc(r.by)}: ${esc(r.comment)}</div></div>${owner || r.kind === 'change_plan' ? `<div style="display:flex;gap:6px"><button class="btn s p" data-act="reqApprove" data-id="${r.id}">Approve</button><button class="btn s d" data-act="reqReject" data-id="${r.id}">Decline</button></div>` : '<span class="muted">Waiting for the owner</span>'}</div>`;
  S.badge = flags.length + waitOwner.length + toApprove.length + requests.length;
  const sec = (t, n, sub, body, w) => `<div class="card a" style="flex-basis:${w || 480}px"><h2>${t} <span class="muted" style="font-weight:500">· ${n}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">${sub}</div>${body || '<p class="muted">Nothing here.</p>'}</div>`;
  return { active: '#/review', html: `<div class="head"><div><h1>Needs your review</h1><div class="muted">New orders, owner approvals and anything unusual.</div></div></div>
  ${toApprove.length ? `<div class="card a" style="margin-bottom:16px"><h2>Orders to approve <span class="muted" style="font-weight:500">· ${toApprove.length}</span></h2><div class="muted" style="font-size:13px;margin-bottom:6px">Created by the sales team. Approve, change and approve, or send back.</div>${toApprove.map(orderRow).join('')}</div>` : ''}
  <div class="grid2">${sec('Waiting for the owner', waitOwner.length, owner ? 'Cash, entries over the limit and entries by managers.' : 'Cash, entries over the limit and entries by managers. Only the owner can approve these.', waitOwner.map(line).join(''))}
  ${sec('Changes to outstanding', requests.length, 'Requests to close an order, change its total, or approve a payment plan that does not match.', requests.map(reqRow).join(''))}</div>
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
  const { order: o, payments, invoice, invoiceMode } = await api('GET', 'orders/' + encodeURIComponent(code));
  const owner = S.user.role === 'owner';
  const pct = v => o.total ? Math.min(100, Math.round(v * 100 / o.total)) : 0;
  const rows = payments.map(p => `<div class="tr" style="min-width:820px"><div class="c" style="flex:.6">${p.seq ? '#' + p.seq : ''}</div><div class="c" style="flex:1.2">${esc(fdate(p.date))}</div><div class="c" style="flex:.8">${esc(MODE[p.mode] || p.mode)}</div><div class="c r" style="flex:1"><b>${inr(p.amount)}</b></div><div class="c1">${statusBadge(p)}<div class="muted" style="font-size:12px">${esc(p.validationNote || '')}</div>${p.account ? `<div class="muted" style="font-size:12px"><b>${esc(p.account)}</b></div>` : ''}${p.seqReason ? `<div class="muted" style="font-size:12px">Out of order: ${esc(p.seqReason)}</div>` : ''}</div><div class="c" style="flex:1.2">${p.imageId ? `<a href="${imgUrl(p.imageId)}" target="_blank" rel="noopener" style="color:var(--acc);font-weight:600">Screenshot</a>` : ''}${invoiceMode === 'payment' && invoice && p.id && p.status !== 'rejected' ? `<div><a href="/api/invoices/${encodeURIComponent(o.code)}?p=${encodeURIComponent(p.id)}&t=${encodeURIComponent(S.tok)}" target="_blank" rel="noopener" style="color:var(--acc);font-weight:600">Invoice</a></div>` : ''}</div><div class="c1" style="display:flex;gap:6px;flex-wrap:wrap">${payActions(p)}</div></div>`).join('');
  const closed = o.status === 'closed';
  const vnote = o.validationNote ? `<div class="badge ${o.validation === 'unable' ? 'warn' : o.validation === 'validated' ? 'good' : ''}" style="margin-top:6px">${esc(o.validationNote)}</div>` : '';
  const mods = (o.modifications || []).map(m => `<div class="muted" style="font-size:13px">${esc(m.field)}: ${esc(m.from)} → ${esc(m.to)} by ${esc(m.by)}${m.comment ? ' (' + esc(m.comment) + ')' : ''}</div>`).join('');
  return { active: '#/orders', html: `${backBtn('#/orders')}<div class="head"><div><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h1>${esc(o.code)}</h1>${orderBadge(o)}</div><div class="muted">${esc(o.customer)}</div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">${invoice && invoiceMode !== 'payment' ? `<a class="btn" target="_blank" rel="noopener" href="/api/invoices/${encodeURIComponent(o.code)}?t=${encodeURIComponent(S.tok)}">Invoice</a>` : ''}${o.status === 'open' ? '<button class="btn" data-act="adjust" data-code="' + esc(o.code) + '">Adjust outstanding</button>' : ''}${closed ? `<button class="btn" data-act="reopen" data-code="${esc(o.code)}">Reopen</button>` : `<button class="btn p" data-act="closeOrder" data-code="${esc(o.code)}">Close order</button>`}</div></div>
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
  <div class="card" style="margin-top:16px"><h2>Clear old files</h2><p class="muted" style="margin:6px 0 12px">Frees storage by removing invoice files and payment screenshots of <b>closed orders</b>. Order records and totals stay, so your revenue history is kept. You must download the report first.</p><button class="btn d" data-act="clearData">Clear invoice files and screenshots</button></div>
  <div class="card" id="fresh" style="margin-top:16px"><h2>Start fresh for real use</h2><p class="muted" style="margin:6px 0 12px">Removes every order, payment, request, file and login, including the demo ones. Your settings stay. The next person to open the app creates the real owner account. <b>Step 1:</b> download a backup of everything. Keep it as proof of the testing. <b>Step 2:</b> type START FRESH and confirm.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn" data-act="backupAll">1. Download backup</button><input id="sf_t" class="in" style="width:170px" placeholder="Type START FRESH" aria-label="Type START FRESH to confirm" autocomplete="off"><button class="btn d" data-act="startFresh">2. Start fresh</button></div></div>`,
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
function styleNote(st) {
  if (!st) return '';
  const bits = [st.title ? 'Heading "' + esc(st.title) + '"' : '', st.billTo ? 'customer label "' + esc(st.billTo) + '"' : '', st.columns && st.columns.length ? 'columns ' + st.columns.map(esc).join(', ') : '', st.footer && st.footer.length ? st.footer.length + ' footer line' + (st.footer.length === 1 ? '' : 's') : ''].filter(Boolean);
  return '<b>We read your sample.</b> ' + (bits.length ? 'Invoices will follow its heading, labels and footer: ' + bits.join('; ') + '.' : 'We could not find much to copy, so invoices use the standard layout.') + (st.missing && st.missing.length ? ' It also shows things we do not collect yet: ' + st.missing.map(esc).join(', ') + '. Tell us if you need them.' : '');
}
const GSTS = ['', 'GST registered (regular)', 'GST composition scheme', 'Not registered'];
const STORES = [['app', 'Payment Control only'], ['app_sheet', 'Payment Control + Google Sheet'], ['app_api', 'Payment Control + my own system (API)'], ['all', 'All three']];
const BANKS = ["State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Punjab National Bank", "Bank of Baroda", "Canara Bank", "Union Bank of India", "Bank of India", "Indian Bank", "Central Bank of India", "Indian Overseas Bank", "UCO Bank", "Bank of Maharashtra", "Punjab & Sind Bank", "IDBI Bank", "IndusInd Bank", "Yes Bank", "IDFC FIRST Bank", "Federal Bank", "South Indian Bank", "Karur Vysya Bank", "Karnataka Bank", "City Union Bank", "Tamilnad Mercantile Bank", "RBL Bank", "Bandhan Bank", "DCB Bank", "CSB Bank", "Jammu & Kashmir Bank", "Dhanlaxmi Bank", "Nainital Bank", "AU Small Finance Bank", "Equitas Small Finance Bank", "Ujjivan Small Finance Bank", "Jana Small Finance Bank", "Utkarsh Small Finance Bank", "Suryoday Small Finance Bank", "ESAF Small Finance Bank", "Capital Small Finance Bank", "Fincare Small Finance Bank", "India Post Payments Bank", "Paytm Payments Bank", "Airtel Payments Bank", "Fino Payments Bank", "Saraswat Co-operative Bank", "Cosmos Co-operative Bank", "SVC Co-operative Bank", "HSBC India", "Standard Chartered Bank", "Citibank", "DBS Bank India", "Deutsche Bank"];
function accRow(x, i) {
  x = x || {};
  return `<div class="card" data-acc style="padding:12px;margin-bottom:8px"><input type="hidden" data-f="id" value="${esc(x.id || '')}"><div class="two field"><div><label>Account name<span style="color:#C62828" title="Required"> *</span> <span class="opt">(exactly as printed on the bank statement)</span></label><input class="in" data-f="name" value="${esc(x.name || '')}" placeholder="Your name or business name, as on the statement"></div><div><label>Bank<span style="color:#C62828" title="Required"> *</span></label><input class="in" data-f="bank" list="banklist" value="${esc(x.bank || '')}" placeholder="Pick from the list or type" autocomplete="off"></div></div><div class="two field"><div><label>Last 4 digits of the account number<span style="color:#C62828" title="Required"> *</span></label><input class="in" data-f="last4" inputmode="numeric" maxlength="4" value="${esc(x.last4 || '')}" placeholder="4321"></div><div><label>UPI ID(s) for this account <span class="opt">(comma separated)</span></label><input class="in" data-f="upi" value="${esc((x.upi || []).join(', '))}" placeholder="shop@okhdfcbank"></div></div><button class="btn" type="button" data-rmacc>Remove</button></div>`;
}
let API_CAT = [];
function apiFieldTicks(cat, sel, attr) { return `<div style="display:flex;flex-wrap:wrap;gap:4px 18px;margin-bottom:10px">${cat.map(c => `<label style="font-weight:400"><input type="checkbox" ${attr}="${esc(c.k)}" ${sel.includes(c.k) ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">${esc(c.label)}</label>`).join('')}</div>`; }
function sysRow(x) {
  x = x || {};
  return `<div class="card" data-sys style="padding:12px;margin-bottom:8px"><input type="hidden" data-f="id" value="${esc(x.id || '')}"><div class="field"><label>Name of this system</label><input class="in" data-f="name" value="${esc(x.name || '')}" placeholder="e.g. Accounts software"></div><div class="field"><label>Endpoint URL</label><input class="in" data-f="url" placeholder="https://..." value="${esc(x.url || '')}"></div><div class="field"><label>Secret key ${x.keySet ? '<span class="opt">(saved, leave blank to keep it)</span>' : ''}</label><input type="password" class="in" autocomplete="off" data-f="key"></div><div style="font-weight:600;margin:4px 0">What this system receives</div>${apiFieldTicks(API_CAT, x.fields || ['payment_id', 'order_id', 'amount', 'mode', 'date', 'reference', 'status'], 'data-sf')}<button class="btn" type="button" data-rmsys>Remove</button></div>`;
}
async function viewSettings() {
  const { settings: s } = await api('GET', 'settings'); API_CAT = s.connectors.apiCatalog || [];
  const a = s.connectors.api, b = s.business, lm = s.limits;
  const sel = (id, list, cur, blank) => `<select id="${id}" class="in">${blank ? '<option value="">Choose…</option>' : ''}${list.map(x => { const v = Array.isArray(x) ? x[0] : x, t = Array.isArray(x) ? x[1] : x; return `<option value="${esc(v)}" ${v === cur || (cur && String(cur).length >= 8 && String(v).startsWith(cur)) ? 'selected' : ''}>${esc(t || 'Choose…')}</option>`; }).join('')}</select>`;
  return { active: '#/settings', html: `<div class="head"><div><h1>Settings</h1><div class="muted">Set up your business once. Change anything later.</div></div></div>
  <form id="sf2" class="grid2"><div class="card a">
  <h2 style="margin-bottom:4px">Your business</h2><div class="muted" style="font-size:13px;margin-bottom:10px"><span style="color:#C62828">*</span> means required before you can start. Everything else is optional.</div>
  <div class="two field"><div><label for="bz">Business name<span style="color:#C62828" title="Required"> *</span></label><input id="bz" class="in" value="${esc(b.name || s.businessName)}"></div><div><label for="bk">Kind of business</label>${sel('bk', KINDS, b.kind, 1)}</div></div>
  <div class="two field"><div><label for="bi">Industry</label>${sel('bi', INDUSTRIES, b.industry, 1)}</div><div><label for="bg">GST<span style="color:#C62828" title="Required"> *</span></label>${sel('bg', GSTS, b.gstRate)}</div></div>
  <div class="field"><label for="bt">GST or tax number<span style="color:#C62828" title="Required"> *</span></label><input id="bt" class="in" value="${esc(b.taxId)}" ${b.taxNA ? 'disabled' : ''}><label style="font-weight:400;margin-top:8px"><input type="checkbox" id="bn" ${b.taxNA ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">GST or tax is not applicable to my business</label></div>
  <div class="field" id="invq" style="${b.taxNA ? '' : 'display:none'}"><label>Do you still want to create invoices?<span style="color:#C62828" title="Required"> *</span></label><div class="seg" style="margin-top:6px"><button type="button" id="inv_y" class="${b.invoiceAns === 'yes' ? 'on' : ''}">Yes, create invoices</button><button type="button" id="inv_n" class="${b.invoiceAns === 'no' ? 'on' : ''}">No invoices</button></div></div>
  <div class="field" id="imq" style="${b.taxNA && b.invoiceAns !== 'yes' ? 'display:none' : ''}"><label>How should invoices be created?<span style="color:#C62828" title="Required"> *</span></label><div class="seg" style="margin-top:6px"><button type="button" id="im_o" class="${b.invoiceMode === 'order' ? 'on' : ''}">One invoice per order</button><button type="button" id="im_p" class="${b.invoiceMode === 'payment' ? 'on' : ''}">One invoice per payment / transaction</button></div></div>
  <div class="field"><label for="ba">Business address<span style="color:#C62828" title="Required"> *</span> <span class="opt">(printed on invoices)</span></label><input id="ba" class="in" value="${esc(b.address)}"></div><div class="field"><label for="bc">Phone and email on the invoice</label><input id="bc" class="in" value="${esc(b.contact)}"></div>
  <div class="field"><label>Sample invoice <span class="opt">(optional)</span></label>${dropZone('iz', s.invoiceSampleId ? 'Sample added. Drop a new one to replace it' : 'Drop a sample invoice here (PDF or picture)', 1, 'image/*,application/pdf')}<div class="muted" style="font-size:13px;margin-top:4px">Invoices follow this style. If it shows details we do not collect, we will ask you.</div></div>
  <div id="sty" class="muted" style="font-size:13px;margin:-4px 0 12px">${styleNote(s.invoiceStyle)}</div>
  <div id="gstq" style="${b.gstRate === 'GST registered (regular)' ? '' : 'display:none'}"><div class="field"><label>In your sample invoice, are amounts including GST or excluding GST?<span style="color:#C62828" title="Required"> *</span></label><div class="seg" style="margin-top:6px"><button type="button" id="gm_i" class="${b.gstMode === 'incl' ? 'on' : ''}">Including GST</button><button type="button" id="gm_e" class="${b.gstMode === 'excl' ? 'on' : ''}">Excluding GST (add GST on top)</button></div></div><div class="field"><label for="bp">GST rate (%)<span style="color:#C62828" title="Required"> *</span></label><input id="bp" class="in" inputmode="decimal" value="${esc(b.gstPct)}" style="max-width:140px"></div></div>
  <h2 style="margin:20px 0 6px">Business bank accounts<span style="color:#C62828" title="Required"> *</span></h2><div class="muted" style="font-size:13px;margin-bottom:10px">Add every account customers pay into. Only the last 4 digits are kept. A bank statement is accepted only if it shows one of these accounts, so a personal statement can never validate payments.</div>
  <datalist id="banklist">${BANKS.map(b => `<option value="${esc(b)}">`).join('')}</datalist><div id="accs">${(s.accounts || []).map((x, i) => accRow(x, i)).join('')}</div><button class="btn" type="button" id="addacc" style="margin-bottom:6px">+ Add a bank account</button>
  <h2 style="margin:20px 0 10px">Order IDs</h2>
  <div class="field"><label for="om">How are orders numbered?</label>${sel('om', [['own', 'I use my own order IDs (sales types them)'], ['auto', 'Create order IDs for me']], s.orderIdMode)}<div class="muted" style="font-size:13px;margin-top:4px">Every order also needs the customer's phone number. It lets sales find a customer's orders and warns about duplicates.</div></div>
  <h2 style="margin:20px 0 10px">Where records are kept</h2>
  <div class="field"><label for="st">Storage</label>${sel('st', STORES, s.storage)}<div class="muted" style="font-size:13px;margin-top:4px">Payment Control always keeps every record. The others receive a copy of each approved order and payment. They are only added to, never edited or deleted. Approvals and roles stay here.</div></div>
  <h2 style="margin:20px 0 10px">Limits and alerts</h2><div class="two field"><div><label for="l1">Owner approval above (₹)</label><input id="l1" class="in" inputmode="decimal" value="${lm.singlePayment || ''}" placeholder="No limit"></div><div><label for="l2">Alert when an order collects more than (₹)</label><input id="l2" class="in" inputmode="decimal" value="${lm.collectionThreshold || ''}" placeholder="No alert"></div></div>
  <div class="muted" style="font-size:13px;margin-bottom:12px">Limits never block an entry. They flag it and notify you.</div>
  <h2 style="margin:20px 0 6px">Integrate with my business systems <span class="opt">(optional)</span></h2><div class="muted" style="font-size:13px;margin-bottom:10px">Choose yes if you want approved orders and payments sent to your own system automatically.</div><div class="field"><label><input type="checkbox" id="ae" ${a.enabled ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">Yes, integrate and update payment info in my business systems</label></div>
  <div id="sysbox" ${a.enabled ? '' : 'hidden'}>
  <h3 style="margin:4px 0 6px;font-size:15px">What this system receives</h3><div style="display:flex;flex-wrap:wrap;gap:4px 18px;margin-bottom:10px">${((s.connectors.apiCatalog) || []).map(c => `<label style="font-weight:400"><input type="checkbox" data-apif="${esc(c.k)}" ${(a.fields || []).includes(c.k) ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">${esc(c.label)}</label>`).join('')}</div>
  <div class="field"><label for="au">Endpoint URL</label><input id="au" class="in" placeholder="https://your-panel.example.com/api/record-payment" value="${esc(a.url)}"></div>
  <div class="field"><label for="ak">Secret key ${a.keySet ? '<span class="opt">(saved, leave blank to keep it)</span>' : ''}</label><input id="ak" type="password" class="in" autocomplete="off"></div>
  <div style="margin:4px 0 12px"><button class="btn" type="button" data-act="testApi">Send a test call</button><div class="muted" style="font-size:13px;margin-top:4px">Save settings first, then send a test call. It sends one sample payment to your saved URL.</div></div>
  <div id="syss">${((s.connectors.extra) || []).map(sysRow).join('')}</div><button class="btn" type="button" id="addsys" style="margin-bottom:10px">+ Add another system</button>
</div>
  <h2 style="margin:16px 0 6px">Integrate with a Google Sheet</h2>
  ${s.sheetReady ? `<div class="field"><label><input type="checkbox" id="se" ${s.sheet && s.sheet.id ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">Yes, integrate with a Google Sheet</label></div><div id="shbox" ${s.sheet && s.sheet.id ? '' : 'hidden'}><div class="muted" style="font-size:13px;margin-bottom:8px">Every approved order and payment is added as a new row. Rows are never edited or deleted. Look for the <b>Payments</b> and <b>Orders</b> tabs at the bottom of your sheet to see the details.</div><div class="field"><label for="shl">Your Google Sheet link</label><input id="shl" class="in" placeholder="https://docs.google.com/spreadsheets/d/..." value="${s.sheet && s.sheet.id ? esc('https://docs.google.com/spreadsheets/d/' + s.sheet.id) : ''}"></div><div class="note" style="margin-bottom:8px">Open your sheet, tap <b>Share</b>, add <b id="shem">${esc(s.sheetEmail)}</b> as <b>Editor</b>. Then paste the link above and save.</div><div style="margin-top:12px"><button class="btn" type="button" id="colbtn" aria-expanded="false">+ Choose what goes into the sheet</button></div><div id="colbox" hidden><h3 style="margin:14px 0 6px;font-size:15px">What goes into the sheet</h3><div class="muted" style="font-size:13px;margin-bottom:6px">Tick the columns you want. The Payments tab gets one row per payment, the Orders tab one row per approved order. Column headings are added to a new tab.</div><div class="row" style="gap:16px;align-items:flex-start"><div style="flex:1 1 220px"><b>Payments tab</b>${(s.sheetCatalog ? s.sheetCatalog.payments : []).map(c => `<label style="display:block;font-weight:400;margin-top:6px"><input type="checkbox" data-colp="${esc(c.k)}" ${((s.sheet.cols || {}).payments || []).includes(c.k) ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">${esc(c.label)}</label>`).join('')}</div><div style="flex:1 1 220px"><b>Orders tab</b>${(s.sheetCatalog ? s.sheetCatalog.orders : []).map(c => `<label style="display:block;font-weight:400;margin-top:6px"><input type="checkbox" data-colo="${esc(c.k)}" ${((s.sheet.cols || {}).orders || []).includes(c.k) ? 'checked' : ''} style="width:18px;height:18px;vertical-align:-3px;margin-right:8px">${esc(c.label)}</label>`).join('')}</div></div><div class="muted" style="font-size:13px;margin:8px 0">Rows are only added, never changed. So the sheet shows what each payment looked like when it was added.</div></div><div style="margin-top:12px"><button class="btn" type="button" data-act="testSheet">Send a test row</button><div class="muted" style="font-size:13px;margin-top:4px">Save settings first, then send a test row. It adds the headings and one test row.</div></div></div>` : `<div class="note warn">Google Sheet sending is not switched on for this app yet. The app owner adds one Google key once, then this appears.</div>`}
  <div class="err" id="serr" style="min-height:18px"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn p" type="submit">Save settings</button>${S.savedAt ? `<span id="savedAt" role="status" style="align-self:center;color:var(--acc);font-weight:600">✓ Saved at ${esc(S.savedAt)}</span>` : ''}</div></div>
  <div class="card b"><h2 style="margin-bottom:10px">This workspace</h2><div style="display:flex;flex-direction:column;gap:8px"><div>Storage: <b>${S.health.db === 'supabase' ? 'Database connected' : 'Demo (temporary)'}</b></div><div>Screenshot reading: <b>${S.health.ocr ? 'On' : 'Off'}</b></div></div><p class="muted" style="font-size:13px;margin-top:14px">Approval rules, dashboard views and alerts you can set here today are the limits above. Setting them by chat is planned.</p></div></form>`,
    after() {
      const aeb = document.getElementById('ae'); aeb.addEventListener('change', () => { document.getElementById('sysbox').hidden = !aeb.checked; });
      const seb = document.getElementById('se'); if (seb) seb.addEventListener('change', () => { document.getElementById('shbox').hidden = !seb.checked; });
      const cb = document.getElementById('colbtn'); if (cb) cb.addEventListener('click', () => { const bx = document.getElementById('colbox'); bx.hidden = !bx.hidden; cb.setAttribute('aria-expanded', String(!bx.hidden)); cb.textContent = (bx.hidden ? '+ ' : '− ') + 'Choose what goes into the sheet'; });
      const syss = document.getElementById('syss');
      document.getElementById('addsys').addEventListener('click', () => { syss.insertAdjacentHTML('beforeend', sysRow({})); });
      syss.addEventListener('click', e => { const b = e.target.closest('[data-rmsys]'); if (b) b.closest('[data-sys]').remove(); });
      const readSys = () => [...syss.querySelectorAll('[data-sys]')].map(r => { const g = f => r.querySelector(`[data-f=${f}]`).value.trim(); return { id: g('id'), name: g('name'), url: g('url'), key: g('key'), fields: [...r.querySelectorAll('[data-sf]')].filter(c => c.checked).map(c => c.dataset.sf) }; }).filter(x => x.url);
      const accs = document.getElementById('accs');
      document.getElementById('addacc').addEventListener('click', () => { accs.insertAdjacentHTML('beforeend', accRow({})); });
      accs.addEventListener('click', e => { const b = e.target.closest('[data-rmacc]'); if (b) b.closest('[data-acc]').remove(); });
      const readAccs = () => [...accs.querySelectorAll('[data-acc]')].map(r => { const g = f => r.querySelector(`[data-f=${f}]`).value.trim(); return { id: g('id'), name: g('name'), bank: g('bank'), last4: g('last4'), upi: g('upi').split(/[,\s]+/).filter(Boolean) }; }).filter(a => a.name || a.last4);
      const bn = document.getElementById('bn');
      const gq = () => { document.getElementById('gstq').style.display = document.getElementById('bg').value === 'GST registered (regular)' ? '' : 'none'; }; document.getElementById('bg').addEventListener('change', gq);
      const gmode = m => { const i = document.getElementById('gm_i'), e = document.getElementById('gm_e'), was = (m === 'incl' ? i : e).classList.contains('on'); i.classList.remove('on'); e.classList.remove('on'); if (!was) (m === 'incl' ? i : e).classList.add('on'); }; document.getElementById('gm_i').addEventListener('click', () => gmode('incl')); document.getElementById('gm_e').addEventListener('click', () => gmode('excl')); bn.addEventListener('change', () => { document.getElementById('bt').disabled = bn.checked; document.getElementById('invq').style.display = bn.checked ? '' : 'none'; imv(); });
      const imv = () => { document.getElementById('imq').style.display = bn.checked && !document.getElementById('inv_y').classList.contains('on') ? 'none' : ''; };
      const imm = v => { const o = document.getElementById('im_o'), p = document.getElementById('im_p'); const was = (v === 'o' ? o : p).classList.contains('on'); o.classList.remove('on'); p.classList.remove('on'); if (!was) (v === 'o' ? o : p).classList.add('on'); }; document.getElementById('im_o').addEventListener('click', () => imm('o')); document.getElementById('im_p').addEventListener('click', () => imm('p'));
      const yn = v => { const y = document.getElementById('inv_y'), n = document.getElementById('inv_n'); const was = (v === 'y' ? y : n).classList.contains('on'); y.classList.remove('on'); n.classList.remove('on'); if (!was) (v === 'y' ? y : n).classList.add('on'); imv(); }; document.getElementById('inv_y').addEventListener('click', () => yn('y')); document.getElementById('inv_n').addEventListener('click', () => yn('n'));
      let sampleId = s.invoiceSampleId || '';
      wireDrop('iz', async f => {
        try {
          let d;
          if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
            if (f.size > 3e6) throw new Error('That PDF is too large. Please use one under 3 MB, or a picture of the invoice.');
            d = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(new Error('Could not read that PDF')); fr.readAsDataURL(f); });
            if (!/^data:application\/pdf;base64,/.test(d)) d = 'data:application/pdf;base64,' + String(d).split(',')[1];
          } else if (f.type.startsWith('image/')) {
            try { d = await downscale(f); } catch (e0) { throw new Error('Could not open that picture. Please use a PDF, JPG or PNG.'); }
          } else throw new Error('Please use a PDF, JPG or PNG.');
          const r = await api('POST', 'images', { dataUrl: d, kind: 'sample' }); sampleId = r.id; document.querySelector('#iz b').textContent = (f.name ? f.name + ' added' : 'Sample added') + '. Save to keep it';
        } catch (ex) { toast(ex.message, true); }
      });
      document.getElementById('sf2').addEventListener('submit', async e => {
        e.preventDefault(); const er = document.getElementById('serr'); er.textContent = '';
        const v = id => document.getElementById(id).value;
        try {
          if (!v('ba').trim()) throw new Error('Enter your business address. It goes on every invoice');
          const reg = v('bg') === 'GST registered (regular)', gmv = document.getElementById('gm_e').classList.contains('on') ? 'excl' : document.getElementById('gm_i').classList.contains('on') ? 'incl' : '';
          if (!v('bz').trim()) throw new Error('Enter your business name');
          { const ac = readAccs().filter(x => x.name || x.last4); if (!ac.length) throw new Error('Add at least one business bank account'); if (ac.some(x => !String(x.name || '').trim() || !String(x.bank || '').trim() || !/^\d{4}$/.test(String(x.last4 || '').trim()))) throw new Error('Each bank account needs a name, the bank and the last 4 digits'); }
          if ((!bn.checked || document.getElementById('inv_y').classList.contains('on')) && !document.getElementById('im_o').classList.contains('on') && !document.getElementById('im_p').classList.contains('on')) throw new Error('Choose how invoices should be created: per order or per payment');
          if (bn.checked && !document.getElementById('inv_y').classList.contains('on') && !document.getElementById('inv_n').classList.contains('on')) throw new Error('Choose whether you still want to create invoices');
          if (!v('bg')) throw new Error('Choose your GST status');
          if (reg && !gmv) throw new Error('Choose whether the amount you collect is including GST or excluding GST');
          if (reg && !(v('bp').trim() !== '' && Number(v('bp')) >= 0 && Number(v('bp')) <= 100)) throw new Error('Enter your GST rate in %');
          if (!bn.checked && !v('bt').trim()) throw new Error('Enter your GST or tax number, or tick that it is not applicable');
          await api('PUT', 'settings', { ...(document.getElementById('shl') ? { sheetLink: document.getElementById('se').checked ? document.getElementById('shl').value : '', sheetCols: { payments: [...document.querySelectorAll('[data-colp]')].filter(x => x.checked).map(x => x.dataset.colp), orders: [...document.querySelectorAll('[data-colo]')].filter(x => x.checked).map(x => x.dataset.colo) } } : {}), accounts: readAccs(), extraSystems: readSys(), businessName: v('bz'), onboarded: true, storage: v('st'), orderIdMode: v('om'), invoiceSampleId: sampleId,
            business: { name: v('bz'), kind: v('bk'), industry: v('bi'), gstRate: v('bg'), gstMode: reg ? gmv : '', gstPct: reg ? v('bp').trim() : '', taxId: v('bt'), taxNA: bn.checked, noInvoice: bn.checked && document.getElementById('inv_n').classList.contains('on'), invoiceAns: bn.checked ? (document.getElementById('inv_y').classList.contains('on') ? 'yes' : document.getElementById('inv_n').classList.contains('on') ? 'no' : '') : '', invoiceMode: document.getElementById('im_p').classList.contains('on') ? 'payment' : document.getElementById('im_o').classList.contains('on') ? 'order' : '', address: v('ba'), contact: v('bc') },
            limits: { singlePayment: v('l1').replace(/,/g, ''), collectionThreshold: v('l2').replace(/,/g, '') },
            connectors: { api: { fields: [...document.querySelectorAll('[data-apif]')].filter(x => x.checked).map(x => x.dataset.apif), enabled: document.getElementById('ae').checked, url: v('au'), key: v('ak') } } });
          if (sampleId && sampleId !== (s.invoiceStyle && s.invoiceStyle.imageId)) { try { const rd = await api('POST', 'invoice-style', { imageId: sampleId }); if (rd.error) toast(rd.error, true); else if (rd.configured === false) toast('Sample saved. Automatic reading is off, so invoices use the standard layout.'); } catch (ex) { toast(ex.message, true); } }
          S.savedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); toast('Settings saved'); render();
        } catch (ex) { er.textContent = ex.message; }
      });
    } };
}

// ---------- Fix my business + feedback
async function viewBox() {
  const mgr = RANK[S.user.role] >= RANK.manager;
  const { ideas } = await api('GET', 'ideas');
  S.fixFlow = S.fixFlow || '';
  const list = ideas.map(i => `<div class="tr" style="min-width:0;display:block;padding:10px 0"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="badge ${i.type === 'problem' ? 'warn' : ''}">${i.type === 'problem' ? 'Business problem' : 'Feedback'}</span>${i.rating ? `<span aria-label="${i.rating === 'up' ? 'Thumbs up' : 'Thumbs down'}" style="font-size:16px">${i.rating === 'up' ? '👍' : '👎'}</span>` : ''}<span class="badge ${i.reply ? 'good' : ''}">${i.reply ? 'Answered' : 'Received'}</span><span class="muted" style="font-size:12px">${esc(i.by)} · ${esc(new Date(i.created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))}</span></div><div style="margin-top:4px">${esc(i.text)}</div>${i.manualSteps ? `<div class="muted" style="font-size:13px">Manual steps: ${esc(i.manualSteps)}</div>` : ''}${i.flowImageId ? `<a href="${imgUrl(i.flowImageId)}" target="_blank" rel="noopener" style="color:var(--acc);font-weight:600;font-size:13px">Your flow</a>` : ''}${i.reply ? `<div class="note" style="margin-top:6px"><b>Our reply:</b> ${esc(i.reply)}</div>` : ''}</div>`).join('');
  return { active: '#/box', html: `<div class="fxhead"><h1>${mgr ? '✨ Fix my business' : '✨ Feedback'}</h1><div class="muted">${mgr ? 'Tell us what slows your business down. We come back with a fix.' : 'Tell us what works, what does not, and what you wish this app did.'}</div></div>
  ${mgr ? `<div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:4px">Fix my business</h2><div class="muted" style="font-size:13px;margin-bottom:10px">Describe a problem, or upload your current process and point out the manual steps. We look for ways to automate it, add controls and use AI, then reply here.</div>
  <div class="field"><label for="fx_t">What is the problem?</label><textarea id="fx_t" class="in" rows="3" placeholder="e.g. We chase customers for payments on WhatsApp and lose track"></textarea></div>
  <div class="field"><label>Your current flow <span class="opt">(photo or screenshot, optional)</span></label>${dropZone('fxz', S.fixFlow ? 'Flow added. Drop another to replace it' : 'Drop a picture of your flow here', 1)}</div>
  <div class="field"><label for="fx_m">Which steps are manual?</label><textarea id="fx_m" class="in" rows="2" placeholder="e.g. Typing each payment into Excel; calling customers for reminders"></textarea></div>
  <div class="err" id="fx_e" style="min-height:18px"></div><button class="btn p" id="fx_go" type="button">Send to the team</button></div>` : ''}
  <div class="card" style="margin-bottom:16px"><h2 style="margin-bottom:4px">${mgr ? 'Feedback about this app' : 'Your feedback'}</h2><div class="muted" style="font-size:13px;margin-bottom:10px">Always open. Every note is read.</div>
  <div class="two field"><div><label for="fb_l">Kind</label><select id="fb_l" class="in"><option value="idea">An idea</option><option value="broken">Something broke</option><option value="confusing">Something confusing</option><option value="praise">Something I like</option></select></div><div></div></div>
  <div class="field"><label>How is the app so far?</label><div class="seg" id="fb_r" role="group" aria-label="Rate the app"><button type="button" data-r="up" aria-pressed="false">👍 Good</button><button type="button" data-r="down" aria-pressed="false">👎 Not good</button></div></div>
  <div class="field"><textarea id="fb_t" class="in" rows="3" aria-label="Your feedback" placeholder="Tell us more (optional if you tapped a thumb)"></textarea></div>
  <div class="err" id="fb_e" style="min-height:18px"></div><button class="btn p" id="fb_go" type="button">Send feedback</button></div>
  ${ideas.length ? `<div class="card"><h2 style="margin-bottom:6px">${S.user.role === 'owner' ? 'Everything sent so far' : 'What you sent'}</h2><div class="tbl">${list}</div></div>` : ''}`,
    after() {
      if (document.getElementById('fxz')) wireDrop('fxz', async f => { try { const d = await downscale(f); const r = await api('POST', 'images', { dataUrl: d }); S.fixFlow = r.id; document.querySelector('#fxz b').textContent = 'Flow added. Drop another to replace it'; } catch (ex) { toast(ex.message, true); } });
      const go = async (btn, err, body) => { err.textContent = ''; btn.disabled = true; try { await api('POST', 'ideas', body); S.fixFlow = ''; toast('Sent. Thank you'); render(); } catch (ex) { err.textContent = ex.message; btn.disabled = false; } };
      const fg = document.getElementById('fx_go'); if (fg) fg.addEventListener('click', () => go(fg, document.getElementById('fx_e'), { type: 'problem', text: document.getElementById('fx_t').value, manualSteps: document.getElementById('fx_m').value, flowImageId: S.fixFlow }));
      let rate = '';
      document.querySelectorAll('#fb_r [data-r]').forEach(b => b.addEventListener('click', () => { rate = rate === b.dataset.r ? '' : b.dataset.r; document.querySelectorAll('#fb_r [data-r]').forEach(x => { const on = x.dataset.r === rate; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); }); }));
      const bg = document.getElementById('fb_go'); bg.addEventListener('click', () => go(bg, document.getElementById('fb_e'), { type: 'feedback', label: document.getElementById('fb_l').value, rating: rate, text: document.getElementById('fb_t').value }));
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
  async backupAll() {
    try {
      const j = await api('GET', 'data/backup');
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' }), u = URL.createObjectURL(blob), el = document.createElement('a');
      el.href = u; el.download = 'payment-control-backup-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
      toast('Backup downloaded: ' + Object.entries(j.counts).filter(([, v]) => v).map(([k, v]) => v + ' ' + k).join(', '));
    } catch (e) { toast(e.message, true); }
  },
  async startFresh() {
    const t = document.getElementById('sf_t');
    try { await api('POST', 'data/start-fresh', { confirm: t ? t.value.trim() : '' }); }
    catch (ex) { toast(ex.message, true); return; }
    toast('Everything removed. Create the real owner account now.'); logout();
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
