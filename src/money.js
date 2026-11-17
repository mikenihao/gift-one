function normalizeAmount(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const yuan = BigInt(match[1]).toString();
  const cents = (match[2] || '').padEnd(2, '0');
  return `${yuan}.${cents}`;
}

function toCents(value) {
  const normalized = normalizeAmount(value);
  if (normalized === null) return null;
  const [yuan, cents] = normalized.split('.');
  return BigInt(yuan) * 100n + BigInt(cents);
}

function formatAlipayTimestamp(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { normalizeAmount, toCents, formatAlipayTimestamp };
