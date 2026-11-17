const path = require('path');
const express = require('express');
const { paymentRouter } = require('./src/payment-routes');
const { notifyRouter } = require('./src/notify-routes');
const { returnRouter } = require('./src/return-routes');
const { giftRouter } = require('./src/gift-routes');
const { PaymentConfigError } = require('./src/alipay');
const store = require('./src/store');

const app = express();
const port = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use('/api/gifts', express.json({ limit: store.enabled ? '12mb' : '60mb' }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use(giftRouter);
app.use('/api', paymentRouter);
app.use('/notify', notifyRouter);
app.use(returnRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const giftPage = process.env.GIFT_PAGE || path.join(__dirname, 'templates', 'birthday.html');
app.get('/', (req, res) => res.redirect('/gift'));
app.get('/gift', (req, res) => res.sendFile(giftPage));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof PaymentConfigError) {
    console.error(`[config] ${req.method} ${req.path}: ${error.message}`);
    return res.status(503).json({ error: '支付配置尚未就绪，请先完成沙箱配置。' });
  }
  const status = error.alipay ? 502 : 500;
  console.error(`[error] ${req.method} ${req.path}: ${error.message}`);
  res.status(status).json({ error: status === 502 ? '支付宝接口暂时不可用，请稍后重试' : '服务暂时不可用，请稍后重试' });
});

app.listen(port, () => {
  console.log(`Server on http://localhost:${port}`);
});
