const fs = require('fs');
const htmlPath = 'd:/代码文件/whatsapp-monitor/whatsapp-monitor/public/index.html';
const cssPath = 'd:/代码文件/whatsapp-monitor/whatsapp-monitor/public/clay.css';

let html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

// Replace the contents inside <style>...</style>
const regex = /<style>[\s\S]*?<\/style>/;
html = html.replace(regex, `<style>\n${css}\n</style>`);

fs.writeFileSync(htmlPath, html, 'utf8');
console.log('CSS successfully injected!');
