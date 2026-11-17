const express = require('express');
const crypto = require('crypto');
const { normalizeAmount, toCents } = require('./money');
const orders = require('./orders');
const ops = require('./alipay-ops');
const gifts = require('./gifts');
const { ensureSession, baseUrl } = require('./session');

const router = express.Router();

async function requireOrder(req, res, sid) {
  const order = await orders.getOrder(req.params.outTradeNo);
  if (!order || order.sessionId !== sid) {
    res.status(404).json({ error: '订单不存在或不属于当前会话' });
    return null;
  }
  return order;
}

router.post('/orders', async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const amount = normalizeAmount(req.body.amount);
    const subject = String(req.body.subject || '生日礼金').trim().slice(0, 256) || '生日礼金';
    if (amount === null) return res.status(400).json({ error: '金额格式不正确，最多两位小数' });
    const cents = toCents(amount);
    if (cents < 1n || cents > 10000000000n) return res.status(400).json({ error: '金额需在 0.01 到 100000000 之间' });
    const order = await orders.createOrder({ subject, totalAmount: amount, sessionId: sid });
    const paymentHtml = ops.buildPagePayHtml(order, baseUrl(req));
    res.json({ outTradeNo: order.outTradeNo, totalAmount: order.totalAmount, subject: order.subject, paymentHtml });
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:outTradeNo', async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const order = await requireOrder(req, res, sid);
    if (!order) return;
    res.json(publicOrder(order));
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:outTradeNo/query', async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const order = await requireOrder(req, res, sid);
    if (!order) return;
    const result = await ops.queryTrade(order.outTradeNo);
    const tradeStatus = ops.pickField(result, 'trade_status', 'tradeStatus');
    const state = ops.mapTradeState(tradeStatus);
    if (state === 'PAID') {
      const paidAmount = normalizeAmount(ops.pickField(result, 'total_amount', 'totalAmount'));
      if (paidAmount === null || paidAmount !== order.totalAmount) {
        return res.status(502).json({ error: '支付金额与订单不一致，暂不能标记为已支付' });
      }
      await orders.markPaidIdempotently(order.outTradeNo, ops.pickField(result, 'trade_no', 'tradeNo'), { total_amount: paidAmount });
    } else if (state === 'CLOSED') {
      await orders.recordNonPaidTradeEvent(order.outTradeNo, tradeStatus);
    }
    const latest = await orders.getOrder(order.outTradeNo);
    let giftUrl = null;
    if (latest.status === 'PAID' && latest.giftId) {
      const token = await gifts.publishGift(latest.giftId);
      if (token) giftUrl = `${baseUrl(req)}/g/${token}`;
    }
    res.json({ localState: state, tradeStatus: tradeStatus || null, order: publicOrder(latest), giftUrl });
  } catch (error) {
    if (ops.alipaySubCode(error) === 'ACQ.TRADE_NOT_EXIST') {
      return res.json({ localState: 'CREATED', tradeStatus: null, order: publicOrder(order) });
    }
    next(error);
  }
});

router.post('/orders/:outTradeNo/close', async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const order = await requireOrder(req, res, sid);
    if (!order) return;
    if (order.status === 'PAID') return res.status(409).json({ error: '订单已支付，不能关闭' });
    try {
      const queried = await ops.queryTrade(order.outTradeNo);
      const queriedStatus = ops.pickField(queried, 'trade_status', 'tradeStatus');
      if (ops.mapTradeState(queriedStatus) === 'PAID') {
        const paidAmount = normalizeAmount(ops.pickField(queried, 'total_amount', 'totalAmount'));
        if (paidAmount === order.totalAmount) {
          await orders.markPaidIdempotently(order.outTradeNo, ops.pickField(queried, 'trade_no', 'tradeNo'), { total_amount: paidAmount });
        }
        return res.status(409).json({ error: '订单已支付，不能关闭', order: publicOrder(await orders.getOrder(order.outTradeNo)) });
      }
    } catch (error) {
      const missing = ops.alipaySubCode(error) === 'ACQ.TRADE_NOT_EXIST';
      if (!missing) throw error;
    }
    await ops.closeTrade(order.outTradeNo);
    await orders.recordNonPaidTradeEvent(order.outTradeNo, 'TRADE_CLOSED');
    await orders.updateOrder(order.outTradeNo, (target) => { target.status = 'CLOSED'; });
    res.json({ order: publicOrder(await orders.getOrder(order.outTradeNo)) });
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:outTradeNo/refund', async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const order = await requireOrder(req, res, sid);
    if (!order) return;
    if (order.status !== 'PAID') return res.status(409).json({ error: '订单尚未支付，不能退款' });
    const refundAmount = normalizeAmount(req.body.amount);
    if (refundAmount === null) return res.status(400).json({ error: '退款金额格式不正确' });
    const refundReason = String(req.body.reason || '').slice(0, 256);

    let refund = null;
    if (req.body.outRequestNo) {
      refund = order.refunds.find((item) => item.outRequestNo === req.body.outRequestNo);
      if (!refund) return res.status(400).json({ error: '退款请求号不存在，新退款请勿复用旧编号' });
      if (refund.status === 'SUCCESS') return res.json({ refund, order: publicOrder(order) });
      if (refund.amount !== refundAmount) return res.status(409).json({ error: '重试退款金额需与原请求一致' });
    } else {
      const paidCents = toCents(order.paidTotalAmount || order.totalAmount);
      const reservedCents = order.refunds
        .filter((item) => item.status !== 'FAILED')
        .reduce((sum, item) => sum + toCents(item.amount), 0n);
      if (reservedCents + toCents(refundAmount) > paidCents) {
        return res.status(400).json({ error: '累计退款金额超过订单实付金额' });
      }
      const outRequestNo = `RF${Date.now()}${crypto.randomInt(1000, 9999)}`;
      refund = { outRequestNo, amount: refundAmount, reason: refundReason, status: 'PENDING', refundFee: null, subCode: null };
      await orders.updateOrder(order.outTradeNo, (target) => { target.refunds.push(refund); });
    }

    try {
      const result = await ops.refundTrade({
        outTradeNo: order.outTradeNo,
        refundAmount,
        outRequestNo: refund.outRequestNo,
        refundReason: refund.reason,
      });
      await orders.updateOrder(order.outTradeNo, (target) => {
        const item = target.refunds.find((entry) => entry.outRequestNo === refund.outRequestNo);
        if (ops.pickField(result, 'fund_change', 'fundChange') === 'Y') {
          item.status = 'SUCCESS';
          item.refundFee = ops.pickField(result, 'refund_fee', 'refundFee');
        } else {
          item.status = 'PENDING';
          item.subCode = 'FUND_CHANGE_NOT_CONFIRMED';
        }
      });
      const latest = await orders.getOrder(order.outTradeNo);
      res.json({ refund: latest.refunds.find((item) => item.outRequestNo === refund.outRequestNo), order: publicOrder(latest) });
    } catch (error) {
      if (error.alipay) {
        await orders.updateOrder(order.outTradeNo, (target) => {
          const item = target.refunds.find((entry) => entry.outRequestNo === refund.outRequestNo);
          item.status = 'FAILED';
          item.subCode = ops.alipaySubCode(error) || error.alipay.msg || 'UNKNOWN';
        });
        const latest = await orders.getOrder(order.outTradeNo);
        return res.status(502).json({ error: '退款请求未被受理，可保持同一 out_request_no 重试', refund: latest.refunds.find((item) => item.outRequestNo === refund.outRequestNo) });
      }
      return res.status(502).json({ error: '退款结果未知，请保持同一 out_request_no 重试或稍后查询', refund });
    }
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:outTradeNo/refund-query', async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const order = await requireOrder(req, res, sid);
    if (!order) return;
    const refund = order.refunds.find((item) => item.outRequestNo === req.body.outRequestNo);
    if (!refund) return res.status(404).json({ error: '退款请求号不存在' });
    const result = await ops.refundQuery({ outTradeNo: order.outTradeNo, outRequestNo: refund.outRequestNo });
    const refundStatus = ops.pickField(result, 'refund_status', 'refundStatus');
    if (refundStatus === 'REFUND_SUCCESS') {
      await orders.updateOrder(order.outTradeNo, (target) => {
        const item = target.refunds.find((entry) => entry.outRequestNo === refund.outRequestNo);
        item.status = 'SUCCESS';
        item.refundFee = item.refundFee || ops.pickField(result, 'refund_amount', 'refundAmount');
      });
    }
    const latest = await orders.getOrder(order.outTradeNo);
    res.json({ refundStatus: refundStatus || null, refund: latest.refunds.find((item) => item.outRequestNo === refund.outRequestNo) });
  } catch (error) {
    next(error);
  }
});

function publicOrder(order) {
  return {
    outTradeNo: order.outTradeNo,
    subject: order.subject,
    totalAmount: order.totalAmount,
    status: order.status,
    tradeNo: order.tradeNo,
    paidAt: order.paidAt,
    refunds: order.refunds,
  };
}

module.exports = { paymentRouter: router };
