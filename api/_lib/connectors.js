'use strict';
// Sends each payment event to the business's own systems.
// Implemented: the business API connector. Google Sheets connector is added in a later step.

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
  if (api && api.enabled && api.url && !validateUrl(api.url)) results.push(await sendApi(api, event, payment, order));
  return results;
}

module.exports = { dispatch, validateUrl };
