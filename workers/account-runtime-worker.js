'use strict';

const fs = require('fs');
const path = require('path');

const { ensureRawDb, upsertRawMessage, upsertServiceAccountProfile } = require('../db/raw-db');
const { openRuntimeDb } = require('../db/runtime-db');
const { openWorkbenchDb } = require('../db/workbench-db');
const { resolveDataDir } = require('../db/paths');
const {
  ensureAccountDatabases,
  normalizeAccountPlatform,
  sanitizeAccountSegment,
} = require('../db/account-db');
const { createOutboundConsumer } = require('../lib/outbound-consumer');
const {
  readAndClearChannelSyncRequests,
  replaceChannelSnapshot,
} = require('../lib/channel-sync-store');

process.env.WORKBENCH_ACCOUNT_DB_MODE = process.env.WORKBENCH_ACCOUNT_DB_MODE || 'isolated';
process.env.WORKBENCH_WORKER_ROLE = process.env.WORKBENCH_WORKER_ROLE || 'account-runtime';

const DATA_DIR = resolveDataDir();
const PLATFORM = normalizeAccountPlatform(process.env.WORKBENCH_WORKER_PLATFORM || process.env.WORKBENCH_PLATFORM);
const ACCOUNT = String(process.env.WORKBENCH_WORKER_ACCOUNT || process.env.WORKBENCH_ACCOUNT || '').trim();
if (!['wa', 'tg'].includes(PLATFORM) || !ACCOUNT) {
  throw new Error('WORKBENCH_WORKER_PLATFORM and WORKBENCH_WORKER_ACCOUNT are required');
}

const ACCOUNT_PATHS = ensureAccountDatabases(PLATFORM, ACCOUNT);
const RAW_DB_PATH = path.resolve(process.env.WORKBENCH_ACCOUNT_RAW_DB_PATH || ACCOUNT_PATHS.rawDbPath);
const RUNTIME_DB_PATH = path.resolve(process.env.WORKBENCH_ACCOUNT_RUNTIME_DB_PATH || ACCOUNT_PATHS.runtimeDbPath);
const WORKBENCH_DB_PATH = path.resolve(process.env.WORKBENCH_ACCOUNT_WORKBENCH_DB_PATH || ACCOUNT_PATHS.workbenchDbPath);
const SESSION_DIR = path.resolve(process.env.WORKBENCH_ACCOUNT_SESSION_DIR || ACCOUNT_PATHS.sessionDir);
const OUTBOX_DIR = path.resolve(process.env.WORKBENCH_OUTBOX_DIR || path.join(DATA_DIR, 'outbox'));
const DISABLE_CHANNEL = process.env.WORKBENCH_ACCOUNT_RUNTIME_DISABLE_CHANNEL === '1';
const SEND_ENABLED = process.env.WORKBENCH_SEND_ENABLED === '1';
const CHAT_SYNC_ENABLED = process.env.WORKBENCH_CHAT_SYNC_ENABLED !== '0';
const SEND_POLL_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_SEND_POLL_MS, 2000, 500, 60000);
const HEARTBEAT_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_HEARTBEAT_MS, 10000, 1000, 120000);
const LEASE_TTL_MS = boundedNumber(process.env.WORKBENCH_WORKER_LEASE_TTL_MS, 45000, 15000, 300000);
const CHAT_SYNC_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_CHAT_SYNC_MS, 10 * 60 * 1000, 30000, 60 * 60 * 1000);
const WORKER_HOLDER_ID = process.env.HOSTNAME || `${process.pid}`;
const WORKER_RUN_ID = `${Date.now()}-${process.pid}`;
const STARTED_AT = new Date().toISOString();

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(OUTBOX_DIR, { recursive: true });

const rawDb = ensureRawDb(RAW_DB_PATH);
const runtimeDb = openRuntimeDb(RUNTIME_DB_PATH);
const workbenchDb = openWorkbenchDb(WORKBENCH_DB_PATH);

let stopping = false;
let channelClient = null;
let channelKind = '';
let channelReady = false;
let lastMessageAt = null;
let lastSyncAt = 0;

const outboundConsumer = createOutboundConsumer({
  db: workbenchDb,
  platform: PLATFORM,
  account: ACCOUNT,
  sendMessage: sendMessageViaChannel,
});

log(`started, account=${PLATFORM}:${ACCOUNT}, raw=${RAW_DB_PATH}, runtime=${RUNTIME_DB_PATH}, send=${SEND_ENABLED ? 'enabled' : 'disabled'}`);

start().catch((err) => {
  reportError('start_failed', err);
});

const heartbeatTimer = setInterval(() => {
  tick().catch((err) => reportError('tick_failed', err, { fatal: false }));
}, HEARTBEAT_MS);
const sendTimer = setInterval(() => {
  drainOutbound().catch((err) => reportError('send_loop_failed', err, { fatal: false }));
}, SEND_POLL_MS);

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function start() {
  renewLease();
  reportHeartbeat('starting', 'starting', '账号 runtime worker 正在启动');
  upsertProfile('starting');
  if (DISABLE_CHANNEL) {
    reportHeartbeat('disabled', 'idle', '账号 worker 已启动，渠道连接被环境变量关闭');
    return;
  }
  if (PLATFORM === 'wa') {
    await startWhatsAppRuntime();
    return;
  }
  await startTelegramRuntime();
}

async function tick() {
  if (stopping) return;
  renewLease();
  processSyncRequests();
  if (channelReady && Date.now() - lastSyncAt >= CHAT_SYNC_MS) {
    await syncChannelSnapshot('periodic');
  }
  reportHeartbeat(channelReady ? 'ready' : 'starting', channelReady ? 'monitoring' : 'starting', '');
}

async function drainOutbound() {
  if (stopping || !SEND_ENABLED || !channelReady) return;
  const result = await outboundConsumer.runOnce();
  if (result.status !== 'idle') {
    log(`outbound result ${JSON.stringify(result)}`);
  }
}

async function startWhatsAppRuntime() {
  let wa;
  try {
    wa = loadWhatsAppRuntime();
  } catch (err) {
    reportError('wa_dependency_missing', err);
    return;
  }

  const client = new wa.Client({
    authStrategy: new wa.LocalAuth({
      clientId: sanitizeAccountSegment(ACCOUNT),
      dataPath: SESSION_DIR,
      rmMaxRetries: 10,
    }),
    authTimeoutMs: boundedNumber(process.env.WORKBENCH_WA_AUTH_TIMEOUT_MS, 300000, 30000, 900000),
    qrMaxRetries: Number(process.env.WORKBENCH_WA_RUNTIME_QR_MAX_RETRIES || 0),
    puppeteer: buildChromeLaunchConfig(SESSION_DIR),
  });
  channelKind = 'wa';
  channelClient = client;

  client.on('qr', () => {
    channelReady = false;
    upsertProfile('requires_login');
    reportHeartbeat('waiting_login', 'qr_required', 'WA 账号需要重新扫码登录');
    recordRuntimeEvent('wa_qr_required', 'warning', 'WA runtime 发现账号需要重新扫码');
  });

  client.on('authenticated', () => {
    reportHeartbeat('authenticated', 'authenticating', 'WA session 已认证，等待 ready');
  });

  client.on('ready', async () => {
    channelReady = true;
    const displayName = client.info?.pushname || client.info?.wid?.user || ACCOUNT;
    upsertProfile('ready', displayName);
    reportHeartbeat('ready', 'monitoring', `WA runtime 已接管：${displayName}`);
    recordRuntimeEvent('account_ready', 'info', `WA 账号已接管：${displayName}`);
    await syncChannelSnapshot('ready').catch((err) => reportError('wa_sync_failed', err, { fatal: false }));
  });

  client.on('message', (message) => {
    handleWaMessage(message).catch((err) => reportError('wa_message_failed', err, { fatal: false }));
  });
  client.on('message_create', (message) => {
    handleWaMessage(message).catch((err) => reportError('wa_message_create_failed', err, { fatal: false }));
  });

  client.on('auth_failure', (message) => {
    channelReady = false;
    upsertProfile('auth_failed');
    reportError('wa_auth_failed', new Error(String(message || 'WA auth failure')));
  });

  client.on('disconnected', (reason) => {
    channelReady = false;
    if (stopping) return;
    upsertProfile('disconnected');
    reportHeartbeat('disconnected', 'disconnected', `WA 已断开：${reason || 'unknown'}`);
    recordRuntimeEvent('wa_disconnected', 'warning', `WA 已断开：${reason || 'unknown'}`);
  });

  await client.initialize();
}

async function startTelegramRuntime() {
  const credential = readTgCredential();
  if (!credential) {
    upsertProfile('requires_login');
    reportHeartbeat('waiting_login', 'credential_missing', 'TG 账号缺少已接管的 token/session');
    return;
  }
  if (credential.login_mode === 'tg_bot_token' && credential.token) {
    await startTelegramBotRuntime(credential);
    return;
  }
  if (credential.login_mode === 'tg_user_session' && credential.session) {
    await startTelegramUserRuntime(credential);
    return;
  }
  upsertProfile('requires_login');
  reportHeartbeat('waiting_login', 'credential_unsupported', 'TG 登录凭据类型暂不支持 runtime 接管');
}

async function startTelegramBotRuntime(credential) {
  let TelegramBot;
  try {
    TelegramBot = require('node-telegram-bot-api');
  } catch (err) {
    reportError('tg_bot_dependency_missing', err);
    return;
  }
  const bot = new TelegramBot(credential.token, {
    polling: {
      interval: boundedNumber(process.env.WORKBENCH_TG_BOT_POLL_MS, 2000, 500, 60000),
      autoStart: true,
    },
  });
  channelKind = 'tg-bot';
  channelClient = bot;
  bot.on('message', (message) => {
    handleTgBotMessage(message).catch((err) => reportError('tg_bot_message_failed', err, { fatal: false }));
  });
  bot.on('polling_error', (err) => {
    reportError('tg_bot_polling_error', err, { fatal: false });
  });
  try {
    const me = await bot.getMe();
    channelReady = true;
    const displayName = me.first_name + (me.username ? ` (@${me.username})` : '');
    upsertProfile('ready', displayName || credential.display_name || ACCOUNT);
    reportHeartbeat('ready', 'monitoring', `TG Bot runtime 已接管：${displayName || ACCOUNT}`);
    recordRuntimeEvent('account_ready', 'info', `TG Bot 已接管：${displayName || ACCOUNT}`);
  } catch (err) {
    reportError('tg_bot_ready_failed', err);
  }
}

async function startTelegramUserRuntime(credential) {
  const accountKey = ACCOUNT.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const apiId = Number(
    process.env[`WORKBENCH_TG_API_ID_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_ID ||
    process.env.TG_API_ID ||
    0
  );
  const apiHash =
    process.env[`WORKBENCH_TG_API_HASH_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_HASH ||
    process.env.TG_API_HASH ||
    '';
  if (!apiId || !apiHash) {
    reportError('tg_user_api_missing', new Error('WORKBENCH_TG_API_ID / WORKBENCH_TG_API_HASH 未配置'));
    return;
  }

  let TelegramClient;
  let StringSession;
  let NewMessage;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
    ({ NewMessage } = require('telegram/events'));
  } catch (err) {
    reportError('tg_user_dependency_missing', err);
    return;
  }

  const client = new TelegramClient(new StringSession(credential.session), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false,
  });
  channelKind = 'tg-user';
  channelClient = client;
  try {
    await client.connect();
    const me = await client.getMe();
    channelReady = true;
    const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || ACCOUNT;
    upsertProfile('ready', displayName);
    reportHeartbeat('ready', 'monitoring', `TG 用户 runtime 已接管：${displayName}`);
    recordRuntimeEvent('account_ready', 'info', `TG 用户账号已接管：${displayName}`);
    client.addEventHandler((event) => {
      handleTgUserEvent(event).catch((err) => reportError('tg_user_message_failed', err, { fatal: false }));
    }, new NewMessage({}));
    await syncChannelSnapshot('ready').catch((err) => reportError('tg_user_sync_failed', err, { fatal: false }));
  } catch (err) {
    channelReady = false;
    reportError('tg_user_ready_failed', err);
  }
}

async function handleWaMessage(message) {
  if (!message || !message.id) return;
  const chat = await message.getChat().catch(() => null);
  const contact = await message.getContact().catch(() => null);
  const chatId = chat?.id?._serialized || message.from || message.to || '';
  const nativeMessageId = message.id?._serialized || message.id?.id || `${chatId}:${message.timestamp || Date.now()}`;
  const messageId = nativeMessageId.includes(chatId) ? nativeMessageId : `${chatId}:${nativeMessageId}`;
  const raw = {
    platform: 'wa',
    id: message.id,
    from: message.from,
    to: message.to,
    author: message.author,
    fromMe: Boolean(message.fromMe),
    type: message.type,
    timestamp: message.timestamp,
    hasMedia: Boolean(message.hasMedia),
    direction: message.fromMe ? 'outbound' : 'inbound',
  };
  const rowId = upsertRawMessage({
    db: rawDb,
    platform: 'wa',
    account: ACCOUNT,
    messageId,
    groupId: chatId,
    groupName: chat?.name || chat?.formattedTitle || chatId,
    senderId: message.author || message.from || '',
    senderName: contact?.pushname || contact?.name || contact?.number || '',
    content: message.body || '',
    hasMedia: message.hasMedia ? 1 : 0,
    timestamp: message.timestamp,
    rawData: raw,
    nativeChatId: chatId,
    nativeMessageId,
  });
  lastMessageAt = new Date().toISOString();
  reportHeartbeat('ready', 'message', `WA message ${rowId}`);
}

async function handleTgBotMessage(message) {
  if (!message || !message.chat || !message.message_id) return;
  const chatId = String(message.chat.id);
  const sender = message.from || {};
  const messageId = `${chatId}:${message.message_id}`;
  const groupName = message.chat.title || message.chat.username || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || chatId;
  const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || String(sender.id || '');
  const rowId = upsertRawMessage({
    db: rawDb,
    platform: 'tg',
    account: ACCOUNT,
    messageId,
    groupId: chatId,
    groupName,
    senderId: String(sender.id || ''),
    senderName,
    content: message.text || message.caption || '',
    hasMedia: hasTelegramMedia(message) ? 1 : 0,
    timestamp: message.date,
    rawData: { ...message, direction: sender.is_bot ? 'outbound' : 'inbound' },
    nativeChatId: chatId,
    nativeMessageId: String(message.message_id),
  });
  lastMessageAt = new Date().toISOString();
  reportHeartbeat('ready', 'message', `TG bot message ${rowId}`);
}

async function handleTgUserEvent(event) {
  const message = event && (event.message || event);
  if (!message || !message.id) return;
  const chatId = stringifyTelegramId(message.chatId || message.peerId || message.inputChat || message.senderId || '');
  if (!chatId) return;
  const senderId = stringifyTelegramId(message.senderId || message.fromId || '');
  const messageId = `${chatId}:${message.id}`;
  const rowId = upsertRawMessage({
    db: rawDb,
    platform: 'tg',
    account: ACCOUNT,
    messageId,
    groupId: chatId,
    groupName: chatId,
    senderId,
    senderName: senderId,
    content: message.message || '',
    hasMedia: message.media ? 1 : 0,
    timestamp: message.date ? Number(message.date) : undefined,
    rawData: {
      id: String(message.id),
      chatId,
      senderId,
      out: Boolean(message.out),
      direction: message.out ? 'outbound' : 'inbound',
    },
    nativeChatId: chatId,
    nativeMessageId: String(message.id),
  });
  lastMessageAt = new Date().toISOString();
  reportHeartbeat('ready', 'message', `TG user message ${rowId}`);
}

async function sendMessageViaChannel(task) {
  if (!SEND_ENABLED) {
    throw Object.assign(new Error('WORKBENCH_SEND_ENABLED is not enabled'), { code: 'SEND_DISABLED' });
  }
  if (!channelReady || !channelClient) {
    throw Object.assign(new Error('channel runtime is not ready'), { code: 'CHANNEL_NOT_READY' });
  }
  const attachments = parseTaskAttachments(task);
  if (PLATFORM === 'wa') {
    return sendWhatsAppTask(task, attachments);
  }
  if (channelKind === 'tg-bot') {
    return sendTelegramBotTask(task, attachments);
  }
  return sendTelegramUserTask(task, attachments);
}

async function sendWhatsAppTask(task, attachments) {
  const chatId = task.chat_id || task.group_id;
  if (!attachments.length) {
    const sent = await channelClient.sendMessage(chatId, task.text || '');
    return { remote_msg_id: whatsappMessageId(sent) };
  }
  let lastMessageId = '';
  const { MessageMedia } = require('whatsapp-web.js');
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const media = new MessageMedia(attachment.type, attachment.base64, attachment.name);
    const options = index === 0 && task.text ? { caption: task.text } : undefined;
    const sent = await channelClient.sendMessage(chatId, media, options);
    lastMessageId = whatsappMessageId(sent) || lastMessageId;
  }
  return { remote_msg_id: lastMessageId };
}

async function sendTelegramBotTask(task, attachments) {
  const chatId = task.chat_id || task.group_id;
  if (!attachments.length) {
    const sent = await channelClient.sendMessage(chatId, task.text || '');
    return { remote_msg_id: telegramMessageId(sent) };
  }
  let lastMessageId = '';
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const caption = index === 0 && task.text ? task.text : undefined;
    const options = caption ? { caption } : {};
    const fileOptions = { filename: attachment.name, contentType: attachment.type };
    let sent;
    if (attachment.kind === 'sticker') {
      sent = await channelClient.sendSticker(chatId, attachment.buffer, {}, fileOptions);
    } else if (attachment.type.startsWith('image/') && attachment.kind !== 'file') {
      sent = await channelClient.sendPhoto(chatId, attachment.buffer, options, fileOptions);
    } else {
      sent = await channelClient.sendDocument(chatId, attachment.buffer, options, fileOptions);
    }
    lastMessageId = telegramMessageId(sent) || lastMessageId;
  }
  return { remote_msg_id: lastMessageId };
}

async function sendTelegramUserTask(task, attachments) {
  const chatId = task.chat_id || task.group_id;
  if (!attachments.length) {
    const sent = await channelClient.sendMessage(chatId, { message: task.text || '' });
    return { remote_msg_id: telegramMessageId(sent) };
  }
  if (typeof channelClient.sendFile !== 'function') {
    throw Object.assign(new Error('Telegram user attachment sending is not supported by this runtime'), { code: 'ATTACHMENT_UNSUPPORTED' });
  }
  let lastMessageId = '';
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const sent = await channelClient.sendFile(chatId, {
      file: attachment.buffer,
      caption: index === 0 ? task.text || '' : '',
      fileName: attachment.name,
      forceDocument: attachment.kind === 'file',
    });
    lastMessageId = telegramMessageId(sent) || lastMessageId;
  }
  return { remote_msg_id: lastMessageId };
}

function parseTaskAttachments(task) {
  if (!task || !task.attachment_json) return [];
  let parsed;
  try {
    parsed = JSON.parse(task.attachment_json);
  } catch (err) {
    throw Object.assign(new Error('attachment_json is invalid'), { code: 'ATTACHMENT_INVALID' });
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(Boolean).map(decodeAttachment);
}

function decodeAttachment(attachment) {
  const dataUrl = String(attachment.data_url || attachment.dataUrl || '').trim();
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) {
    throw Object.assign(new Error('attachment data_url is missing or invalid'), { code: 'ATTACHMENT_DATA_INVALID' });
  }
  const type = String(attachment.type || match[1] || 'application/octet-stream').trim() || 'application/octet-stream';
  const base64 = String(match[2] || '').replace(/\s/g, '');
  if (!base64) {
    throw Object.assign(new Error('attachment data is empty'), { code: 'ATTACHMENT_DATA_EMPTY' });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    throw Object.assign(new Error('attachment decoded to empty file'), { code: 'ATTACHMENT_DATA_EMPTY' });
  }
  return {
    id: attachment.id,
    name: String(attachment.name || 'attachment').replace(/[\\/\r\n]/g, '_').slice(0, 180) || 'attachment',
    type,
    kind: String(attachment.kind || (type.startsWith('image/') ? 'image' : 'file')).trim().toLowerCase(),
    base64,
    buffer,
  };
}

function whatsappMessageId(sent) {
  return sent?.id?._serialized || sent?.id?.id || '';
}

function telegramMessageId(sent) {
  return String(sent?.message_id || sent?.id || '');
}

function processSyncRequests() {
  const requests = readAndClearChannelSyncRequests(OUTBOX_DIR, PLATFORM, ACCOUNT);
  if (!requests.length || !channelReady) return;
  syncChannelSnapshot(requests[requests.length - 1].reason || 'manual')
    .catch((err) => reportError('manual_sync_failed', err, { fatal: false }));
}

async function syncChannelSnapshot(reason) {
  if (!CHAT_SYNC_ENABLED || !channelReady || !channelClient) return null;
  if (PLATFORM === 'wa' && typeof channelClient.getChats === 'function') {
    const chats = await channelClient.getChats();
    const groups = chats.map((chat) => ({
      group_id: chat.id?._serialized || chat.id?.user || chat.name || '',
      group_name: chat.name || chat.formattedTitle || chat.id?._serialized || '未命名会话',
      kind: chat.isGroup ? 'group' : 'chat',
      raw_json: {
        id: chat.id,
        isGroup: Boolean(chat.isGroup),
        unreadCount: chat.unreadCount || 0,
        pinned: Boolean(chat.pinned),
      },
    })).filter((group) => group.group_id);
    const result = replaceChannelSnapshot({
      db: workbenchDb,
      platform: PLATFORM,
      account: ACCOUNT,
      groups,
    });
    lastSyncAt = Date.now();
    reportHeartbeat('ready', 'sync', `WA 群列表已同步：${result.group_count}`);
    recordRuntimeEvent('channel_sync', 'info', `WA 群列表已同步：${result.group_count}`, { reason, ...result });
    return result;
  }
  if (PLATFORM === 'tg' && channelClient.getDialogs && typeof channelClient.getDialogs === 'function') {
    const dialogs = await channelClient.getDialogs({ limit: Number(process.env.WORKBENCH_TG_DIALOG_SYNC_LIMIT || 500) });
    const groups = dialogs.map((dialog) => {
      const entity = dialog.entity || {};
      const id = stringifyTelegramId(entity.id || dialog.id || dialog.inputEntity || '');
      return {
        group_id: id,
        group_name: entity.title || entity.username || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || id,
        kind: entity.megagroup || entity.broadcast || entity.className === 'Channel' ? 'group' : 'chat',
        raw_json: {
          id,
          className: entity.className,
          unreadCount: dialog.unreadCount || 0,
        },
      };
    }).filter((group) => group.group_id);
    const result = replaceChannelSnapshot({
      db: workbenchDb,
      platform: PLATFORM,
      account: ACCOUNT,
      groups,
      labels: [],
      maps: [],
    });
    lastSyncAt = Date.now();
    reportHeartbeat('ready', 'sync', `TG 会话列表已同步：${result.group_count}`);
    recordRuntimeEvent('channel_sync', 'info', `TG 会话列表已同步：${result.group_count}`, { reason, ...result });
    return result;
  }
  return null;
}

function readTgCredential() {
  const filePath = path.join(SESSION_DIR, `${sanitizeAccountSegment(ACCOUNT)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadWhatsAppRuntime() {
  const vanillaPuppeteer = require('puppeteer');
  try {
    const { PuppeteerExtra } = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    const puppeteer = new PuppeteerExtra(vanillaPuppeteer);
    puppeteer.use(StealthPlugin());
    require.cache[require.resolve('puppeteer')] = { exports: puppeteer };
  } catch (err) {
    log(`puppeteer stealth plugin unavailable, continuing with vanilla puppeteer: ${err.message}`);
  }
  return require('whatsapp-web.js');
}

function buildChromeLaunchConfig(sessionDir) {
  const executablePath = existingPath(process.env.PUPPETEER_EXECUTABLE_PATH) ||
    existingPath('/usr/bin/chromium') ||
    existingPath('/usr/bin/google-chrome') ||
    undefined;
  const chromeStateDir = path.join(sessionDir, '.chromium');
  const xdgConfigDir = path.join(chromeStateDir, 'config');
  const xdgCacheDir = path.join(chromeStateDir, 'cache');
  const xdgRuntimeDir = path.join(chromeStateDir, 'runtime');
  fs.mkdirSync(xdgConfigDir, { recursive: true });
  fs.mkdirSync(xdgCacheDir, { recursive: true });
  fs.mkdirSync(xdgRuntimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(xdgRuntimeDir, 0o700);
  return {
    headless: true,
    executablePath,
    pipe: true,
    timeout: boundedNumber(process.env.WORKBENCH_WA_PUPPETEER_TIMEOUT_MS, 120000, 30000, 900000),
    protocolTimeout: boundedNumber(process.env.WORKBENCH_WA_PUPPETEER_PROTOCOL_TIMEOUT_MS, 120000, 30000, 900000),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigDir,
      XDG_CACHE_HOME: xdgCacheDir,
      XDG_RUNTIME_DIR: xdgRuntimeDir,
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AudioServiceOutOfProcess',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--disable-hang-monitor',
      '--renderer-process-limit=4',
      '--process-per-site',
      '--no-zygote',
      '--disable-site-isolation-trials',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=1280,960',
    ],
  };
}

function renewLease() {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  runtimeDb.prepare(`
    INSERT INTO account_worker_leases (
      platform, account, lease_name, holder_id, worker_role, run_id, pid,
      acquired_at, renewed_at, expires_at, metadata_json
    )
    VALUES (
      @platform, @account, 'account-runtime', @holderId, 'account-runtime', @runId, @pid,
      @now, @now, @expiresAt, @metadataJson
    )
    ON CONFLICT(platform, account, lease_name) DO UPDATE SET
      holder_id = excluded.holder_id,
      worker_role = excluded.worker_role,
      run_id = excluded.run_id,
      pid = excluded.pid,
      renewed_at = excluded.renewed_at,
      expires_at = excluded.expires_at,
      metadata_json = excluded.metadata_json
  `).run({
    platform: PLATFORM,
    account: ACCOUNT,
    holderId: WORKER_HOLDER_ID,
    runId: WORKER_RUN_ID,
    pid: process.pid,
    now: nowIso,
    expiresAt,
    metadataJson: JSON.stringify({
      raw_db_path: RAW_DB_PATH,
      workbench_db_path: WORKBENCH_DB_PATH,
      runtime_db_path: RUNTIME_DB_PATH,
      session_dir: SESSION_DIR,
      send_enabled: SEND_ENABLED,
      chat_sync_enabled: CHAT_SYNC_ENABLED,
    }),
  });
}

function releaseLease() {
  try {
    runtimeDb.prepare(`
      DELETE FROM account_worker_leases
      WHERE platform = @platform
        AND account = @account
        AND lease_name = 'account-runtime'
        AND holder_id = @holderId
        AND run_id = @runId
    `).run({
      platform: PLATFORM,
      account: ACCOUNT,
      holderId: WORKER_HOLDER_ID,
      runId: WORKER_RUN_ID,
    });
  } catch (err) {
    log(`failed to release lease: ${err.message}`);
  }
}

function reportHeartbeat(status, phase, message) {
  runtimeDb.prepare(`
    INSERT INTO collector_heartbeats (
      account_id, platform, collector_id, run_id, status, phase, health_status,
      last_error, last_ready_at, last_message_at, started_at, updated_at
    )
    VALUES (
      @accountId, @platform, @collectorId, @runId, @status, @phase, @healthStatus,
      @lastError, @lastReadyAt, @lastMessageAt, @startedAt, CURRENT_TIMESTAMP
    )
    ON CONFLICT(account_id, collector_id) DO UPDATE SET
      run_id = excluded.run_id,
      status = excluded.status,
      phase = excluded.phase,
      health_status = excluded.health_status,
      last_error = excluded.last_error,
      last_ready_at = COALESCE(excluded.last_ready_at, collector_heartbeats.last_ready_at),
      last_message_at = COALESCE(excluded.last_message_at, collector_heartbeats.last_message_at),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    accountId: `${PLATFORM}-${ACCOUNT}`,
    platform: PLATFORM,
    collectorId: `workbench-account:${PLATFORM}:${ACCOUNT}`,
    runId: WORKER_RUN_ID,
    status,
    phase,
    healthStatus: status,
    lastError: status === 'error' ? String(message || '') : '',
    lastReadyAt: status === 'ready' ? new Date().toISOString() : null,
    lastMessageAt: lastMessageAt,
    startedAt: STARTED_AT,
  });
}

function reportError(type, err, { fatal = true } = {}) {
  const error = err instanceof Error ? err : new Error(String(err || 'unknown error'));
  if (fatal) {
    channelReady = false;
    upsertProfile('error');
  }
  reportHeartbeat(fatal ? 'error' : (channelReady ? 'ready' : 'warning'), type, error.message);
  recordRuntimeEvent(type, 'error', error.message, { stack: error.stack });
  log(`${type}: ${error.stack || error.message}`);
}

function recordRuntimeEvent(eventType, severity, message, data = null) {
  runtimeDb.prepare(`
    INSERT INTO runtime_events (account_id, platform, source, event_type, severity, message, data_json)
    VALUES (@accountId, @platform, 'account-runtime', @eventType, @severity, @message, @dataJson)
  `).run({
    accountId: `${PLATFORM}-${ACCOUNT}`,
    platform: PLATFORM,
    eventType,
    severity,
    message,
    dataJson: data ? safeJson(data) : null,
  });
}

function upsertProfile(status, displayName) {
  upsertServiceAccountProfile({
    dbPath: RAW_DB_PATH,
    platform: PLATFORM,
    account: ACCOUNT,
    displayName: displayName || ACCOUNT,
    loginType: PLATFORM === 'wa' ? 'wa_qr' : 'tg_runtime',
    status,
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping');
  clearInterval(heartbeatTimer);
  clearInterval(sendTimer);
  releaseLease();
  try {
    if (PLATFORM === 'wa' && channelClient && typeof channelClient.destroy === 'function') {
      await channelClient.destroy();
    } else if (channelClient && typeof channelClient.close === 'function') {
      await channelClient.close();
    } else if (channelClient && typeof channelClient.disconnect === 'function') {
      await channelClient.disconnect();
    }
  } catch (err) {
    log(`channel shutdown failed: ${err.message}`);
  }
  outboundConsumer.close();
  rawDb.close();
  runtimeDb.close();
  workbenchDb.close();
  process.exit(0);
}

function hasTelegramMedia(message) {
  return Boolean(message.photo || message.document || message.video || message.voice || message.audio || message.sticker);
}

function stringifyTelegramId(value) {
  if (!value) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    if (value.value !== undefined) return String(value.value);
    if (value.userId !== undefined) return stringifyTelegramId(value.userId);
    if (value.chatId !== undefined) return stringifyTelegramId(value.chatId);
    if (value.channelId !== undefined) return stringifyTelegramId(value.channelId);
    if (value.id !== undefined) return stringifyTelegramId(value.id);
  }
  return String(value);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ unserializable: true });
  }
}

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function existingPath(filePath) {
  return filePath && fs.existsSync(filePath) ? filePath : '';
}

function log(message) {
  console.log(`[workbench-account-worker ${PLATFORM}:${ACCOUNT}] ${message}`);
}
