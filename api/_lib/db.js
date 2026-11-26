'use strict';
// Storage adapter. Uses Supabase (REST, service key, server-side only) when configured,
// otherwise an in-memory store (data is lost on restart: demo/testing only).
const crypto = require('crypto');

let SB_URL = (process.env.SUPABASE_URL || '').trim();
try { if (SB_URL) SB_URL = new URL(/^https?:\/\//.test(SB_URL) ? SB_URL : 'https://' + SB_URL).origin; } catch (e) { /* left as typed */ }
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const useSB = !!(SB_URL && SB_KEY);
const TABLES = ['users', 'orders', 'payments', 'audit', 'settings', 'images', 'notifications', 'requests', 'invoices'];

const mem = global.__pcmem || (global.__pcmem = Object.fromEntries(TABLES.map(t => [t, []])));

function newId(prefix) { return prefix + '_' + crypto.randomBytes(7).toString('hex'); }

async function sb(path, opt = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opt,
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', ...(opt.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('Database error ' + r.status + ' at ' + new URL(SB_URL).host + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

async function all(t) {
  if (!useSB) return mem[t].map(x => ({ ...x }));
  const rows = await sb(`${t}?select=id,data&order=created_at.asc&limit=5000`);
  return rows.map(r => ({ ...r.data, id: r.id }));
}

async function get(t, id) {
  if (!id) return null;
  if (!useSB) { const x = mem[t].find(r => r.id === id); return x ? { ...x } : null; }
  const rows = await sb(`${t}?id=eq.${encodeURIComponent(id)}&select=id,data`);
  return rows[0] ? { ...rows[0].data, id: rows[0].id } : null;
}

async function insert(t, row) {
  row = { ...row };
  row.id = row.id || newId(t.slice(0, 3));
  row.created = row.created || new Date().toISOString();
  if (!useSB) { mem[t].push(row); return { ...row }; }
  const { id, ...data } = row;
  await sb(t, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id, data }) });
  return row;
}

async function update(t, id, patch) {
  const cur = await get(t, id);
  if (!cur) return null;
  const next = { ...cur, ...patch, id };
  if (!useSB) { mem[t][mem[t].findIndex(r => r.id === id)] = next; return { ...next }; }
  const { id: _omit, ...data } = next;
  await sb(`${t}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ data }) });
  return next;
}

async function remove(t, id) {
  if (!useSB) { const i = mem[t].findIndex(r => r.id === id); if (i >= 0) mem[t].splice(i, 1); return; }
  await sb(`${t}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

module.exports = { all, get, insert, update, remove, newId, kind: useSB ? 'supabase' : 'memory', TABLES };
