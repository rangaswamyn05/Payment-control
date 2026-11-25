'use strict';
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const secretIsSet = !!process.env.SESSION_SECRET;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, h] = String(stored || '').split(':');
    if (!salt || !h) return false;
    const x = crypto.scryptSync(String(pw), salt, 32);
    const y = Buffer.from(h, 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (e) { return false; }
}

const b64 = s => Buffer.from(s).toString('base64url');

function sign(payload, ttlSec = 60 * 60 * 12) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function verifyToken(tok) {
  try {
    const [body, mac] = String(tok || '').split('.');
    if (!body || !mac) return null;
    const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    const a = Buffer.from(mac), b = Buffer.from(good);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch (e) { return null; }
}

module.exports = { hashPassword, verifyPassword, sign, verifyToken, secretIsSet };
