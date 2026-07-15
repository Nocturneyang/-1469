const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openWorkbenchDb } = require('../db/workbench-db');
const {
  activeBreaker,
  claimNextPending,
  createOutboundConsumer,
  markDeliveredByRemoteId,
  markProviderAckByRemoteId,
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
      minIntervalMs: 0,
      perMinuteLimit: 100,
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
    assert.strictEqual(markDeliveredByRemoteId(db, {
      platform: 'wa', account: 'nanya_wa', remoteMsgId: row.remote_msg_id,
    }), 1);
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('ok-1');
    assert.strictEqual(row.status, 'delivered');
    assert.strictEqual(markProviderAckByRemoteId(db, {
      platform: 'wa', account: 'nanya_wa', remoteMsgId: row.remote_msg_id, ack: 1,
    }), 1);
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('ok-1');
    assert.strictEqual(row.status, 'delivered');
    assert.strictEqual(markProviderAckByRemoteId(db, {
      platform: 'wa', account: 'nanya_wa', remoteMsgId: row.remote_msg_id, ack: 3,
    }), 1);
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('ok-1');
    assert.strictEqual(row.status, 'read');
    assert.strictEqual(row.provider_ack, 3);
    assert.ok(row.read_at);
    assert.strictEqual(markDeliveredByRemoteId(db, {
      platform: 'wa', account: 'nanya_wa', remoteMsgId: row.remote_msg_id,
    }), 1);
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('ok-1');
    assert.strictEqual(row.status, 'read');
    assert.strictEqual(row.provider_ack, 3);

    insertOutbound(db, {
      clientMsgId: 'stale-1',
      text: 'stale',
      status: 'sending',
      sendingStartedAt: toSqlTimestamp(Date.now() - 120000),
    });
    const stale = await consumer.runOnce();
    assert.strictEqual(stale.status, 'idle');
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('stale-1');
    assert.strictEqual(row.status, 'paused');
    assert.strictEqual(row.error_code, 'DELIVERY_OUTCOME_UNKNOWN');

    insertOutbound(db, {
      clientMsgId: 'stale-known-1',
      text: 'stale known result',
      status: 'sending',
      sendingStartedAt: toSqlTimestamp(Date.now() - 120000),
      remoteMsgId: 'already-returned-by-channel',
    });
    const staleKnown = await consumer.runOnce();
    assert.strictEqual(staleKnown.status, 'idle');
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('stale-known-1');
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
      minIntervalMs: 0,
      perMinuteLimit: 100,
      retryBaseMs: 0,
      sendMessage: async () => {
        const err = new Error('temporary channel failure');
        err.code = 'TEMP_FAIL';
        throw err;
      },
    });
    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'fail-1' });
    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'fail-2' });
    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'fail-3' });

    assert.strictEqual((await failingConsumer.runOnce()).status, 'retry_scheduled');
    assert.strictEqual((await failingConsumer.runOnce()).status, 'retry_scheduled');
    assert.strictEqual((await failingConsumer.runOnce()).status, 'paused');
    assert.ok(activeBreaker(db, 'tg', 'jason_tg'));
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('fail-1');
    assert.strictEqual(row.status, 'dead');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM outbound_attempts WHERE outbound_id = ?').get(row.id).count, 3);

    insertOutbound(db, { platform: 'tg', account: 'jason_tg', clientMsgId: 'paused-1' });
    const paused = await failingConsumer.runOnce();
    assert.strictEqual(paused.status, 'paused');
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('paused-1');
    assert.strictEqual(row.status, 'paused');
    assert.strictEqual(row.error_code, 'CIRCUIT_BREAKER');
    failingConsumer.close();

    insertOutbound(db, { account: 'lease-account', clientMsgId: 'lease-1' });
    const leaseClaim = claimNextPending(db, {
      platform: 'wa', account: 'lease-account', workerId: 'worker-a', leaseMs: 30000,
    });
    assert.ok(leaseClaim);
    assert.strictEqual(claimNextPending(db, {
      platform: 'wa', account: 'lease-account', workerId: 'worker-b', leaseMs: 30000,
    }), null);
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('lease-1');
    assert.strictEqual(row.owner_worker_id, 'worker-a');

    insertOutbound(db, { platform: 'tg', account: 'tg-flood', clientMsgId: 'flood-1' });
    const floodConsumer = createOutboundConsumer({
      db,
      platform: 'tg',
      account: 'tg-flood',
      minIntervalMs: 0,
      perMinuteLimit: 100,
      sendMessage: async () => {
        const err = new Error('FLOOD_WAIT_90');
        err.code = 'FLOOD_WAIT_90';
        throw err;
      },
    });
    assert.strictEqual((await floodConsumer.runOnce()).status, 'paused');
    const floodBreaker = activeBreaker(db, 'tg', 'tg-flood');
    assert.ok(floodBreaker);
    assert.ok(Date.parse(`${floodBreaker.cooldown_until}Z`) >= Date.now() + 85 * 1000);
    floodConsumer.close();

    insertOutbound(db, { platform: 'tg', account: 'tg-dead', clientMsgId: 'dead-1', retryCount: 2 });
    const deadConsumer = createOutboundConsumer({
      db,
      platform: 'tg',
      account: 'tg-dead',
      minIntervalMs: 0,
      perMinuteLimit: 100,
      sendMessage: async () => {
        const err = new Error('third failure');
        err.code = 'TEMP_FAIL';
        throw err;
      },
    });
    assert.strictEqual((await deadConsumer.runOnce()).status, 'dead');
    row = db.prepare('SELECT * FROM outbound_messages WHERE client_msg_id = ?').get('dead-1');
    assert.strictEqual(row.status, 'dead');
    deadConsumer.close();
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
  retryCount = 0,
  remoteMsgId = null,
} = {}) {
  db.prepare(`
    INSERT INTO outbound_messages (
      client_msg_id, platform, account, group_id, chat_id, text, attachment_json,
      status, created_by, sending_started_at, retry_count, remote_msg_id
    )
    VALUES (
      @clientMsgId, @platform, @account, @groupId, @groupId, @text, @attachmentJson,
      @status, 'demo-operator', @sendingStartedAt, @retryCount, @remoteMsgId
    )
  `).run({ clientMsgId, platform, account, groupId, text, attachmentJson, status, sendingStartedAt, retryCount, remoteMsgId });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
