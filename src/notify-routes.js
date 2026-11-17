const express = require('express');
const { getConfig } = require('./alipay');
const ops = require('./alipay-ops');
const orders = require('./orders');
const gifts = require('./gifts');
const { toCents } = require('./money');

const router = express.Router();

router.post('/alipay', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
  const params = { ...req.body };
  try {
    const { config } = getConfig();
    if (params.app_id !== config.appId) {
      warn('alipay notify app config not found', params);
      return fail(res);
    }
    if (!ops.notifySignValid(params)) {
      warn('alipay notify signature check failed', params);
      return fail(res);
    }
    const order = await orders.getOrder(params.out_trade_no);
    if (!order || !fieldsMatch(order, params, config)) {
      warn('alipay notify business check failed', params);
      return fail(res);
    }
    const firstTime = await orders.insertNotifyOnce({
      notifyId: params.notify_id,
      tradeNo: params.trade_no,
      outTradeNo: params.out_trade_no,
      tradeStatus: params.trade_status,
    });
    if (!firstTime) return res.type('text/plain').send('success');
    if (ops.isPaidNotification(params)) {
      await orders.markPaidIdempotently(order.outTradeNo, params.trade_no, params);
      if (order.giftId) await gifts.publishGift(order.giftId);
    } else {
      await orders.recordNonPaidTradeEvent(order.outTradeNo, params.trade_status);
    }
    return res.type('text/plain').send('success');
  } catch (error) {
    warn('alipay notify unexpected exception', params);
    return fail(res);
  }
});

function fieldsMatch(order, params, config) {
  return params.out_trade_no === order.outTradeNo
    && toCents(params.total_amount) === toCents(order.totalAmount)
    && Boolean(
      (config.sellerId && params.seller_id === config.sellerId)
      || (config.sellerEmail && params.seller_email === config.sellerEmail)
      || (!config.sellerId && !config.sellerEmail)
    );
}

function fail(res) {
  return res.type('text/plain').send('fail');
}

function warn(message, params) {
  const { sign, ...safeParams } = params || {};
  try {
    console.warn(`[notify] ${message}`, JSON.stringify(safeParams));
  } catch (error) {
    console.warn(`[notify] ${message}`);
  }
}

module.exports = { notifyRouter: router };
