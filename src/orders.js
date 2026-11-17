const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const ordersFile = path.join(dataDir, 'orders.json');
const notificationsFile = path.join(dataDir, 'notifications.json');

let state = null;
let writeChain = Promise.resolve();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function ensureState() {
  if (state) return state;
  fs.mkdirSync(dataDir, { recursive: true });
  state = { orders: readJson(ordersFile), notifications: readJson(notificationsFile) };
  return state;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function persist(ordersChanged, notificationsChanged) {
  const snapshot = ensureState();
  const ordersCopy = JSON.stringify(snapshot.orders);
  const notificationsCopy = JSON.stringify(snapshot.notifications);
  writeChain = writeChain.then(() => {
    if (ordersChanged) writeAtomic(ordersFile, JSON.parse(ordersCopy));
    if (notificationsChanged) writeAtomic(notificationsFile, JSON.parse(notificationsCopy));
  });
  return writeChain;
}

function createOutTradeNo() {
  return `GIFT${Date.now()}${crypto.randomInt(1000, 9999)}`;
}

function orderKey(outTradeNo) {
  return `order:${outTradeNo}`;
}

async function createOrder({ subject, totalAmount, sessionId, giftId }) {
  let outTradeNo = createOutTradeNo();
  if (store.enabled) {
    while (await store.get(orderKey(outTradeNo))) outTradeNo = createOutTradeNo();
    const order = {
      outTradeNo,
      subject,
      totalAmount,
      status: 'CREATED',
      tradeNo: null,
      sessionId,
      giftId: giftId || null,
      createdAt: new Date().toISOString(),
      paidAt: null,
      refunds: [],
    };
    await store.set(orderKey(outTradeNo), order);
    return order;
  }
  const snapshot = ensureState();
  while (snapshot.orders[outTradeNo]) outTradeNo = createOutTradeNo();
  snapshot.orders[outTradeNo] = {
    outTradeNo,
    subject,
    totalAmount,
    status: 'CREATED',
    tradeNo: null,
    sessionId,
    giftId: giftId || null,
    createdAt: new Date().toISOString(),
    paidAt: null,
    refunds: [],
  };
  persist(true, false);
  return snapshot.orders[outTradeNo];
}

async function getOrder(outTradeNo) {
  if (!outTradeNo) return null;
  if (store.enabled) return store.get(orderKey(outTradeNo));
  return ensureState().orders[outTradeNo] || null;
}

async function updateOrder(outTradeNo, mutate) {
  const order = await getOrder(outTradeNo);
  if (!order) return null;
  mutate(order);
  if (store.enabled) {
    await store.set(orderKey(outTradeNo), order);
    return order;
  }
  ensureState().orders[outTradeNo] = order;
  persist(true, false);
  return order;
}

async function markPaidIdempotently(outTradeNo, tradeNo, params) {
  return updateOrder(outTradeNo, (order) => {
    if (order.status === 'PAID') return;
    order.status = 'PAID';
    order.tradeNo = tradeNo || order.tradeNo;
    order.paidAt = order.paidAt || new Date().toISOString();
    order.paidTotalAmount = order.paidTotalAmount || params.total_amount;
  });
}

async function recordNonPaidTradeEvent(outTradeNo, tradeStatus) {
  return updateOrder(outTradeNo, (order) => {
    const events = order.events || [];
    events.push({ tradeStatus, at: new Date().toISOString() });
    order.events = events.slice(-20);
    if (tradeStatus === 'TRADE_CLOSED' && order.status === 'CREATED') order.status = 'CLOSED';
  });
}

async function insertNotifyOnce({ notifyId, tradeNo, outTradeNo, tradeStatus }) {
  const key = notifyId || `${tradeNo}:${outTradeNo}:${tradeStatus}`;
  const record = { tradeNo, outTradeNo, tradeStatus, at: new Date().toISOString() };
  if (store.enabled) {
    return store.setIfAbsent(`notify:${key}`, record, 60 * 60 * 24 * 30);
  }
  const snapshot = ensureState();
  if (snapshot.notifications[key]) return false;
  snapshot.notifications[key] = record;
  persist(false, true);
  return true;
}

module.exports = {
  createOrder,
  getOrder,
  updateOrder,
  markPaidIdempotently,
  recordNonPaidTradeEvent,
  insertNotifyOnce,
};
