const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureAccountDatabases } = require('../db/account-db');
const { ensureRawDb, upsertRawMessage, upsertServiceAccountProfile, upsertWaContactAliases } = require('../db/raw-db');
const { listGroups: listRawGroups, listMessagesPage } = require('../db/raw-messages');
const { openWorkbenchDb } = require('../db/workbench-db');
const { normalizeChannelLabelName, replaceChannelSnapshot } = require('../lib/channel-sync-store');
const { channelSyncRetryDelay } = require('../lib/channel-sync-retry');
const { boundedLoginConcurrency, hasLoginCapacity } = require('../lib/login-capacity');
const {
  readWhatsAppChatSnapshot,
  readNativeWhatsAppChatSnapshot,
  toWhatsAppGroup,
  whatsappDisplayName,
  isWhatsAppInternalId,
  isWhatsAppPhoneDisplay,
  whatsappChatId,
} = require('../lib/wa-chat-snapshot');
const {
  normalizeWhatsAppDownloadedMedia,
  whatsappMediaDescriptor,
  whatsappMessageMetadata,
  whatsappMessageText,
} = require('../lib/whatsapp-message');
const {
  detectImageMime,
  imageExtensionForMime,
  telegramEntityName,
  telegramMessageMetadata,
  telegramMessageText,
  telegramUserMediaDescriptor,
} = require('../lib/telegram-message');
const {
  accountKey,
  desiredAccountWorkers,
  parseExplicitWorkers,
  selectAccountWorkers,
  shouldRunAccountWorker,
} = require('../workers/account-worker-supervisor');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-account-runtime-'));
  const accountDataDir = path.join(tmpDir, 'accounts');

  try {
    assert.strictEqual(boundedLoginConcurrency(undefined), 1);
    assert.strictEqual(boundedLoginConcurrency('5'), 5);
    assert.strictEqual(boundedLoginConcurrency('0'), 1);
    assert.strictEqual(hasLoginCapacity(0, 1), true);
    assert.strictEqual(hasLoginCapacity(1, 1), false);
    assert.strictEqual(channelSyncRetryDelay(1), 30000);
    assert.strictEqual(channelSyncRetryDelay(2), 60000);
    assert.strictEqual(channelSyncRetryDelay(3), 120000);
    assert.strictEqual(channelSyncRetryDelay(6), 600000);
    assert.strictEqual(channelSyncRetryDelay(20), 600000);
    assert.strictEqual(channelSyncRetryDelay(3, { baseMs: 5000, maxMs: 15000 }), 15000);
    assert.strictEqual(whatsappChatId({ _serialized: '123@g.us' }), '123@g.us');
    assert.strictEqual(whatsappChatId({ user: '123', server: 'g.us' }), '123@g.us');
    assert.strictEqual(isWhatsAppInternalId('77408698953978@lid'), true);
    assert.strictEqual(isWhatsAppInternalId('真实客户'), false);
    assert.strictEqual(isWhatsAppPhoneDisplay('+234 906 781 7414'), true);
    assert.strictEqual(isWhatsAppPhoneDisplay('1087060-PT Generasi XT'), false);
    assert.strictEqual(whatsappDisplayName(
      { id: { _serialized: '77408698953978@lid' }, name: '77408698953978@lid' },
      { name: '真实客户' },
    ), '真实客户');
    assert.strictEqual(whatsappDisplayName(
      { id: { _serialized: '2349067817414@c.us' }, name: '+234 906 781 7414' },
      { pushname: 'Chris Laco', number: '2349067817414' },
    ), 'Chris Laco');
    assert.strictEqual(whatsappDisplayName(
      { id: { _serialized: 'account-name@g.us' }, formattedTitle: 'Mason', isGroup: true },
      null,
      '',
      { excludedNames: ['Mason'] },
    ), 'account-name@g.us');
    assert.strictEqual(whatsappDisplayName(
      { id: { _serialized: 'customer@c.us' }, formattedTitle: 'Mason' },
      { pushname: '真实客户' },
      '',
      { excludedNames: ['Mason'] },
    ), '真实客户');
    const waImageMessage = {
      id: { id: 'WA-42' },
      type: 'image',
      body: '',
      hasMedia: true,
      from: 'customer@c.us',
      timestamp: 1783500000,
      _data: { mimetype: 'image/png', size: 2048 },
      downloadMedia() {},
    };
    const waImageDescriptor = whatsappMediaDescriptor(waImageMessage);
    assert.strictEqual(waImageDescriptor.name, 'wa-WA-42.png');
    assert.strictEqual(waImageDescriptor.mime, 'image/png');
    assert.strictEqual(waImageDescriptor.size, 2048);
    assert.strictEqual(waImageDescriptor.downloadable, true);
    assert.strictEqual(whatsappMessageText(waImageMessage, waImageDescriptor), '图片');
    assert.strictEqual(whatsappMessageMetadata(waImageMessage, waImageDescriptor).media.kind, 'image');
    const normalizedWaImage = normalizeWhatsAppDownloadedMedia({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
      mimetype: 'application/octet-stream',
      filename: 'wa-image.bin',
    });
    assert.strictEqual(normalizedWaImage.mime, 'image/png');
    assert.strictEqual(normalizedWaImage.name, 'wa-image.png');
    assert.deepStrictEqual([...normalizedWaImage.buffer], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const workerSource = fs.readFileSync(path.join(__dirname, '..', 'workers', 'account-runtime-worker.js'), 'utf8');
    assert.match(workerSource, /scheduleMissingWhatsAppMediaRepair\('periodic'\)/);
    assert.match(workerSource, /WORKBENCH_WA_MEDIA_REPAIR_RETRY_MS/);
    assert.match(workerSource, /typeof message\.reload === 'function'/);
    assert.match(workerSource, /downloadWhatsAppMediaWithCompatAdapter\(message(?:,\s*nativeMessageId)?\)/, 'WA downloads must fall back when the upstream Web helper changes');
    assert.match(workerSource, /message\?\.client\?\.pupPage/, 'the compatibility adapter must use the message client page');
    assert.match(workerSource, /function whatsappSerializedMessageId\(/, 'the compatibility adapter must derive a serialized WA message id when the SDK omits it');
    assert.match(workerSource, /\[String\(id\.fromMe\), String\(remote\), messagePart\]/, 'derived WA ids must preserve sender, chat, and message components');
    assert.match(workerSource, /downloadQpl:\s*qpl/, 'the WA compatibility adapter must supply a forwards-compatible download telemetry object');
    assert.match(workerSource, /downloadAndMaybeDecrypt/, 'the compatibility path must retrieve and decrypt every downloadable WA media type');
    assert.match(workerSource, /client\.on\('message_edit'/, 'WA edits must be synchronized by the runtime worker');
    assert.match(workerSource, /client\.on\('message_reaction'/, 'WA reactions must be synchronized by the runtime worker');
    assert.match(workerSource, /message_revoke_everyone/, 'WA revokes must be synchronized by the runtime worker');
    assert.match(workerSource, /contact_changed/, 'WA LID/phone aliases must be updated by the runtime worker');
    assert.match(workerSource, /'chat_archived'/, 'WA archive events must trigger a snapshot refresh');
    const waGroup = toWhatsAppGroup({
      id: { _serialized: '123@g.us' },
      formattedTitle: 'WA 群',
      isGroup: true,
      unreadCount: 2,
      pin: 1,
    });
    assert.strictEqual(waGroup.group_id, '123@g.us');
    assert.strictEqual(waGroup.group_name, 'WA 群');
    assert.strictEqual(waGroup.kind, 'group');
    assert.strictEqual(waGroup.raw_json.unreadCount, 2);
    assert.strictEqual(waGroup.raw_json.pinned, true);
    assert.strictEqual(waGroup.raw_json.archived, false);

    const normalChat = {
      id: { _serialized: 'normal@g.us' },
      name: '正常群',
      isGroup: true,
    };
    const normalSnapshot = await readWhatsAppChatSnapshot({
      getChats: async () => [normalChat],
    });
    assert.strictEqual(normalSnapshot.degraded, false);
    assert.strictEqual(normalSnapshot.chats[0], normalChat);
    assert.strictEqual(normalSnapshot.groups[0].group_id, 'normal@g.us');

    const originalWindow = global.window;
    global.window = {
      require(name) {
        if (name === 'WAWebWidFactory') {
          return {
            createWid(value) {
              return { _serialized: value, user: String(value).split('@')[0], server: String(value).split('@')[1] };
            },
          };
        }
        if (name === 'WAWebApiContact') {
          return {
            getPhoneNumber(value) {
              return value?._serialized === '77408698953978@lid'
                ? { _serialized: '15551234567@c.us', user: '15551234567', server: 'c.us' }
                : null;
            },
          };
        }
        assert.strictEqual(name, 'WAWebCollections');
        return {
          Chat: {
            getModelsArray() {
              return [
                {
                  id: { _serialized: 'native@g.us', user: 'native', server: 'g.us' },
                  formattedTitle: 'Mason',
                  unreadCount: 4,
                  labels: ['1'],
                },
                {
                  id: { _serialized: '77408698953978@lid', user: '77408698953978', server: 'lid' },
                  formattedTitle: '77408698953978@lid',
                  unreadCount: 1,
                  labels: [],
                },
              ];
            },
          },
          Contact: {
            get() { return null; },
            getModelsArray() {
              return [{
                id: { _serialized: '15551234567@c.us', user: '15551234567', server: 'c.us' },
                name: '真实客户',
                phoneNumber: { _serialized: '15551234567@c.us', user: '15551234567', server: 'c.us' },
              }];
            },
          },
          GroupMetadata: {
            get(id) {
              const serialized = id?._serialized || id;
              return serialized === 'native@g.us' ? { subject: '原生群' } : null;
            },
          },
          Label: {
            getModelsArray() {
              return [{ id: '1', name: '售后', hexColor: '#00ff00' }];
            },
          },
        };
      },
    };
    try {
      const nativeSnapshot = await readNativeWhatsAppChatSnapshot({
        pupPage: { evaluate: async (fn) => fn() },
      });
      assert.strictEqual(nativeSnapshot.available, true);
      assert.strictEqual(nativeSnapshot.models[0].id._serialized, 'native@g.us');
      assert.strictEqual(nativeSnapshot.models[0].formattedTitle, '原生群');
      assert.strictEqual(nativeSnapshot.models[1].formattedTitle, '真实客户');
      assert.deepStrictEqual(nativeSnapshot.labelSnapshot, {
        labels: [{
          native_label_id: '1',
          name: '售后',
          color: '#00ff00',
          kind: 'label',
          raw_json: { id: '1', name: '售后', color: '#00ff00' },
        }],
        maps: [{ group_id: 'native@g.us', native_label_id: '1' }],
      });
      const preferredSnapshot = await readWhatsAppChatSnapshot({
        getChats: async () => { throw new Error('must not use unstable serializer'); },
        pupPage: { evaluate: async (fn) => fn() },
      });
      assert.strictEqual(preferredSnapshot.degraded, false);
      assert.strictEqual(preferredSnapshot.snapshotMode, 'native');
      assert.strictEqual(preferredSnapshot.groups[0].group_id, 'native@g.us');
      assert.strictEqual(preferredSnapshot.groups[1].group_name, '真实客户');
    } finally {
      global.window = originalWindow;
    }

    const libraryFallbackSnapshot = await readWhatsAppChatSnapshot({
      getChats: async () => [normalChat],
      pupPage: { evaluate: async () => ({ available: false }) },
    });
    assert.strictEqual(libraryFallbackSnapshot.snapshotMode, 'wwebjs');
    assert.strictEqual(libraryFallbackSnapshot.groups[0].group_id, 'normal@g.us');

    await assert.rejects(
      readWhatsAppChatSnapshot({
        getChats: async () => { throw new Error('r'); },
        pupPage: { evaluate: async () => ({ available: false }) },
      }),
      /r/,
    );

    const waPaths = ensureAccountDatabases('wa', 'wa-runtime', { accountDataDir });
    const rawDb = ensureRawDb(waPaths.rawDbPath);
    try {
      const firstId = upsertRawMessage({
        db: rawDb,
        platform: 'wa',
        account: 'wa-runtime',
        messageId: 'chat-1:msg-1',
        groupId: 'chat-1',
        groupName: '测试群',
        senderId: 'customer-1',
        senderName: '客户1',
        content: 'hello',
        timestamp: 1783500000,
        rawData: { fromMe: false, type: 'chat' },
        nativeChatId: 'chat-1',
        nativeMessageId: 'msg-1',
      });
      const secondId = upsertRawMessage({
        db: rawDb,
        platform: 'wa',
        account: 'wa-runtime',
        messageId: 'chat-1:msg-1',
        groupId: 'chat-1',
        groupName: '测试群',
        senderId: 'customer-1',
        senderName: '客户1',
        content: 'hello updated',
        timestamp: 1783500001,
        rawData: { fromMe: false, type: 'chat', edited: true },
        nativeChatId: 'chat-1',
        nativeMessageId: 'msg-1',
      });
      assert.strictEqual(secondId, firstId);
      const messageRows = rawDb.prepare('SELECT * FROM messages').all();
      assert.strictEqual(messageRows.length, 1);
      assert.strictEqual(messageRows[0].receiver_account, 'wa-runtime');
      assert.strictEqual(messageRows[0].content, 'hello updated');
      assert.ok(messageRows[0].updated_at, 'raw messages must expose an update timestamp for realtime refresh');
      assert.match(messageRows[0].updated_at, /\.\d{3}$/, 'raw message updates must keep millisecond precision');
      const observationRows = rawDb.prepare('SELECT * FROM message_observations').all();
      assert.strictEqual(observationRows.length, 1);
      assert.strictEqual(observationRows[0].observer_account, 'wa-runtime');
      assert.strictEqual(observationRows[0].native_chat_id, 'chat-1');
      upsertWaContactAliases({
        db: rawDb,
        account: 'wa-runtime',
        canonicalId: '15551234567@c.us',
        aliases: ['77408698953978@lid', '15551234567@c.us'],
        lidId: '77408698953978@lid',
        phoneId: '15551234567@c.us',
        displayName: '真实客户',
      });
      const aliases = rawDb.prepare(`
        SELECT alias_id, canonical_id FROM wa_contact_aliases
        WHERE account = 'wa-runtime' ORDER BY alias_id
      `).all();
      assert.strictEqual(aliases.length, 2);
      assert.ok(aliases.every((row) => row.canonical_id === '15551234567@c.us'));
      for (let index = 0; index < 90; index += 1) {
        upsertRawMessage({
          db: rawDb,
          platform: 'wa',
          account: 'wa-runtime',
          messageId: `noise-${index}`,
          groupId: `noise-group-${index}`,
          groupName: `无关群 ${index}`,
          senderId: 'noise',
          senderName: '无关成员',
          content: `noise ${index}`,
          timestamp: 1783600000 + index,
          nativeChatId: `noise-group-${index}`,
          nativeMessageId: `noise-${index}`,
        });
      }
      const targetedGroups = listRawGroups({
        rawDbPath: waPaths.rawDbPath,
        platforms: ['wa'],
        accountScope: { active: true, accounts: [{ platform: 'wa', account: 'wa-runtime' }] },
        groupIds: ['chat-1'],
        limit: 1,
      });
      assert.strictEqual(targetedGroups.length, 1);
      assert.strictEqual(targetedGroups[0].group_id, 'chat-1');
      assert.strictEqual(targetedGroups[0].content, 'hello updated');
      const directMessagePage = listMessagesPage({
        rawDbPath: waPaths.rawDbPath,
        platform: 'wa',
        account: 'wa-runtime',
        accountScope: { active: true, accounts: [{ platform: 'wa', account: 'wa-runtime' }] },
        groupId: 'chat-1',
        limit: 60,
        directAccount: true,
      });
      assert.strictEqual(directMessagePage.messages.length, 1);
      assert.strictEqual(directMessagePage.messages[0].content, 'hello updated');
      assert.strictEqual(directMessagePage.messages[0].account, 'wa-runtime');
      const directQueryPlan = rawDb.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id
        FROM messages
        WHERE platform IN ('wa', 'whatsapp') AND group_id = 'chat-1'
        ORDER BY timestamp DESC, id DESC
        LIMIT 61
      `).all();
      assert.ok(directQueryPlan.some((row) => String(row.detail).includes('idx_messages_group')));
    } finally {
      rawDb.close();
    }

    upsertServiceAccountProfile({
      dbPath: waPaths.rawDbPath,
      platform: 'wa',
      account: 'wa-runtime',
      displayName: 'WA Runtime',
      loginType: 'wa_qr',
      status: 'authenticated',
    });
    assert.strictEqual(readSendEnabled(waPaths.rawDbPath, 'wa-runtime'), 0);
    upsertServiceAccountProfile({
      dbPath: waPaths.rawDbPath,
      platform: 'wa',
      account: 'wa-runtime',
      displayName: 'WA Runtime',
      loginType: 'wa_qr',
      status: 'ready',
      sendEnabled: 0,
    });
    assert.strictEqual(readSendEnabled(waPaths.rawDbPath, 'wa-runtime'), 0);

    const tgPaths = ensureAccountDatabases('tg', 'tg-waiting', { accountDataDir });
    const tgRawDb = ensureRawDb(tgPaths.rawDbPath);
    try {
      upsertRawMessage({
        db: tgRawDb,
        platform: 'tg',
        account: 'tg-waiting',
        messageId: '-1001:42',
        groupId: '-1001',
        groupName: 'TG 测试群',
        senderId: '701',
        senderName: '张 三',
        content: 'TG recent message',
        timestamp: 1783500042,
        rawData: { fromMe: false, media: { kind: 'photo' } },
        nativeChatId: '-1001',
        nativeMessageId: '42',
      });
    } finally {
      tgRawDb.close();
    }
    const tgDirectMessagePage = listMessagesPage({
      rawDbPath: tgPaths.rawDbPath,
      platform: 'tg',
      account: 'tg-waiting',
      accountScope: { active: true, accounts: [{ platform: 'tg', account: 'tg-waiting' }] },
      groupId: '-1001',
      limit: 60,
      directAccount: true,
    });
    assert.strictEqual(tgDirectMessagePage.messages.length, 1);
    assert.strictEqual(tgDirectMessagePage.messages[0].content, 'TG recent message');
    upsertServiceAccountProfile({
      dbPath: tgPaths.rawDbPath,
      platform: 'tg',
      account: 'tg-waiting',
      displayName: 'TG Waiting',
      loginType: 'tg_bot_token',
      status: 'waiting_qr',
    });

    assert.strictEqual(normalizeChannelLabelName({ text: '欧美 IT traffic sms/mms', entities: [] }, '文件夹 1'), '欧美 IT traffic sms/mms');
    assert.strictEqual(normalizeChannelLabelName({ entities: [] }, '文件夹 2'), '文件夹 2');
    const tgPhotoMessage = {
      id: 42,
      message: '',
      media: { className: 'MessageMediaPhoto', photo: { sizes: [{ size: 2048 }] } },
      chatId: { channelId: '-1001' },
      senderId: { userId: '701' },
      replyTo: { replyToMsgId: 41, quoteText: '上一条消息' },
      fwdFrom: { fromName: '原始频道', date: 1783500000 },
      views: 17,
    };
    const photoDescriptor = telegramUserMediaDescriptor(tgPhotoMessage);
    assert.strictEqual(photoDescriptor.kind, 'image');
    assert.strictEqual(photoDescriptor.mime, 'image/jpeg');
    assert.strictEqual(photoDescriptor.name, 'tg-42.jpg');
    assert.strictEqual(telegramMessageText(tgPhotoMessage, photoDescriptor), '图片');
    assert.strictEqual(telegramEntityName({ firstName: '张', lastName: '三' }), '张 三');
    const photoMetadata = telegramMessageMetadata(tgPhotoMessage, {
      chat: { title: 'TG 客户群' },
      sender: { firstName: '张', lastName: '三', username: 'zhangsan' },
      descriptor: photoDescriptor,
    });
    assert.strictEqual(photoMetadata.chat_name, 'TG 客户群');
    assert.strictEqual(photoMetadata.sender_name, '张 三');
    assert.strictEqual(photoMetadata.sender_username, 'zhangsan');
    assert.strictEqual(photoMetadata.reply_to_msg_id, 41);
    assert.strictEqual(photoMetadata.forwarded_from, '原始频道');
    assert.strictEqual(photoMetadata.media.kind, 'photo');
    assert.strictEqual(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.strictEqual(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.strictEqual(imageExtensionForMime('image/webp'), '.webp');
    const tgWorkbenchDb = openWorkbenchDb(tgPaths.workbenchDbPath);
    try {
      replaceChannelSnapshot({
        db: tgWorkbenchDb,
        platform: 'tg',
        account: 'tg-waiting',
        groups: [{ group_id: '-1001', group_name: 'TG 测试群' }],
        labels: [{ native_label_id: 'folder:1', name: { text: '欧美 IT traffic sms/mms', entities: [] }, kind: 'folder' }],
        maps: [{ group_id: '-1001', native_label_id: 'folder:1' }],
      });
      const storedFolder = tgWorkbenchDb.prepare(`
        SELECT name FROM channel_labels
        WHERE platform = 'tg' AND account = 'tg-waiting' AND native_label_id = 'folder:1'
      `).get();
      assert.strictEqual(storedFolder.name, '欧美 IT traffic sms/mms');
      assert.notStrictEqual(storedFolder.name, '[object Object]');
    } finally {
      tgWorkbenchDb.close();
    }

    const waSecondPaths = ensureAccountDatabases('wa', 'wa-runtime-second', { accountDataDir });
    upsertServiceAccountProfile({
      dbPath: waSecondPaths.rawDbPath,
      platform: 'wa',
      account: 'wa-runtime-second',
      displayName: 'WA Runtime Second',
      loginType: 'wa_qr',
      status: 'ready',
    });

    assert.strictEqual(shouldRunAccountWorker({
      status: 'authenticated',
      collect_enabled: 1,
      workbench_visible: 1,
    }), true);
    assert.strictEqual(shouldRunAccountWorker({
      status: 'starting',
      collect_enabled: 1,
      workbench_visible: 1,
    }), true, 'a booting WA worker must survive discovery until the browser is ready');
    assert.strictEqual(shouldRunAccountWorker({
      status: 'authenticated',
      collect_enabled: 0,
      workbench_visible: 1,
    }), false);
    assert.strictEqual(shouldRunAccountWorker({
      status: 'waiting_qr',
      collect_enabled: 1,
      workbench_visible: 1,
    }), false);

    const refs = [
      { platform: 'wa', account: 'wa-runtime', paths: waPaths },
      { platform: 'tg', account: 'tg-waiting', paths: tgPaths },
    ];
    const desired = desiredAccountWorkers({ refs, explicitWorkers: [], startAll: false, maxWorkers: 10 });
    assert.deepStrictEqual(desired.map((ref) => accountKey(ref.platform, ref.account)), ['wa:wa-runtime']);

    const explicit = parseExplicitWorkers('tg:tg-waiting');
    const forced = desiredAccountWorkers({ refs, explicitWorkers: explicit, startAll: false, maxWorkers: 10 });
    assert.deepStrictEqual(forced.map((ref) => accountKey(ref.platform, ref.account)), ['tg:tg-waiting']);

    const capacity = selectAccountWorkers({
      refs: [...refs, { platform: 'wa', account: 'wa-runtime-second', paths: waSecondPaths }],
      startAll: true,
      maxWorkers: 5,
      maxWaWorkers: 1,
      maxTgWorkers: 4,
    });
    assert.strictEqual(capacity.desired.filter((ref) => ref.platform === 'wa').length, 1);
    assert.strictEqual(capacity.waiting.filter((ref) => ref.platform === 'wa').length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readSendEnabled(rawDbPath, account) {
  const db = ensureRawDb(rawDbPath);
  try {
    const row = db.prepare(`
      SELECT send_enabled
      FROM channel_account_registry
      WHERE account = ?
    `).get(account);
    return row ? Number(row.send_enabled) : null;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
