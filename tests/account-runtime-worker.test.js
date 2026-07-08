const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureAccountDatabases } = require('../db/account-db');
const { ensureRawDb, upsertRawMessage, upsertServiceAccountProfile } = require('../db/raw-db');
const {
  accountKey,
  desiredAccountWorkers,
  parseExplicitWorkers,
  shouldRunAccountWorker,
} = require('../workers/account-worker-supervisor');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-account-runtime-'));
  const accountDataDir = path.join(tmpDir, 'accounts');

  try {
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
      const observationRows = rawDb.prepare('SELECT * FROM message_observations').all();
      assert.strictEqual(observationRows.length, 1);
      assert.strictEqual(observationRows[0].observer_account, 'wa-runtime');
      assert.strictEqual(observationRows[0].native_chat_id, 'chat-1');
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

    const tgPaths = ensureAccountDatabases('tg', 'tg-waiting', { accountDataDir });
    upsertServiceAccountProfile({
      dbPath: tgPaths.rawDbPath,
      platform: 'tg',
      account: 'tg-waiting',
      displayName: 'TG Waiting',
      loginType: 'tg_bot_token',
      status: 'waiting_qr',
    });

    assert.strictEqual(shouldRunAccountWorker({
      status: 'authenticated',
      collect_enabled: 1,
      workbench_visible: 1,
    }), true);
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
