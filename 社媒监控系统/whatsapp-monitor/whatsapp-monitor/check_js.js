const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('<script>') + 8;
const end   = html.lastIndexOf('</script>');
const js = html.slice(start, end);
console.log('JS 长度:', js.length);
try {
  new vm.Script(js);
  console.log('✅ JS 语法正确！');
} catch(e) {
  console.log('❌ 语法错误:', e.message, '行:', e.lineNumber);
}
