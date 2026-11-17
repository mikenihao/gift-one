const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const giftsDir = path.join(dataDir, 'gifts');
const indexFile = path.join(dataDir, 'gifts.json');

let index = null;
let writeChain = Promise.resolve();

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function ensureIndex() {
  if (index) return index;
  fs.mkdirSync(giftsDir, { recursive: true });
  index = readIndex();
  return index;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function persist() {
  const copy = JSON.stringify(ensureIndex(), null, 2);
  writeChain = writeChain.then(() => writeAtomic(indexFile, copy));
  return writeChain;
}

function payloadFile(giftId) {
  return path.join(giftsDir, `${giftId}.json`);
}

function newGiftId() {
  return crypto.randomBytes(9).toString('base64url');
}

async function saveMeta(meta) {
  if (store.enabled) {
    await store.set(`gift:${meta.giftId}:meta`, meta);
    return meta;
  }
  ensureIndex()[meta.giftId] = meta;
  persist();
  return meta;
}

async function createGift({ templateId, data, sessionId }) {
  let giftId = newGiftId();
  if (store.enabled) {
    while (await store.get(`gift:${giftId}:meta`)) giftId = newGiftId();
    const meta = {
      giftId,
      templateId,
      sessionId,
      createdAt: new Date().toISOString(),
      orderNo: null,
      token: null,
      publishedAt: null,
    };
    await store.set(`gift:${giftId}:data`, data);
    await store.set(`gift:${giftId}:meta`, meta);
    return meta;
  }
  const snapshot = ensureIndex();
  while (snapshot[giftId]) giftId = newGiftId();
  writeAtomic(payloadFile(giftId), JSON.stringify(data));
  snapshot[giftId] = {
    giftId,
    templateId,
    sessionId,
    createdAt: new Date().toISOString(),
    orderNo: null,
    token: null,
    publishedAt: null,
  };
  persist();
  return snapshot[giftId];
}

async function getMeta(giftId) {
  if (!giftId) return null;
  if (store.enabled) return store.get(`gift:${giftId}:meta`);
  return ensureIndex()[giftId] || null;
}

async function readPayload(giftId) {
  if (!giftId) return null;
  if (store.enabled) return store.get(`gift:${giftId}:data`);
  try {
    return JSON.parse(fs.readFileSync(payloadFile(giftId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function bindOrder(giftId, outTradeNo) {
  const meta = await getMeta(giftId);
  if (!meta) return null;
  meta.orderNo = outTradeNo;
  return saveMeta(meta);
}

async function publishGift(giftId) {
  const meta = await getMeta(giftId);
  if (!meta) return null;
  if (!meta.token) {
    meta.token = crypto.randomBytes(12).toString('base64url');
    meta.publishedAt = new Date().toISOString();
    await saveMeta(meta);
  }
  if (store.enabled) {
    await store.set(`token:${meta.token}`, meta.giftId);
  }
  return meta.token;
}

async function findByToken(token) {
  if (!token) return null;
  if (store.enabled) {
    const giftId = await store.get(`token:${token}`);
    if (!giftId) return null;
    return getMeta(String(giftId));
  }
  const snapshot = ensureIndex();
  for (const meta of Object.values(snapshot)) {
    if (meta.token === token) return meta;
  }
  return null;
}

module.exports = { createGift, getMeta, readPayload, bindOrder, publishGift, findByToken };
