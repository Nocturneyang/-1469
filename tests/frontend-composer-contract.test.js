'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const composer = fs.readFileSync(path.join(root, 'frontend/src/components/Composer.vue'), 'utf8');
const thread = fs.readFileSync(path.join(root, 'frontend/src/components/MessageThread.vue'), 'utf8');
const conversationList = fs.readFileSync(path.join(root, 'frontend/src/components/ConversationList.vue'), 'utf8');
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
assert.match(app, /const AUTO_REFRESH_MS = 30000;/, 'polling must be a low-frequency realtime fallback');
assert.match(app, /const PENDING_REFRESH_MS = 30000;/, 'pending status polling must remain a low-frequency fallback');
assert.match(app, /function createOptimisticOutbound\(/, 'outbound messages must render optimistically');
assert.match(app, /visibilitychange.*handleVisibilityRefresh/, 'foreground conversations must refresh immediately');
assert.match(composer, /props\.group\.global_send_enabled === true/, 'composer must honor the global send switch');
assert.match(composer, /!props\.group\.send_breaker_active/, 'composer must disable sending while the account breaker is active');
assert.ok(composer.includes('当前服务账号发送开关已关闭，请管理员在“服务账号”中开启'), 'composer must explain the account-level send switch');
assert.match(app, /groups\.value = groups\.value\.map\(/, 'service-account setting changes must update loaded conversations immediately');
assert.match(api, /new window\.EventSource\(/, 'active conversations must subscribe to server-sent realtime events');
assert.match(app, /subscribeConversationEvents\(/, 'the selected conversation must start a realtime subscription');
assert.match(api, /subscribeWorkbenchEvents/, 'the client must expose a global realtime subscription');
assert.match(app, /startWorkbenchEventStream\(\)/, 'the workbench must start the global realtime subscription');
assert.match(composer, /social-workbench\.drafts\.v1\./, 'text drafts must be isolated by operator');
assert.match(composer, /\(\) => `\$\{groupDraftKey\(\)\}\|\$\{String\(props\.operatorId \|\| ''\)\}`/, 'composer refresh guard must use a stable conversation key');
assert.doesNotMatch(composer, /\(\) => \[props\.group\?\.id/, 'same-conversation data refreshes must not clear selected attachments');
assert.match(composer, /defineExpose\(\{ clearDraft \}\)/, 'the parent must clear a draft only after the outbound task is created');
assert.match(thread, /\['sent', 'delivered', 'read'\]/, 'the message thread must recognize all three receipt states');
assert.match(styles, /\.delivery-receipt\.receipt-read\s*\{[^}]*color:/s, 'read receipts must expose a blue double-check state');
assert.match(app, /preserve_existing/, 'realtime refreshes must preserve already-loaded history');
assert.match(thread, /attachment\.media_url/, 'downloaded inbound media must be rendered from the authenticated media endpoint');
assert.ok(thread.includes('class="attachment-download"'), 'non-image attachments must expose a visible download action');
assert.ok(thread.includes('<Download />'), 'the attachment download action must include a recognizable icon');
assert.match(styles, /\.attachment-download\s*\{[^}]*display:\s*inline-flex;/s, 'the attachment download action must remain visible in the file card');
assert.match(thread, /loading="lazy"/, 'large image history must use lazy image decoding/loading');
assert.ok(thread.includes('次查看'), 'Telegram view counts must be visible');
assert.ok(thread.includes('转发自'), 'Telegram forward metadata must be visible');
assert.match(app, /function applyInstantLabelFilter\(/, 'label selection must filter the loaded conversation list immediately');
assert.match(app, /function applyInstantConversationFilter\(/, 'platform and account changes must filter the loaded conversation list immediately');
assert.match(app, /function groupMatchesFilterState\(/, 'instant conversation filtering must honor the active filter state');
assert.match(app, /groupListCache\.get\(groupFilterCacheKey\(nextBase\)\)/, 'instant label filtering must reuse the unfiltered group snapshot');
assert.match(app, /writeGroupListCache\(requestKey, nextGroups\)/, 'server results must refresh the exact filter cache');
assert.match(app, /function primeMessagePreview\(/, 'conversation selection must render the latest list message immediately');
assert.match(app, /function prefetchMessages\(/, 'conversation hover must prefetch the first message page');
assert.match(conversationList, /@mouseenter="schedulePrefetch\(group\)"/, 'conversation rows must schedule message prefetch on hover');
assert.match(app, /:loading-messages="loadingMessages"/, 'message loading progress must be visible in the thread');
assert.ok(thread.includes('正在加载完整消息记录'), 'the thread must explain that full history is still loading');
assert.match(styles, /\.message-loading-skeleton/, 'an empty first message page must show a loading skeleton');
assert.match(app, /const requestSeq = preserveExisting \? messageRequestSeq : \+\+messageRequestSeq;/, 'background refreshes must not invalidate the first message response');
assert.match(app, /if \(loadingMessages\.value\) return;/, 'background polling must yield to the first message request');
assert.match(app, /loadMessages\(restoredFromCache \? \{ preserve_existing: true \} : \{\}\)[\s\S]*?\.finally\(\(\) => \{[\s\S]*?loadWorkspace\(\)/, 'workspace details must load after the selected conversation message request');
assert.match(app, /const restoredFromCache = hydrateCachedMessages\(selectedGroup\.value\);/, 'conversation selection must detect a fully loaded cached message page');
assert.match(app, /loadMessages\(restoredFromCache \? \{ preserve_existing: true \} : \{\}\)/, 'returning to a conversation must preserve previously loaded history');
assert.match(app, /writeMessageCache\(cacheKey, nextMessages, nextPaging, \{ loaded: true \}\)/, 'successful message pages must mark the conversation cache as fully loaded');
assert.match(app, /return entry\.loaded === true;/, 'preview-only caches must not suppress the first full message load');
assert.match(thread, /el\.scrollTop <= TOP_LOAD_THRESHOLD_PX\) requestOlderMessages\(\)/, 'scrolling to the top must request older messages');
assert.match(thread, /el\.scrollHeight - snapshot\.scrollHeight/, 'prepending history must preserve the current reading position');
assert.match(thread, /shouldShowDateSeparator\(message, index\)/, 'message history must render a separator for every calendar day');
assert.match(thread, /formatMessageDateLabel\(messageTimeValue\(message\)\)/, 'date separators must not be hard-coded to today');
assert.doesNotMatch(styles, /\.composer-foot\s*\{[^}]*margin:\s*-\d/s, 'composer footer must not rely on negative margins');
assert.match(styles, /\.composer-foot > span\s*\{[^}]*position:\s*static;/s, 'composer account hint must stay in the normal footer layout');

console.log('[frontend] composer, realtime messages, media previews, first paint and instant label filtering verified');
