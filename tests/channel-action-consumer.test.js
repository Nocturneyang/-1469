'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openWorkbenchDb } = require('../db/workbench-db');
const { createChannelActionConsumer } = require('../lib/channel-action-consumer');
const { channelActionDoorbellDir, clearResolvedChannelActionDoorbells } = require('../lib/outbound-doorbell');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-channel-action-'));
  const db = openWorkbenchDb(path.join(tempDir, 'workbench.sqlite'));
  try {
    const actionId = db.prepare(`
      INSERT INTO channel_action_tasks (
        client_action_id, platform, account, group_id, action_type, target_message_id,
        payload_json, status, created_by
      ) VALUES ('reaction-1', 'wa', 'wa-test', 'chat-1', 'reaction', 'native-1', '{"emoji":"👍"}', 'pending', 'operator-1')
    `).run().lastInsertRowid;
    const consumer = createChannelActionConsumer({
      db,
      platform: 'wa',
      account: 'wa-test',
      performAction: async (task) => {
        assert.strictEqual(task.target_message_id, 'native-1');
        assert.strictEqual(task.payload.emoji, '👍');
        return { native: true };
      },
    });
    const result = await consumer.runOnce();
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.action_id, Number(actionId));
    const completed = db.prepare('SELECT status, result_json FROM channel_action_tasks WHERE id = ?').get(actionId);
    assert.strictEqual(completed.status, 'completed');
    assert.deepStrictEqual(JSON.parse(completed.result_json), { native: true });

    const failedId = db.prepare(`
      INSERT INTO channel_action_tasks (client_action_id, platform, account, group_id, action_type, status, created_by)
      VALUES ('bad-1', 'wa', 'wa-test', 'chat-1', 'unknown', 'pending', 'operator-1')
    `).run().lastInsertRowid;
    const failing = createChannelActionConsumer({ db, platform: 'wa', account: 'wa-test', performAction: async () => {
      throw Object.assign(new Error('unsupported'), { code: 'ACTION_UNSUPPORTED' });
    } });
    const failed = await failing.runOnce();
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(db.prepare('SELECT status FROM channel_action_tasks WHERE id = ?').get(failedId).status, 'failed');

    const directory = channelActionDoorbellDir(path.join(tempDir, 'outbox'), 'wa', 'wa-test');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${actionId}.json`), '{}');
    fs.writeFileSync(path.join(directory, `${failedId}.json`), '{}');
    assert.strictEqual(clearResolvedChannelActionDoorbells({ directory, db }), 2);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
