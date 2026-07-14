'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const composer = fs.readFileSync(path.join(root, 'frontend/src/components/Composer.vue'), 'utf8');
const thread = fs.readFileSync(path.join(root, 'frontend/src/components/MessageThread.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend/src/App.vue'), 'utf8');
const api = fs.readFileSync(path.join(root, 'frontend/src/api.js'), 'utf8');
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
assert.ok(thread.includes('class="message-footer"'), 'message status and actions must sit outside the bubble');
assert.match(styles, /\.outbound \.bubble\s*\{[^}]*background:\s*#95ec69;/s, 'outbound bubble must use the WeChat-style green');
assert.match(styles, /\.outbound \.bubble::after\s*\{[^}]*border-left:\s*8px solid #95ec69;/s, 'outbound bubble must expose the WeChat-style tail');
assert.match(app, /const AUTO_REFRESH_MS = 1500;/, 'active conversations must refresh near real time');
assert.match(app, /const PENDING_REFRESH_MS = 450;/, 'pending outbound status must refresh quickly');
assert.match(app, /function createOptimisticOutbound\(/, 'outbound messages must render optimistically');
assert.match(app, /visibilitychange.*handleVisibilityRefresh/, 'foreground conversations must refresh immediately');
assert.match(composer, /props\.group\.global_send_enabled === true/, 'composer must honor the global send switch');
assert.match(composer, /!props\.group\.send_breaker_active/, 'composer must disable sending while the account breaker is active');
assert.ok(composer.includes('当前服务账号发送开关已关闭，请管理员在“服务账号”中开启'), 'composer must explain the account-level send switch');
assert.match(app, /groups\.value = groups\.value\.map\(/, 'service-account setting changes must update loaded conversations immediately');
assert.match(api, /new window\.EventSource\(/, 'active conversations must subscribe to server-sent realtime events');
assert.match(app, /subscribeConversationEvents\(/, 'the selected conversation must start a realtime subscription');
assert.match(app, /preserve_existing/, 'realtime refreshes must preserve already-loaded history');
assert.match(thread, /attachment\.media_url/, 'downloaded inbound media must be rendered from the authenticated media endpoint');
assert.match(thread, /loading="lazy"/, 'large image history must use lazy image decoding/loading');
assert.ok(thread.includes('次查看'), 'Telegram view counts must be visible');
assert.ok(thread.includes('转发自'), 'Telegram forward metadata must be visible');

console.log('[frontend] composer, realtime subscription, media previews and message metadata verified');
