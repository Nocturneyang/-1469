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
const { createOutboundConsumer, markProviderAckByRemoteId } = require('../lib/outbound-consumer');
const { recordChannelEvent } = require('../lib/channel-events');
const { installProcessGuards, logEvent } = require('../lib/runtime-observability');
const {
  clearResolvedOutboundDoorbells,
  createOutboundDoorbellWatcher,
  outboundDoorbellDir,
} = require('../lib/outbound-doorbell');
const {
  normalizeChannelLabelName,
  readAndClearChannelSyncRequests,
  replaceChannelSnapshot,
} = require('../lib/channel-sync-store');
const {
  buildChromeLaunchConfig,
  buildWaWebVersionOptions,
  enrichChromeLaunchError,
  prepareWaChromeProfile,
} = require('../lib/chrome-launch');
const { channelSyncRetryDelay } = require('../lib/channel-sync-retry');
const { readWhatsAppChatSnapshot } = require('../lib/wa-chat-snapshot');
const {
  detectImageMime,
  imageExtensionForMime,
  telegramEntityName,
  telegramMessageMetadata,
  telegramMessageText,
  telegramUserMediaDescriptor,
} = require('../lib/telegram-message');

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
const MEDIA_DIR = path.join(ACCOUNT_PATHS.accountDir, 'media');
const MEDIA_MAX_BYTES = boundedNumber(process.env.WORKBENCH_INBOUND_MEDIA_MAX_BYTES, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const OUTBOX_DIR = path.resolve(process.env.WORKBENCH_OUTBOX_DIR || path.join(DATA_DIR, 'outbox'));
const DISABLE_CHANNEL = process.env.WORKBENCH_ACCOUNT_RUNTIME_DISABLE_CHANNEL === '1';
const SEND_ENABLED = process.env.WORKBENCH_SEND_ENABLED === '1';
const CHAT_SYNC_ENABLED = process.env.WORKBENCH_CHAT_SYNC_ENABLED !== '0';
const SEND_POLL_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_SEND_POLL_MS, 500, 250, 60000);
const HEARTBEAT_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_HEARTBEAT_MS, 10000, 1000, 120000);
const LEASE_TTL_MS = boundedNumber(process.env.WORKBENCH_WORKER_LEASE_TTL_MS, 45000, 15000, 300000);
const CHAT_SYNC_MS = boundedNumber(process.env.WORKBENCH_ACCOUNT_WORKER_CHAT_SYNC_MS, 10 * 60 * 1000, 30000, 60 * 60 * 1000);
const CHANNEL_SYNC_RETRY_BASE_MS = boundedNumber(
  process.env.WORKBENCH_CHANNEL_SYNC_RETRY_BASE_MS,
  30000,
  1000,
  60 * 60 * 1000,
);
const CHANNEL_SYNC_RETRY_MAX_MS = boundedNumber(
  process.env.WORKBENCH_CHANNEL_SYNC_RETRY_MAX_MS,
  10 * 60 * 1000,
  CHANNEL_SYNC_RETRY_BASE_MS,
  24 * 60 * 60 * 1000,
);
const WORKER_HOLDER_ID = process.env.HOSTNAME || `${process.pid}`;
const WORKER_RUN_ID = `${Date.now()}-${process.pid}`;
const STARTED_AT = new Date().toISOString();

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(OUTBOX_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const OUTBOUND_DOORBELL_DIR = outboundDoorbellDir(OUTBOX_DIR, PLATFORM, ACCOUNT);
fs.mkdirSync(OUTBOUND_DOORBELL_DIR, { recursive: true });

const rawDb = ensureRawDb(RAW_DB_PATH);
const runtimeDb = openRuntimeDb(RUNTIME_DB_PATH);
const workbenchDb = openWorkbenchDb(WORKBENCH_DB_PATH);
let heartbeatTimer = null;
let sendTimer = null;

installProcessGuards({
  processName: 'account-runtime-worker',
  runtimeDb,
  shutdown: (reason, options) => shutdown(reason, options),
  context: { platform: PLATFORM, account: ACCOUNT, pid: process.pid },
});

let stopping = false;
let channelClient = null;
let channelKind = '';
let channelReady = false;
let lastMessageAt = null;
let lastSyncAt = 0;
let nextSyncAt = 0;
let syncFailureCount = 0;
let activeWaWebVersion = '';
let syncInFlight = false;
let outboundDrainInFlight = false;
let outboundDrainRequested = false;
let outboundDrainTimer = null;

const outboundConsumer = createOutboundConsumer({
  db: workbenchDb,
  platform: PLATFORM,
  account: ACCOUNT,
  sendMessage: sendMessageViaChannel,
  minIntervalMs: tightenedSendMinInterval(),
  perMinuteLimit: tightenedSendPerMinute(),
});
const outboundDoorbellWatcher = createOutboundDoorbellWatcher({
  directory: OUTBOUND_DOORBELL_DIR,
  onWake: () => scheduleOutboundDrain(15),
  onError: (err) => reportError('outbound_doorbell_watch_failed', err, { fatal: false }),
});

log(`started, account=${PLATFORM}:${ACCOUNT}, raw=${RAW_DB_PATH}, runtime=${RUNTIME_DB_PATH}, send=${SEND_ENABLED ? 'enabled' : 'disabled'}`);
const repairedInboundMedia = repairStoredInboundMediaMetadata();
if (repairedInboundMedia > 0) log(`repaired ${repairedInboundMedia} legacy inbound image metadata row(s)`);

start().catch((err) => {
  reportError('start_failed', err);
});

heartbeatTimer = setInterval(() => {
  tick().catch((err) => reportError('tick_failed', err, { fatal: false }));
}, HEARTBEAT_MS);
sendTimer = setInterval(() => {
  scheduleOutboundDrain(0);
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
  if (channelReady && Date.now() >= nextSyncAt) {
    await syncChannelSnapshot('periodic');
  }
  reportHeartbeat(channelReady ? 'ready' : 'starting', channelReady ? 'monitoring' : 'starting', '');
}

async function drainOutbound() {
  if (outboundDrainInFlight) {
    outboundDrainRequested = true;
    return;
  }
  if (stopping || !SEND_ENABLED || !channelReady || !accountSendEnabled()) return;
  outboundDrainInFlight = true;
  let drainAgain = false;
  try {
    const result = await outboundConsumer.runOnce();
    clearResolvedOutboundDoorbells({ directory: OUTBOUND_DOORBELL_DIR, db: workbenchDb });
    if (result.status !== 'idle') {
      log(`outbound result ${JSON.stringify(result)}`);
      recordOutboundStatusEvent(result.outbound_id);
    }
    drainAgain = !['idle', 'paused', 'rate_limited'].includes(result.status);
  } finally {
    outboundDrainInFlight = false;
    const requested = outboundDrainRequested;
    outboundDrainRequested = false;
    if (drainAgain || requested) scheduleOutboundDrain(0);
  }
}

function scheduleOutboundDrain(delayMs = 0) {
  if (stopping) return;
  const delay = Math.max(0, Number(delayMs) || 0);
  if (outboundDrainInFlight) {
    outboundDrainRequested = true;
    return;
  }
  if (outboundDrainTimer) {
    if (delay > 0) return;
    clearTimeout(outboundDrainTimer);
  }
  outboundDrainTimer = setTimeout(() => {
    outboundDrainTimer = null;
    drainOutbound().catch((err) => reportError('send_loop_failed', err, { fatal: false }));
  }, delay);
  outboundDrainTimer.unref?.();
}

function accountSendEnabled() {
  const row = rawDb.prepare(`
    SELECT send_enabled FROM channel_account_registry WHERE platform = ? AND account = ?
  `).get(PLATFORM, ACCOUNT);
  return Number(row?.send_enabled || 0) === 1;
}

async function startWhatsAppRuntime() {
  let wa;
  try {
    wa = loadWhatsAppRuntime();
  } catch (err) {
    reportError('wa_dependency_missing', err);
    return;
  }
  const clientId = sanitizeAccountSegment(ACCOUNT);

  let puppeteerConfig;
  let waWebVersionOptions;
  try {
    prepareWaChromeProfile(SESSION_DIR, clientId, { log });
    puppeteerConfig = buildChromeLaunchConfig(SESSION_DIR, {
      log,
      puppeteer: require('puppeteer'),
    });
    waWebVersionOptions = buildWaWebVersionOptions(SESSION_DIR, { log });
  } catch (err) {
    reportError('wa_browser_unavailable', err);
    return;
  }

  const client = new wa.Client({
    authStrategy: new wa.LocalAuth({
      clientId,
      dataPath: SESSION_DIR,
      rmMaxRetries: 10,
    }),
    authTimeoutMs: boundedNumber(process.env.WORKBENCH_WA_AUTH_TIMEOUT_MS, 300000, 30000, 900000),
    qrMaxRetries: Number(process.env.WORKBENCH_WA_RUNTIME_QR_MAX_RETRIES || 0),
    takeoverOnConflict: envFlag(process.env.WORKBENCH_WA_TAKEOVER_ON_CONFLICT, true),
    takeoverTimeoutMs: boundedNumber(process.env.WORKBENCH_WA_TAKEOVER_TIMEOUT_MS, 5000, 0, 60000),
    ...waWebVersionOptions,
    puppeteer: puppeteerConfig,
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

  client.on('loading_screen', (percent, message) => {
    const progress = Number.isFinite(Number(percent)) ? `${percent}%` : String(percent || '');
    reportHeartbeat('starting', 'loading', `WA 正在加载${progress ? ` ${progress}` : ''}${message ? `：${message}` : ''}`);
  });

  client.on('change_state', (stateName) => {
    const stateText = String(stateName || 'unknown');
    reportHeartbeat(channelReady ? 'ready' : 'starting', `wa_state_${stateText.toLowerCase()}`, `WA 连接状态：${stateText}`);
    recordRuntimeEvent('wa_state_changed', 'info', `WA 连接状态：${stateText}`);
  });

  client.on('ready', async () => {
    channelReady = true;
    const displayName = client.info?.pushname || client.info?.wid?.user || ACCOUNT;
    upsertProfile('ready', displayName);
    reportHeartbeat('ready', 'monitoring', `WA runtime 已接管：${displayName}`);
    recordRuntimeEvent('account_ready', 'info', `WA 账号已接管：${displayName}`);
    try {
      activeWaWebVersion = String(await client.getWWebVersion() || '').trim();
      if (activeWaWebVersion) {
        log(`WA WebVersion active: ${activeWaWebVersion}`);
        recordRuntimeEvent('wa_web_version', 'info', `WA WebVersion：${activeWaWebVersion}`, {
          version: activeWaWebVersion,
        });
      }
    } catch (err) {
      log(`WA WebVersion detection failed: ${err.message}`);
    }
    scheduleOutboundDrain(0);
    await syncChannelSnapshot('ready').catch((err) => reportError('wa_sync_failed', err, { fatal: false }));
  });

  client.on('message', (message) => {
    handleWaMessage(message).catch((err) => reportError('wa_message_failed', err, { fatal: false }));
  });
  client.on('message_create', (message) => {
    handleWaMessage(message).catch((err) => reportError('wa_message_create_failed', err, { fatal: false }));
  });
  client.on('message_ack', (message, ack) => {
    if (Number(ack) < 1) return;
    const remoteMsgId = whatsappMessageId(message);
    const changed = markProviderAckByRemoteId(workbenchDb, {
      platform: PLATFORM,
      account: ACCOUNT,
      remoteMsgId,
      ack,
    });
    if (changed) {
      recordRuntimeEvent('outbound_receipt', 'info', `WA message receipt ${ack}: ${remoteMsgId}`);
      const outbound = workbenchDb.prepare(`
        SELECT id, group_id FROM outbound_messages
        WHERE platform = ? AND account = ? AND remote_msg_id = ?
      `).get(PLATFORM, ACCOUNT, remoteMsgId);
      recordChannelEvent(runtimeDb, {
        platform: PLATFORM,
        account: ACCOUNT,
        groupId: outbound?.group_id,
        eventType: 'outbound_status',
        payload: { outbound_id: outbound?.id || null, ack: Number(ack) },
      });
    }
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

  try {
    await client.initialize();
  } catch (err) {
    reportError('wa_client_start_failed', enrichChromeLaunchError(err, puppeteerConfig));
  }
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
    scheduleOutboundDrain(0);
  } catch (err) {
    reportError('tg_bot_ready_failed', err);
  }
}

async function startTelegramUserRuntime(credential) {
  const accountKey = ACCOUNT.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const apiId = Number(
    credential.api_id ||
    credential.apiId ||
    credential.tg_api_id ||
    process.env[`WORKBENCH_TG_API_ID_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_ID ||
    process.env.TG_API_ID ||
    0
  );
  const apiHash =
    String(credential.api_hash || credential.apiHash || credential.tg_api_hash || '').trim() ||
    process.env[`WORKBENCH_TG_API_HASH_${accountKey}`] ||
    process.env.WORKBENCH_TG_API_HASH ||
    process.env.TG_API_HASH ||
    '';
  if (!apiId || !apiHash) {
    reportError('tg_user_api_missing', new Error('TG 用户 Session 缺少 API ID / App api_hash'));
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
    scheduleOutboundDrain(0);
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
  const media = message.hasMedia ? await downloadWhatsAppMedia(message, messageId) : null;
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
    ...mapStoredMedia(media),
    timestamp: message.timestamp,
    rawData: raw,
    nativeChatId: chatId,
    nativeMessageId,
  });
  lastMessageAt = new Date().toISOString();
  reportHeartbeat('ready', 'message', `WA message ${rowId}`);
  recordMessageEvent(chatId, message.fromMe ? 'outbound_message' : 'inbound');
}

async function handleTgBotMessage(message) {
  if (!message || !message.chat || !message.message_id) return;
  const chatId = String(message.chat.id);
  const sender = message.from || {};
  const messageId = `${chatId}:${message.message_id}`;
  const groupName = message.chat.title || message.chat.username || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || chatId;
  const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || String(sender.id || '');
  const media = hasTelegramMedia(message) ? await downloadTelegramBotMedia(message, messageId) : null;
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
    ...mapStoredMedia(media),
    timestamp: message.date,
    rawData: { ...message, direction: sender.is_bot ? 'outbound' : 'inbound' },
    nativeChatId: chatId,
    nativeMessageId: String(message.message_id),
  });
  lastMessageAt = new Date().toISOString();
  reportHeartbeat('ready', 'message', `TG bot message ${rowId}`);
  recordMessageEvent(chatId, sender.is_bot ? 'outbound_message' : 'inbound');
}

async function handleTgUserEvent(event) {
  const message = event && (event.message || event);
  if (!message || !message.id) return;
  const chatId = stringifyTelegramId(message.chatId || message.peerId || message.inputChat || message.senderId || '');
  if (!chatId) return;
  const senderId = stringifyTelegramId(message.senderId || message.fromId || '');
  const messageId = `${chatId}:${message.id}`;
  const mediaDescriptor = telegramUserMediaDescriptor(message);
  const initialMetadata = telegramMessageMetadata(message, { descriptor: mediaDescriptor });
  const initialRowId = upsertRawMessage({
    db: rawDb,
    platform: 'tg',
    account: ACCOUNT,
    messageId,
    groupId: chatId,
    groupName: chatId,
    senderId,
    senderName: message.postAuthor || senderId,
    content: telegramMessageText(message, mediaDescriptor),
    hasMedia: message.media ? 1 : 0,
    mediaName: mediaDescriptor?.name || null,
    mediaMime: mediaDescriptor?.mime || null,
    mediaSize: mediaDescriptor?.size || null,
    timestamp: message.date ? Number(message.date) : undefined,
    rawData: initialMetadata,
    nativeChatId: chatId,
    nativeMessageId: String(message.id),
  });
  lastMessageAt = new Date().toISOString();
  reportHeartbeat('ready', 'message', `TG user message ${initialRowId}`);
  recordMessageEvent(chatId, initialMetadata.direction === 'outbound' ? 'outbound_message' : 'inbound');

  const [entities, media] = await Promise.all([
    resolveTelegramMessageEntities(message),
    mediaDescriptor?.downloadable
      ? downloadTelegramUserMedia(message, messageId, mediaDescriptor)
      : Promise.resolve(null),
  ]);
  const metadata = telegramMessageMetadata(message, {
    chat: entities.chat,
    sender: entities.sender,
    descriptor: mediaDescriptor,
  });
  upsertRawMessage({
    db: rawDb,
    platform: 'tg',
    account: ACCOUNT,
    messageId,
    groupId: chatId,
    groupName: telegramEntityName(entities.chat, chatId),
    senderId,
    senderName: message.postAuthor || telegramEntityName(entities.sender, senderId),
    content: telegramMessageText(message, mediaDescriptor),
    hasMedia: message.media ? 1 : 0,
    mediaName: mediaDescriptor?.name || null,
    mediaMime: mediaDescriptor?.mime || null,
    mediaSize: mediaDescriptor?.size || null,
    ...mapStoredMedia(media),
    timestamp: message.date ? Number(message.date) : undefined,
    rawData: metadata,
    nativeChatId: chatId,
    nativeMessageId: String(message.id),
  });
}

async function resolveTelegramMessageEntities(message) {
  const [chat, sender] = await Promise.all([
    typeof message?.getChat === 'function' ? message.getChat().catch(() => null) : Promise.resolve(null),
    typeof message?.getSender === 'function' ? message.getSender().catch(() => null) : Promise.resolve(null),
  ]);
  return { chat, sender };
}

async function downloadWhatsAppMedia(message, messageId) {
  try {
    const media = await message.downloadMedia();
    if (!media?.data) return null;
    return storeInboundMedia(Buffer.from(media.data, 'base64'), {
      messageId,
      name: media.filename || `wa-${Date.now()}`,
      mime: media.mimetype || 'application/octet-stream',
    });
  } catch (err) {
    reportError('wa_media_download_failed', err, { fatal: false });
    return null;
  }
}

async function downloadTelegramBotMedia(message, messageId) {
  const descriptor = telegramBotMediaDescriptor(message);
  if (!descriptor || typeof channelClient.downloadFile !== 'function') return null;
  try {
    const downloadedPath = await channelClient.downloadFile(descriptor.fileId, MEDIA_DIR);
    const buffer = fs.readFileSync(downloadedPath);
    const stored = storeInboundMedia(buffer, { messageId, name: descriptor.name, mime: descriptor.mime });
    try { fs.unlinkSync(downloadedPath); } catch (_) {}
    return stored;
  } catch (err) {
    reportError('tg_bot_media_download_failed', err, { fatal: false });
    return null;
  }
}

async function downloadTelegramUserMedia(message, messageId, descriptor = telegramUserMediaDescriptor(message)) {
  if (typeof channelClient.downloadMedia !== 'function') return null;
  try {
    const downloaded = await channelClient.downloadMedia(message, { workers: 1 });
    const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded || []);
    if (!buffer.length) return null;
    return storeInboundMedia(buffer, {
      messageId,
      name: descriptor?.name || `tg-${message.id}`,
      mime: descriptor?.mime || 'application/octet-stream',
    });
  } catch (err) {
    reportError('tg_user_media_download_failed', err, { fatal: false });
    return null;
  }
}

function telegramBotMediaDescriptor(message) {
  if (message.document) return { fileId: message.document.file_id, name: message.document.file_name || 'document', mime: message.document.mime_type || 'application/octet-stream' };
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = [...message.photo].sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0];
    return { fileId: photo.file_id, name: 'photo.jpg', mime: 'image/jpeg' };
  }
  for (const key of ['video', 'audio', 'voice', 'animation', 'sticker']) {
    const item = message[key];
    if (item?.file_id) return { fileId: item.file_id, name: item.file_name || `${key}`, mime: item.mime_type || 'application/octet-stream' };
  }
  return null;
}

function storeInboundMedia(buffer, { messageId, name, mime }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  if (buffer.length > MEDIA_MAX_BYTES) throw Object.assign(new Error('inbound media exceeds size limit'), { code: 'MEDIA_TOO_LARGE' });
  const sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
  const month = new Date().toISOString().slice(0, 7);
  const originalName = String(name || 'media').trim().slice(0, 180) || 'media';
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || 'media';
  const relativePath = path.join('media', month, `${sha256.slice(0, 16)}-${safeName}`);
  const finalPath = path.join(ACCOUNT_PATHS.accountDir, relativePath);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, buffer, { mode: 0o600 });
  return { relativePath, name: safeName, originalName, mime: String(mime || 'application/octet-stream'), size: buffer.length, sha256, messageId };
}

function mapStoredMedia(media) {
  if (!media) return {};
  return {
    mediaPath: media.relativePath,
    mediaName: media.originalName || media.name,
    mediaMime: media.mime,
    mediaSize: media.size,
    mediaSha256: media.sha256,
  };
}

function repairStoredInboundMediaMetadata() {
  const rows = rawDb.prepare(`
    SELECT id, media_path, media_name
    FROM messages
    WHERE media_path IS NOT NULL
      AND TRIM(media_path) <> ''
      AND LOWER(COALESCE(media_mime, 'application/octet-stream')) = 'application/octet-stream'
  `).all();
  const accountDir = path.resolve(ACCOUNT_PATHS.accountDir);
  const update = rawDb.prepare(`
    UPDATE messages
    SET media_mime = @mime,
        media_name = @name,
        updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = @id
  `);
  let repaired = 0;
  rawDb.transaction(() => {
    rows.forEach((row) => {
      const mediaPath = path.resolve(accountDir, String(row.media_path || ''));
      const relative = path.relative(accountDir, mediaPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(mediaPath)) return;
      let file;
      let fd;
      try {
        fd = fs.openSync(mediaPath, 'r');
        const header = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
        file = header.subarray(0, bytesRead);
      } catch (_) {
        return;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (_) {}
        }
      }
      const mime = detectImageMime(file);
      if (!mime) return;
      const extension = imageExtensionForMime(mime);
      const currentName = String(row.media_name || path.basename(mediaPath) || 'tg-image');
      const name = path.extname(currentName) ? currentName : `${currentName}${extension}`;
      update.run({ id: row.id, mime, name });
      repaired += 1;
    });
  })();
  return repaired;
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
  const quoteOptions = task.quote_msg_id ? { quotedMessageId: String(task.quote_msg_id) } : {};
  if (!attachments.length) {
    const sent = await channelClient.sendMessage(chatId, task.text || '', quoteOptions);
    return { remote_msg_id: whatsappMessageId(sent) };
  }
  let lastMessageId = '';
  const { MessageMedia } = require('whatsapp-web.js');
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const media = new MessageMedia(attachment.type, attachment.base64, attachment.name);
    const options = {
      ...(index === 0 && task.text ? { caption: task.text } : {}),
      ...(index === 0 ? quoteOptions : {}),
    };
    const sent = await channelClient.sendMessage(chatId, media, options);
    lastMessageId = whatsappMessageId(sent) || lastMessageId;
  }
  return { remote_msg_id: lastMessageId };
}

async function sendTelegramBotTask(task, attachments) {
  const chatId = task.chat_id || task.group_id;
  const replyToMessageId = telegramReplyId(task.quote_msg_id);
  const replyOptions = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {};
  if (!attachments.length) {
    const sent = await channelClient.sendMessage(chatId, task.text || '', replyOptions);
    return { remote_msg_id: telegramMessageId(sent) };
  }
  let lastMessageId = '';
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const caption = index === 0 && task.text ? task.text : undefined;
    const options = { ...(caption ? { caption } : {}), ...(index === 0 ? replyOptions : {}) };
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
  const replyTo = telegramReplyId(task.quote_msg_id);
  if (!attachments.length) {
    const sent = await channelClient.sendMessage(chatId, { message: task.text || '', ...(replyTo ? { replyTo } : {}) });
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
      ...(index === 0 && replyTo ? { replyTo } : {}),
    });
    lastMessageId = telegramMessageId(sent) || lastMessageId;
  }
  return { remote_msg_id: lastMessageId };
}

function telegramReplyId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const tail = raw.includes(':') ? raw.split(':').pop() : raw;
  const numeric = Number(tail);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw Object.assign(new Error('Telegram quoted message id is invalid'), { code: 'MESSAGE_ID_INVALID' });
  }
  return numeric;
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
  if (attachment.local_path) {
    const absolutePath = path.resolve(ACCOUNT_PATHS.accountDir, String(attachment.local_path));
    const relative = path.relative(ACCOUNT_PATHS.accountDir, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw Object.assign(new Error('attachment path escaped account directory'), { code: 'ATTACHMENT_INVALID' });
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw Object.assign(new Error('attachment file is missing'), { code: 'ATTACHMENT_DATA_INVALID' });
    }
    const buffer = fs.readFileSync(absolutePath);
    if (!buffer.length) {
      throw Object.assign(new Error('attachment file is empty'), { code: 'ATTACHMENT_DATA_EMPTY' });
    }
    const type = String(attachment.type || 'application/octet-stream').trim() || 'application/octet-stream';
    return {
      id: attachment.id,
      name: String(attachment.name || 'attachment').replace(/[\\/\r\n]/g, '_').slice(0, 180) || 'attachment',
      type,
      kind: String(attachment.kind || (type.startsWith('image/') ? 'image' : 'file')).trim().toLowerCase(),
      base64: buffer.toString('base64'),
      buffer,
    };
  }
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
  // 请求必须等渠道 ready 后再读取；否则 readAndClear 会把门铃删除而没有实际同步。
  if (!CHAT_SYNC_ENABLED || !channelReady || !channelClient) return;
  const requests = readAndClearChannelSyncRequests(OUTBOX_DIR, PLATFORM, ACCOUNT);
  if (!requests.length) return;
  syncChannelSnapshot(requests[requests.length - 1].reason || 'manual')
    .catch((err) => reportError('manual_sync_failed', err, { fatal: false }));
}

async function syncChannelSnapshot(reason) {
  if (!CHAT_SYNC_ENABLED || !channelReady || !channelClient) return null;
  if (syncInFlight) return null;
  syncInFlight = true;
  try {
    if (PLATFORM === 'wa' && typeof channelClient.getChats === 'function') {
      const chatSnapshot = await readWhatsAppChatSnapshot(channelClient);
      const { chats, groups } = chatSnapshot;
      let labelSnapshot = null;
      if (chatSnapshot.degraded) {
        recordRuntimeEvent('wa_chat_sync_degraded', 'warning',
          `WA 会话模型降级同步：${groups.length} 个会话，${chatSnapshot.failedCount} 个模型异常`, {
            reason,
            web_version: activeWaWebVersion || null,
            original_error: chatSnapshot.originalError?.message || String(chatSnapshot.originalError || ''),
            failed_count: chatSnapshot.failedCount,
            failures: chatSnapshot.failures,
          });
        log(`WA chat snapshot degraded: groups=${groups.length}, failed_models=${chatSnapshot.failedCount}, ` +
          `original=${chatSnapshot.originalError?.message || chatSnapshot.originalError}`);
      } else {
        labelSnapshot = await syncWhatsAppLabels(chats).catch((err) => {
          reportError('wa_label_sync_failed', err, { fatal: false });
          return null;
        });
      }
      const result = replaceChannelSnapshot({
        db: workbenchDb,
        platform: PLATFORM,
        account: ACCOUNT,
        groups,
        ...(labelSnapshot || {}),
      });
      markChannelSyncSuccess();
      reportHeartbeat('ready', 'sync', `WA 群列表已同步：${result.group_count}`);
      recordRuntimeEvent('channel_sync', 'info', `WA 群列表已同步：${result.group_count}`, {
        reason,
        web_version: activeWaWebVersion || null,
        degraded: chatSnapshot.degraded,
        failed_models: chatSnapshot.failedCount,
        ...result,
      });
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
      const folderSnapshot = await syncTelegramFolders(dialogs).catch((err) => {
        reportError('tg_folder_sync_failed', err, { fatal: false });
        return null;
      });
      const result = replaceChannelSnapshot({
        db: workbenchDb,
        platform: PLATFORM,
        account: ACCOUNT,
        groups,
        ...(folderSnapshot || {}),
      });
      markChannelSyncSuccess();
      reportHeartbeat('ready', 'sync', `TG 会话列表已同步：${result.group_count}`);
      recordRuntimeEvent('channel_sync', 'info', `TG 会话列表已同步：${result.group_count}`, { reason, ...result });
      return result;
    }
    return null;
  } catch (err) {
    throw channelSyncFailure(err, reason);
  } finally {
    syncInFlight = false;
  }
}

function markChannelSyncSuccess() {
  lastSyncAt = Date.now();
  nextSyncAt = lastSyncAt + CHAT_SYNC_MS;
  syncFailureCount = 0;
}

function channelSyncFailure(err, reason) {
  const original = err instanceof Error ? err : new Error(String(err || 'unknown error'));
  syncFailureCount += 1;
  const retryMs = channelSyncRetryDelay(syncFailureCount, {
    baseMs: CHANNEL_SYNC_RETRY_BASE_MS,
    maxMs: CHANNEL_SYNC_RETRY_MAX_MS,
  });
  nextSyncAt = Date.now() + retryMs;
  const context = {
    platform: PLATFORM,
    account: ACCOUNT,
    reason: String(reason || 'unknown'),
    failure_count: syncFailureCount,
    retry_ms: retryMs,
    next_sync_at: new Date(nextSyncAt).toISOString(),
    web_version: PLATFORM === 'wa' ? activeWaWebVersion || null : null,
  };
  const versionText = context.web_version ? `, web_version=${context.web_version}` : '';
  const wrapped = new Error(
    `${PLATFORM.toUpperCase()} 会话同步失败（reason=${context.reason}, failure=${syncFailureCount}, ` +
    `retry_in=${Math.round(retryMs / 1000)}s${versionText}）：${original.message}`,
  );
  wrapped.cause = original;
  wrapped.syncContext = context;
  return wrapped;
}

async function syncWhatsAppLabels(chats) {
  const canListLabels = typeof channelClient.getLabels === 'function';
  const canListChatLabels = (chats || []).some((chat) => typeof chat.getLabels === 'function');
  if (!canListLabels && !canListChatLabels) return null;

  const labelRows = canListLabels ? await channelClient.getLabels() : [];
  const labels = new Map();
  const maps = [];
  const addLabel = (label) => {
    const nativeLabelId = String(
      label?.id?._serialized || label?.id || label?.labelId || label?.label_id || '',
    ).trim();
    if (!nativeLabelId) return '';
    const name = String(label?.name || label?.title || nativeLabelId).trim();
    if (!labels.has(nativeLabelId)) {
      labels.set(nativeLabelId, {
        native_label_id: nativeLabelId,
        name,
        color: label?.color || label?.hexColor || null,
        kind: 'label',
        raw_json: label,
      });
    }
    return nativeLabelId;
  };

  (Array.isArray(labelRows) ? labelRows : []).forEach(addLabel);
  for (const chat of chats || []) {
    const chatId = String(chat?.id?._serialized || chat?.id?.user || chat?.id || '').trim();
    if (!chatId) continue;
    let chatLabels = chat?.labels;
    if (typeof chat?.getLabels === 'function') chatLabels = await chat.getLabels();
    for (const label of Array.isArray(chatLabels) ? chatLabels : []) {
      const nativeLabelId = addLabel(label);
      if (nativeLabelId) maps.push({ group_id: chatId, native_label_id: nativeLabelId });
    }
  }
  return { labels: [...labels.values()], maps };
}

async function syncTelegramFolders(dialogs) {
  if (typeof channelClient.invoke !== 'function') return null;
  let Api;
  try {
    ({ Api } = require('telegram'));
  } catch (_) {
    return null;
  }
  if (!Api?.messages?.GetDialogFilters) return null;
  const response = await channelClient.invoke(new Api.messages.GetDialogFilters({}));
  const filters = Array.isArray(response) ? response : (response?.filters || []);
  const labels = filters
    .filter((filter) => filter && Number(filter.id) > 0)
    .map((filter) => ({
      native_label_id: `folder:${filter.id}`,
      name: normalizeChannelLabelName(filter.title, `文件夹 ${filter.id}`),
      kind: 'folder',
      raw_json: filter,
    }));
  const labelIds = new Set(labels.map((label) => label.native_label_id));
  const maps = [];
  for (const dialog of dialogs || []) {
    const folderId = dialog?.folderId ?? dialog?.folder_id ?? dialog?.folder?.id;
    const entity = dialog.entity || {};
    const groupId = stringifyTelegramId(entity.id || dialog.id || dialog.inputEntity || '');
    if (!groupId) continue;
    if (folderId !== undefined && folderId !== null) {
      const nativeLabelId = `folder:${folderId}`;
      if (labelIds.has(nativeLabelId)) maps.push({ group_id: groupId, native_label_id: nativeLabelId });
      continue;
    }
    // 某些 GramJS 版本不把 folderId 挂到 Dialog 上，使用文件夹的 includePeers
    // 做一次物化映射；这样规则型文件夹也能在工作台中按当前会话显示。
    const dialogKeys = telegramPeerKeys(dialog, entity, groupId);
    for (const filter of filters) {
      if (!filter || Number(filter.id) <= 0) continue;
      const nativeLabelId = `folder:${filter.id}`;
      if (!labelIds.has(nativeLabelId) || !telegramFolderMatchesDialog(filter, entity, dialogKeys)) continue;
      maps.push({ group_id: groupId, native_label_id: nativeLabelId });
    }
  }
  return { labels, maps };
}

function telegramPeerKeys(dialog, entity, groupId) {
  const values = [
    dialog?.peer,
    dialog?.inputPeer,
    dialog?.inputEntity,
    entity,
    groupId,
  ];
  const keys = new Set();
  values.forEach((value) => {
    if (!value) return;
    const peer = value.peer || value;
    if (peer.userId !== undefined) keys.add(`user:${stringifyTelegramId(peer.userId)}`);
    if (peer.chatId !== undefined) keys.add(`chat:${stringifyTelegramId(peer.chatId)}`);
    if (peer.channelId !== undefined) keys.add(`channel:${stringifyTelegramId(peer.channelId)}`);
    if (peer.id !== undefined) keys.add(`id:${stringifyTelegramId(peer.id)}`);
    keys.add(`raw:${stringifyTelegramId(peer)}`);
  });
  return keys;
}

function telegramFolderMatchesDialog(filter, entity, dialogKeys) {
  const includePeers = Array.isArray(filter.includePeers) ? filter.includePeers : [];
  if (includePeers.length) {
    const included = includePeers.some((peer) => {
      const keys = telegramPeerKeys({ peer }, peer, '');
      return [...keys].some((key) => dialogKeys.has(key));
    });
    if (!included) return false;
  }
  const excludedPeers = Array.isArray(filter.excludePeers) ? filter.excludePeers : [];
  if (excludedPeers.some((peer) => {
    const keys = telegramPeerKeys({ peer }, peer, '');
    return [...keys].some((key) => dialogKeys.has(key));
  })) return false;
  if (filter.groups && !(entity.megagroup || entity.gigagroup || entity.className === 'Chat' || entity.className === 'Channel')) return false;
  if (filter.broadcasts && !(entity.broadcast || entity.className === 'Channel' && !entity.megagroup)) return false;
  if (filter.bots && !entity.bot) return false;
  return true;
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
  recordRuntimeEvent(type, 'error', error.message, {
    stack: error.stack,
    ...(error.syncContext ? { sync: error.syncContext } : {}),
  });
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

async function shutdown(_reason = 'signal', { exitCode = 0 } = {}) {
  if (stopping) return;
  stopping = true;
  log('stopping');
  clearInterval(heartbeatTimer);
  clearInterval(sendTimer);
  clearTimeout(outboundDrainTimer);
  outboundDoorbellWatcher.close();
  try {
    const drained = await outboundConsumer.drainCurrent(30000);
    if (!drained) log('outbound drain timed out; lease recovery will pause the unresolved task');
    if (PLATFORM === 'wa' && channelClient && typeof channelClient.destroy === 'function') {
      await channelClient.destroy();
    } else if (channelClient && typeof channelClient.close === 'function') {
      await channelClient.close();
    } else if (channelClient && typeof channelClient.disconnect === 'function') {
      await channelClient.disconnect();
    }
  } catch (err) {
    log(`channel shutdown failed: ${err.message}`);
  } finally {
    releaseLease();
  }
  outboundConsumer.close();
  rawDb.close();
  runtimeDb.close();
  workbenchDb.close();
  process.exit(exitCode);
}

function recordMessageEvent(groupId, eventType) {
  recordChannelEvent(runtimeDb, {
    platform: PLATFORM,
    account: ACCOUNT,
    groupId,
    eventType,
  });
}

function recordOutboundStatusEvent(outboundId) {
  if (!outboundId) return;
  const outbound = workbenchDb.prepare('SELECT id, group_id, status FROM outbound_messages WHERE id = ?').get(outboundId);
  if (!outbound) return;
  recordChannelEvent(runtimeDb, {
    platform: PLATFORM,
    account: ACCOUNT,
    groupId: outbound.group_id,
    eventType: 'outbound_status',
    payload: { outbound_id: outbound.id, status: outbound.status },
  });
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

function tightenedSendMinInterval() {
  const baseline = PLATFORM === 'wa' ? 2500 : 1000;
  const configured = process.env[`WORKBENCH_${PLATFORM.toUpperCase()}_SEND_MIN_INTERVAL_MS`] ||
    process.env.WORKBENCH_SEND_MIN_INTERVAL_MS;
  return Math.max(baseline, boundedNumber(configured, baseline, baseline, 60000));
}

function tightenedSendPerMinute() {
  const baseline = PLATFORM === 'wa' ? 20 : 30;
  const configured = process.env[`WORKBENCH_${PLATFORM.toUpperCase()}_SEND_PER_MINUTE`] ||
    process.env.WORKBENCH_SEND_PER_MINUTE;
  return Math.min(baseline, boundedNumber(configured, baseline, 1, baseline));
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function log(message) {
  logEvent('info', 'account-runtime-worker', 'runtime', message, { platform: PLATFORM, account: ACCOUNT });
}
