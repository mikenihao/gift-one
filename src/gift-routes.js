const fs = require('fs');
const path = require('path');
const express = require('express');
const gifts = require('./gifts');
const orders = require('./orders');
const store = require('./store');
const ops = require('./alipay-ops');
const { normalizeAmount, toCents } = require('./money');
const { ensureSession, baseUrl } = require('./session');

const router = express.Router();
const GIFT_DATA_OPEN = '<script id="gift-data" type="application/json">';
const MAX_GIFT_BYTES = 8 * 1024 * 1024;

let templateCache = null;

function giftPagePath() {
  return process.env.GIFT_PAGE || path.join(__dirname, '..', 'templates', 'birthday.html');
}

function loadTemplate() {
  if (!templateCache) templateCache = fs.readFileSync(giftPagePath(), 'utf8');
  return templateCache;
}

function priceAmount() {
  const normalized = normalizeAmount(process.env.GIFT_PRICE || '0.01');
  if (normalized === null) return null;
  const cents = toCents(normalized);
  if (cents < 1n || cents > 10000000000n) return null;
  return normalized;
}

router.get('/api/gifts/config', (req, res) => {
  const price = priceAmount();
  if (!price) return res.status(503).json({ error: '支付价格配置无效' });
  res.json({ price, currency: 'CNY' });
});

router.post('/api/gifts', express.json({ limit: store.enabled ? '12mb' : '60mb' }), async (req, res, next) => {
  try {
    const templateId = String(req.body.templateId || '').trim().slice(0, 64);
    const data = req.body.data;
    if (!templateId) return res.status(400).json({ error: '缺少模板标识' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: '礼物内容格式不正确' });
    }
    if (store.enabled && Buffer.byteLength(JSON.stringify(data)) > MAX_GIFT_BYTES) {
      return res.status(413).json({ error: '礼物内容超过 8MB，请压缩图片或换用更小的音乐' });
    }
    const sid = ensureSession(req, res);
    const gift = await gifts.createGift({ templateId, data, sessionId: sid });
    res.json({ giftId: gift.giftId });
  } catch (error) {
    next(error);
  }
});

router.post('/api/gifts/:giftId/order', express.json(), async (req, res, next) => {
  try {
    const sid = ensureSession(req, res);
    const gift = await gifts.getMeta(req.params.giftId);
    if (!gift || gift.sessionId !== sid) {
      return res.status(404).json({ error: '礼物不存在或不属于当前会话' });
    }
    const price = priceAmount();
    if (!price) return res.status(503).json({ error: '支付价格配置无效' });
    const order = await orders.createOrder({
      subject: '生日礼物专属链接',
      totalAmount: price,
      sessionId: sid,
      giftId: gift.giftId,
    });
    await gifts.bindOrder(gift.giftId, order.outTradeNo);
    const paymentHtml = ops.buildPagePayHtml(order, baseUrl(req));
    res.json({ outTradeNo: order.outTradeNo, totalAmount: price, paymentHtml });
  } catch (error) {
    next(error);
  }
});

router.get('/g/:token', async (req, res, next) => {
  try {
    const meta = await gifts.findByToken(req.params.token);
    const data = meta && (await gifts.readPayload(meta.giftId));
    if (!meta || !data) return res.status(404).type('html').send(notFoundPage());
    const html = loadTemplate();
    const start = html.indexOf(GIFT_DATA_OPEN);
    const end = html.indexOf('</script>', start);
    if (start < 0 || end < 0) throw new Error('礼物模板缺少 gift-data 数据块');
    const payload = JSON.stringify({ ...data, mode: 'recipient' }).replaceAll('<', '\\u003c');
    const page = html.slice(0, start + GIFT_DATA_OPEN.length) + payload + html.slice(end);
    res.set('Cache-Control', 'no-store').type('html').send(page);
  } catch (error) {
    next(error);
  }
});

function notFoundPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>礼物不存在</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fdf7ee;color:#4a3728;font:16px/1.7 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 12px}</style></head>
<body><main><h1>这份礼物还没有准备好</h1><p>链接可能不完整或尚未生效，请向送礼的人确认后再打开。</p></main></body></html>`;
}

module.exports = { giftRouter: router };
