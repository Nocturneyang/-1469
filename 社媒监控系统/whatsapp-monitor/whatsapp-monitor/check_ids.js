const h = require('fs').readFileSync('public/index.html', 'utf8');
const checks = ['btn-logout','qr-area','wa-tag','wa-name','wa-phone','av-dot','sb-dot','sb-txt'];
checks.forEach(id => {
  console.log((h.includes('id="' + id + '"') ? '✅ ' : '❌ 缺失: ') + id);
});
