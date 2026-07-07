const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openWorkbenchDb } = require('../db/workbench-db');
const {
  activeBreaker,
  createOutboundConsumer,
  toSqlTimestamp,
} = require('../lib/outbound-consumer');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-consumer-'));
  const dbPath = path.join(tmpDir, 'workbench.sqlite');
  const db = openWorkbenchDb(dbPath);

  try {
    insertOutbound(db, { clientMsgId: 'ok-1', text: 'hello' });
    const sentTasks = [];
    const consumer = createOutboundConsumer({
      db,
      platform: 'wa',
      account: 'nanya_wa',
      sendMessage: async (task) => {
        sentTasks.push(task);
        return { remote_msg_id: `remote-${task.id}` };
      },
    });
    const sent = await consumer.runOnce();
    assert.strictEqual(sent.status, 'sent');
    assert.strictEqual(sentTasks.length, 1);
    let row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('ok-1');
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.remote_msg_id, `remote-${row.id}`);

    insertOutbound(db, {
      clientMsgId: 'stale-1',
      text: 'stale',
      status: 'sending',
      sendingStartedAt: toSqlTimestamp(Date.now() - 120000),
    });
    const stale = await consumer.runOnce();
    assert.strictEqual(stale.status, 'sent');
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('stale-1');
    assert.strictEqual(row.status, 'sent');

    const attachmentJson = JSON.stringify([{
      id: 'attachment-1',
      name: 'paste.png',
      type: 'image/png',
      size: 8,
      kind: 'image',
      data_url: 'data:image/png;base64,iVBORw0KGgo=',
    }]);
    insertOutbound(db, { clientMsgId: 'attachment-1', text: '', attachmentJson });
    const attachmentSent = await consumer.runOnce();
    assert.strictEqual(attachmentSent.status, 'sent');
    assert.strictEqual(sentTasks[sentTasks.length - 1].attachment_json, attachmentJson);
    consumer.close();

    const failingConsumer = createOutboundConsumer({
      db,
      platform: 'tg',
      account: 'jason_tg',
      sendMessage: async () => {
        const err = new Error('temporary channel failure');
        err.code = 'TEMP_FAIL';
        throw err;
      },
    });
    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'fail-1' });
    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'fail-2' });
    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'fail-3' });

    assert.strictEqual((await failingConsumer.runOnce()).status, 'failed');
    assert.strictEqual((await failingConsumer.runOnce()).status, 'failed');
    assert.strictEqual((await failingConsumer.runOnce()).status, 'failed');
    assert.ok(activeBreaker(db, 'tg', 'jason_tg'));

    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'paused-1' });
    const paused = await failingConsumer.runOnce();
    assert.strictEqual(paused.status, 'paused');
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('paused-1');
    assert.strictEqual(row.status, 'paused');
    assert.strictEqual(row.error_code, 'CIRCUIT_BREAKER');
    failingConsumer.close();
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function insertOutbound(db, {
  platform = 'wa',
  account = 'nanya_wa',
  clientMsgId,
  groupId = 'group-1',
  text = 'test',
  attachmentJson = null,
  status = 'pending',
  sendingStartedAt = null,
} = {}) {
  db.prepare(`
    INSERT INTO outbound_messages (
      client_msg_id, platform, account, group_id, chat_id, text, attachment_json,
      status, created_by, sending_started_at
    )
    VALUES (
      @clientMsgId, @platform, @account, @groupId, @groupId, @text, @attachmentJson,
      @status, 'demo-operator', @sendingStartedAt
    )
  `).run({ clientMsgId, platform, account, groupId, text, attachmentJson, status, sendingStartedAt });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
