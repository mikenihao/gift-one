const { getSdk, getConfig } = require('./alipay');

const PAGE_PAY_METHOD = 'alipay.trade.page.pay';
const PAID_STATUSES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

// alipay-sdk 4.x 把响应字段转成驼峰，通知参数仍是下划线，读取时两者都接受。
function pickField(source, ...names) {
  if (!source) return undefined;
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function alipaySubCode(error) {
  return pickField(error && error.alipay, 'sub_code', 'subCode');
}

function mapTradeState(tradeStatus) {
  if (PAID_STATUSES.has(tradeStatus)) return 'PAID';
  if (tradeStatus === 'WAIT_BUYER_PAY') return 'PENDING_PAYMENT';
  if (tradeStatus === 'TRADE_CLOSED') return 'CLOSED';
  return 'UNKNOWN';
}

function isPaidNotification(params) {
  return PAID_STATUSES.has(params.trade_status) && !params.out_biz_no && !params.gmt_refund && !params.refund_fee;
}

function buildPagePayHtml(order, baseUrl) {
  const sdk = getSdk();
  const requestOptions = {
    returnUrl: `${baseUrl}/pay/return`,
    bizContent: {
      out_trade_no: order.outTradeNo,
      total_amount: order.totalAmount,
      subject: order.subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    },
  };
  const notifyUrl = (process.env.ALIPAY_NOTIFY_URL || '').trim();
  if (notifyUrl) requestOptions.notifyUrl = notifyUrl;
  return sdk.pageExec(PAGE_PAY_METHOD, 'POST', requestOptions);
}

async function execute(method, bizContent) {
  const sdk = getSdk();
  const result = await sdk.exec(method, { bizContent });
  if (!result || result.code !== '10000') {
    const subCode = pickField(result, 'sub_code', 'subCode');
    const detail = subCode || (result && result.msg) ? `${subCode || ''} ${(result && result.msg) || ''}`.trim() : 'unknown';
    const error = new Error(`支付宝接口调用失败：${method} ${detail}`);
    error.alipay = result;
    throw error;
  }
  return result;
}

async function queryTrade(outTradeNo) {
  return execute('alipay.trade.query', { out_trade_no: outTradeNo });
}

async function closeTrade(outTradeNo) {
  return execute('alipay.trade.close', { out_trade_no: outTradeNo });
}

async function refundTrade({ outTradeNo, refundAmount, outRequestNo, refundReason }) {
  return execute('alipay.trade.refund', {
    out_trade_no: outTradeNo,
    refund_amount: refundAmount,
    out_request_no: outRequestNo,
    refund_reason: refundReason,
  });
}

async function refundQuery({ outTradeNo, outRequestNo }) {
  return execute('alipay.trade.fastpay.refund.query', {
    out_trade_no: outTradeNo,
    out_request_no: outRequestNo,
  });
}

function notifySignValid(params) {
  const sdk = getSdk();
  if (typeof sdk.checkNotifySignV2 === 'function') return sdk.checkNotifySignV2(params);
  return sdk.checkNotifySign(params);
}

function sellerMatches(params) {
  const { config } = getConfig();
  return Boolean(
    (config.sellerId && params.seller_id === config.sellerId)
    || (config.sellerEmail && params.seller_email === config.sellerEmail)
  );
}

module.exports = {
  buildPagePayHtml,
  queryTrade,
  closeTrade,
  refundTrade,
  refundQuery,
  pickField,
  alipaySubCode,
  mapTradeState,
  isPaidNotification,
  notifySignValid,
  sellerMatches,
};
