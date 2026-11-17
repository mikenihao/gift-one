const restUrl = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const restToken = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const enabled = Boolean(restUrl && restToken);

async function command(args) {
  const response = await fetch(restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${restToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`upstash http ${response.status}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(`upstash: ${data.error}`);
  }
  return data.result;
}

function deserialize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

async function get(key) {
  if (!enabled) return null;
  return deserialize(await command(['GET', key]));
}

async function set(key, value) {
  if (!enabled) return;
  await command(['SET', key, typeof value === 'string' ? value : JSON.stringify(value)]);
}

async function setIfAbsent(key, value, ttlSeconds) {
  if (!enabled) return true;
  const args = ['SET', key, typeof value === 'string' ? value : JSON.stringify(value), 'NX'];
  if (ttlSeconds) args.push('EX', String(ttlSeconds));
  const result = await command(args);
  return result === 'OK';
}

module.exports = { enabled, get, set, setIfAbsent };
