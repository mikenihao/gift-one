const crypto = require('crypto');

function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function ensureSession(req, res) {
  const sid = parseCookies(req.headers.cookie).gift_sid;
  if (sid) return sid;
  const created = crypto.randomBytes(16).toString('hex');
  const secure = (process.env.PUBLIC_BASE_URL || '').startsWith('https://');
  res.cookie('gift_sid', created, { httpOnly: true, sameSite: 'lax', secure, maxAge: 7 * 24 * 3600 * 1000 });
  return created;
}

function baseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

module.exports = { parseCookies, ensureSession, baseUrl };
