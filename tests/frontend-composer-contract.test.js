'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const composer = fs.readFileSync(path.join(root, 'frontend/src/components/Composer.vue'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'frontend/src/styles.css'), 'utf8');

for (const label of ['插入表情', '发送表情包', '发送图片', '发送文件']) {
  assert.ok(composer.includes(`aria-label="${label}"`), `composer is missing ${label}`);
}

assert.match(composer, /addFiles\([^\n]+, 'sticker'\)/, 'sticker files must keep sticker kind');
assert.match(composer, /addFiles\([^\n]+, 'image'\)/, 'image files must keep image kind');
assert.match(composer, /document\.addEventListener\('pointerdown', handleDocumentPointerDown\)/, 'emoji panel must listen for outside pointer events');
assert.match(composer, /emojiPanelRef\.value\?\.contains\(target\)/, 'emoji panel must ignore its own pointer events');
assert.match(styles, /\.message-row\.outbound\s*\{[^}]*flex-direction:\s*row-reverse;[^}]*justify-content:\s*flex-start;/s, 'outbound message group must align to the right');
assert.match(styles, /\.message-scroll\s*\{[^}]*background:\s*linear-gradient\(180deg, #f8f9fb 0%, #f3f5f8 100%\)/s, 'message canvas must use the neutral background');

console.log('[frontend] composer media controls and outbound alignment verified');
