const express = require('express');
const { getConfig } = require('./alipay');
const ops = require('./alipay-ops');
const orders = require('./orders');
const { parseCookies } = require('./session');

const router = express.Router();

router.get('/pay/return', async (req, res) => {
  const params = { ...req.query };
  if (!params.out_trade_no || !params.sign) return res.type('html').send(neutralPage());

  try {
    if (params.app_id !== getConfig().config.appId || !ops.notifySignValid(params)) {
      return res.type('html').send(neutralPage());
    }
  } catch (error) {
    return res.type('html').send(neutralPage());
  }

  const sid = parseCookies(req.headers.cookie).gift_sid;
  const order = await orders.getOrder(params.out_trade_no);
  if (!sid || !order || order.sessionId !== sid) return res.type('html').send(neutralPage());

  res.type('html').send(confirmingPage(order.outTradeNo));
});

function shell(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fdf7ee;color:#4a3728;font:16px/1.7 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 12px}#state a{display:inline-block;margin-top:8px;color:#8a2f3d;word-break:break-all}#state button{margin-top:14px;padding:10px 18px;border:1px solid #8a2f3d;background:#8a2f3d;color:#fff;border-radius:3px;font:inherit;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;
}

function neutralPage() {
  return shell('订单状态', '<h1>无法确认订单</h1><p>当前页面没有匹配的订单信息，请回到下单页面查看支付结果。</p>');
}

function confirmingPage(outTradeNo) {
  const outTradeNoJson = JSON.stringify(outTradeNo);
  return shell('正在确认支付结果', `<h1>正在确认支付结果</h1><p id="state">正在向支付宝查询，请稍候…</p>
<script>
(function(){
  var outTradeNo=${outTradeNoJson};
  var attempts=0;
  var el=document.getElementById('state');
  function run(){
    attempts+=1;
    fetch('/api/orders/'+encodeURIComponent(outTradeNo)+'/query',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,data:d}})})
      .then(function(result){
        if(!result.ok){
          if(attempts<3){setTimeout(run,2000);return;}
          el.textContent=(result.data&&result.data.error)||'暂时无法确认支付结果，请稍后在订单页查询。';
          return;
        }
        var state=result.data.localState;
        if(state==='PAID'){
          if(result.data.giftUrl){
            var url=result.data.giftUrl;
            el.textContent='支付成功，专属链接已经生成。';
            var link=document.createElement('a');
            link.href=url;link.textContent=url;
            var copy=document.createElement('button');
            copy.type='button';copy.textContent='复制链接';
            copy.onclick=function(){
              var button=this;
              navigator.clipboard.writeText(url).then(function(){button.textContent='已复制'},function(){button.textContent='复制失败，请手动选择'});
            };
            el.append(document.createElement('br'),link,document.createElement('br'),copy);
            return;
          }
          el.textContent='支付成功，感谢你的心意。';
          return;
        }
        el.textContent=state==='CLOSED'?'订单已关闭。':state==='PENDING_PAYMENT'?'尚未完成支付，可返回重新支付。':'支付结果待确认，请稍后在订单页再次查询。';
      })
      .catch(function(){
        if(attempts<3){setTimeout(run,2000);return;}
        el.textContent='暂时无法确认支付结果，请稍后在订单页查询。';
      });
  }
  run();
})();
</script>`);
}

module.exports = { returnRouter: router };
