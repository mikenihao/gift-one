const fs = require('fs');
const path = require('path');
const { AlipaySdk } = require('alipay-sdk');

const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, '.alipay-sandbox.json');
const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

let cached = null;

class PaymentConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentConfigError';
    this.code = 'PAYMENT_CONFIG_NOT_READY';
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function keyText(value) {
  return text(value).replace(/\\n/g, '\n');
}

function envConfig() {
  const config = {
    appId: text(process.env.ALIPAY_APP_ID),
    privateKey: keyText(process.env.ALIPAY_PRIVATE_KEY),
    alipayPublicKey: keyText(process.env.ALIPAY_PUBLIC_KEY),
    gateway: text(process.env.ALIPAY_GATEWAY) || SANDBOX_GATEWAY,
    sellerId: text(process.env.ALIPAY_SELLER_ID),
    sellerEmail: text(process.env.ALIPAY_SELLER_EMAIL),
  };
  if (!config.appId || !config.privateKey || !config.alipayPublicKey) return null;
  return config;
}

function loadConfig() {
  const fromEnv = envConfig();
  if (fromEnv) return fromEnv;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new PaymentConfigError(`支付配置不可用：未找到有效的 ${path.basename(configPath)}（沙箱配置待完成）`);
  }
  const app = Array.isArray(raw.appIds) && raw.appIds[0] ? raw.appIds[0] : raw;
  const merchant = raw.sandboxAccounts && raw.sandboxAccounts.merchant ? raw.sandboxAccounts.merchant : {};
  const config = {
    appId: text(app.appId),
    privateKey: text(app.appPrivatePkcsKey) || text(app.privateKey),
    alipayPublicKey: text(app.alipayPublicKey),
    gateway: text(process.env.ALIPAY_GATEWAY) || text(raw.gateway) || SANDBOX_GATEWAY,
    sellerId: text(merchant.userId) || text(raw.sellerId),
    sellerEmail: text(merchant.email) || text(raw.sellerEmail),
  };
  const missing = ['appId', 'privateKey', 'alipayPublicKey', 'gateway'].filter((key) => !config[key]);
  if (missing.length) {
    throw new PaymentConfigError(`支付配置不可用：缺少字段 ${missing.join('、')}`);
  }
  return config;
}

function getConfig() {
  if (!cached) {
    cached = { config: loadConfig(), sdk: null };
  }
  if (!cached.sdk) {
    const { config } = cached;
    cached.sdk = new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      alipayPublicKey: config.alipayPublicKey,
      gateway: config.gateway,
      signType: 'RSA2',
    });
  }
  return cached;
}

function getSdk() {
  return getConfig().sdk;
}

module.exports = { getConfig, getSdk, configPath, projectRoot, SANDBOX_GATEWAY, PaymentConfigError };
