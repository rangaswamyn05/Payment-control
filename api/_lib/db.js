'use strict';
// Storage adapter. Uses Supabase (REST, service key, server-side only) when configured,
// otherwise an in-memory store (data is lost on restart: demo/testing only).
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
// Each request runs inside its own store; the signed-in user's business (org) is set once, and every read and write below stays inside it.
// Rows saved before businesses existed have no orgId and belong to the original business, 'main'.
const run = fn => als.run({ org: null }, fn);
const setOrg = org => { const st = als.getStore(); if (st) st.org = org || 'main'; };
const curOrg = () => { const st = als.getStore(); return st ? st.org : null; };
const inOrg = row => { const o = curOrg(); return !o || (row.orgId || 'main') === o; };
const realId = (t, id) => { const o = curOrg(); return t === 'settings' && id === 'main' && o && o !== 'main' ? 'main_' + o : id; };

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

async function allRaw(t) {
  if (!useSB) return mem[t].map(x => ({ ...x }));
  const rows = await sb(`${t}?select=id,data&order=created_at.asc&limit=5000`);
  return rows.map(r => ({ ...r.data, id: r.id }));
}
async function all(t) { return (await allRaw(t)).filter(inOrg); }
async function allGlobal(t) { return allRaw(t); } // only for sign-in and unique usernames

async function getRaw(t, id) {
  if (!id) return null;
  if (!useSB) { const x = mem[t].find(r => r.id === id); return x ? { ...x } : null; }
  const rows = await sb(`${t}?id=eq.${encodeURIComponent(id)}&select=id,data`);
  return rows[0] ? { ...rows[0].data, id: rows[0].id } : null;
}
async function get(t, id) { const x = await getRaw(t, realId(t, id)); return x && inOrg(x) ? x : null; }

async function insert(t, row) {
  row = { ...row };
  row.id = realId(t, row.id) || newId(t.slice(0, 3));
  { const o = curOrg(); if (o && o !== 'main' && !row.orgId) row.orgId = o; }
  row.created = row.created || new Date().toISOString();
  if (!useSB) { mem[t].push(row); return { ...row }; }
  const { id, ...data } = row;
  await sb(t, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id, data }) });
  return row;
}

async function update(t, id, patch) {
  id = realId(t, id);
  const cur = await get(t, id);
  if (!cur) return null;
  const next = { ...cur, ...patch, id, ...(cur.orgId ? { orgId: cur.orgId } : {}) };
  if (!useSB) { mem[t][mem[t].findIndex(r => r.id === id)] = next; return { ...next }; }
  const { id: _omit, ...data } = next;
  await sb(`${t}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ data }) });
  return next;
}

async function remove(t, id) {
  id = realId(t, id);
  if (!(await get(t, id))) return;
  if (!useSB) { const i = mem[t].findIndex(r => r.id === id); if (i >= 0) mem[t].splice(i, 1); return; }
  await sb(`${t}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

module.exports = { all, allGlobal, get, insert, update, remove, run, setOrg, curOrg, newId, kind: useSB ? 'supabase' : 'memory', TABLES };
