const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createApp } = require('../server/index');
const { openWorkbenchDb } = require('../db/workbench-db');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-account-isolation-'));
  const rawDbPath = path.join(tmpDir, 'global-raw.sqlite');
  const runtimeDbPath = path.join(tmpDir, 'global-runtime.sqlite');
  const workbenchDbPath = path.join(tmpDir, 'control-workbench.sqlite');
  const authDbPath = path.join(tmpDir, 'auth.sqlite');
  const accountDataDir = path.join(tmpDir, 'accounts');
  const outboxDir = path.join(tmpDir, 'outbox');
  const workbenchDb = openWorkbenchDb(workbenchDbPath);
  const app = createApp({
    authDbPath,
    rawDbPath,
    runtimeDbPath,
    workbenchDb,
    outboxDir,
    accountDataDir,
    accountDbMode: 'isolated',
  });
  const { server, port } = await listen(app);
  const baseUrl = `http://127.0.0.1:${port}/api/workbench`;

  try {
    const waLogin = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-isolated',
        display_name: '隔离 WA',
        login_mode: 'wa_qr',
      },
    });
    assert.strictEqual(waLogin.ok, true);
    assert.strictEqual(waLogin.request.account_runtime_db_path, path.join(accountDataDir, 'wa', 'wa-isolated', 'runtime.sqlite'));

    const tgLogin = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'tg',
        account: 'tg-isolated',
        display_name: '隔离 TG',
        login_mode: 'tg_bot_token',
        credential: '123456:secret-token',
      },
    });
    assert.strictEqual(tgLogin.ok, true);
    assert.strictEqual(tgLogin.request.account_runtime_db_path, path.join(accountDataDir, 'tg', 'tg-isolated', 'runtime.sqlite'));

    assertLoginInAccountDb(accountDataDir, 'wa', 'wa-isolated', waLogin.request.request_id);
    assertLoginInAccountDb(accountDataDir, 'tg', 'tg-isolated', tgLogin.request.request_id);
    assertNoGlobalLogin(runtimeDbPath);
    assertProfileInAccountDb(accountDataDir, 'wa', 'wa-isolated', 'waiting_qr');
    assertProfileInAccountDb(accountDataDir, 'tg', 'tg-isolated', 'requested');
    assertNoGlobalProfile(rawDbPath);
    assert.ok(fs.existsSync(path.join(accountDataDir, 'wa', 'wa-isolated', 'workbench.sqlite')));
    assert.ok(fs.existsSync(path.join(outboxDir, 'login-worker-wa-wa-isolated')));

    const listed = await requestJson(`${baseUrl}/service-account-logins`);
    assert.strictEqual(listed.isolated, true);
    assert.strictEqual(listed.requests.some((request) => request.request_id === waLogin.request.request_id), true);
    assert.strictEqual(listed.requests.some((request) => request.request_id === tgLogin.request.request_id), true);
    assert.strictEqual(JSON.stringify(listed).includes('secret-token'), false);

    const patched = await requestJson(`${baseUrl}/service-account-logins/${waLogin.request.request_id}`, {
      method: 'PATCH',
      body: {
        status: 'waiting_qr',
        qr_payload: 'isolated-qr',
        worker_message: 'QR ready in account DB',
      },
    });
    assert.strictEqual(patched.request.qr_payload, 'isolated-qr');
    assert.strictEqual(readLogin(accountDataDir, 'wa', 'wa-isolated', waLogin.request.request_id).qr_payload, 'isolated-qr');

    const deleted = await requestJson(`${baseUrl}/service-account-logins/${tgLogin.request.request_id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(deleted.request.request_id, tgLogin.request.request_id);
    assert.strictEqual(deleted.request.permanent_deleted, true);
    assert.strictEqual(fs.existsSync(path.join(accountDataDir, 'tg', 'tg-isolated')), false);
    assert.strictEqual(fs.existsSync(path.join(outboxDir, 'login-worker-tg-tg-isolated')), false);

    const rawMessageId = insertAccountRawMessage(accountDataDir, 'wa', 'wa-isolated', {
      messageId: 'wa-isolated-message-1',
      groupId: 'isolated-group-1',
      groupName: '隔离账号群',
      senderId: 'customer-1',
      senderName: '客户1',
      content: 'hello isolated account',
      timestamp: 1783500000,
    });
    setAccountSendEnabled(accountDataDir, 'wa', 'wa-isolated', 1);

    const accounts = await requestJson(`${baseUrl}/accounts`);
    const isolatedAccount = accounts.accounts.find((account) => account.platform === 'wa' && account.account === 'wa-isolated');
    assert.ok(isolatedAccount);
    assert.strictEqual(isolatedAccount.message_count, 1);

    const groups = await requestJson(`${baseUrl}/groups?platforms=wa&accounts=wa:wa-isolated`);
    assert.strictEqual(groups.groups.length, 1);
    assert.strictEqual(groups.groups[0].group_id, 'isolated-group-1');
    assert.strictEqual(groups.groups[0].unread_count, 1);

    const read = await requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-isolated',
        group_id: 'isolated-group-1',
        last_read_message_id: rawMessageId,
      },
    });
    assert.strictEqual(read.unread_count, 0);
    assertAccountWorkbenchRow(accountDataDir, 'wa', 'wa-isolated', 'conversation_reads', 1);
    assertGlobalWorkbenchRowCount(workbenchDbPath, 'conversation_reads', 0);

    const reply = await requestJson(`${baseUrl}/reply`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-isolated',
        group_id: 'isolated-group-1',
        client_msg_id: 'isolated-client-1',
        text: 'reply from isolated workbench',
      },
    });
    assert.strictEqual(reply.status, 'pending');
    assert.strictEqual(reply.outbound_id, 'wa:wa-isolated:1');
    assertAccountWorkbenchRow(accountDataDir, 'wa', 'wa-isolated', 'outbound_messages', 1);
    assertGlobalWorkbenchRowCount(workbenchDbPath, 'outbound_messages', 0);
    assert.ok(fs.existsSync(path.join(outboxDir, 'worker-wa-wa-isolated', '1.json')));

    const messages = await requestJson(`${baseUrl}/groups/isolated-group-1/messages?platform=wa&account=wa-isolated`);
    assert.strictEqual(messages.messages.some((message) => message.outbound_id === 'wa:wa-isolated:1'), true);

    const canceled = await requestJson(`${baseUrl}/outbound/${encodeURIComponent(reply.outbound_id)}/cancel`, {
      method: 'POST',
    });
    assert.strictEqual(canceled.outbound.status, 'canceled');

    const retried = await requestJson(`${baseUrl}/outbound/${encodeURIComponent(reply.outbound_id)}/retry`, {
      method: 'POST',
      body: { client_msg_id: 'isolated-client-1-retry' },
    });
    assert.strictEqual(retried.outbound.status, 'pending');
    assert.strictEqual(retried.outbound.outbound_id, 'wa:wa-isolated:2');

    const assigned = await requestJson(`${baseUrl}/groups/isolated-group-1/assign`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-isolated',
        assigned_to: '1469',
      },
    });
    assert.strictEqual(assigned.assignment.assigned_to, '1469');
    const released = await requestJson(`${baseUrl}/groups/isolated-group-1/release`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-isolated',
      },
    });
    assert.strictEqual(released.released, 1);
    assertAccountWorkbenchRow(accountDataDir, 'wa', 'wa-isolated', 'group_assignments', 1);
    assertGlobalWorkbenchRowCount(workbenchDbPath, 'group_assignments', 0);

    const removedAccount = await requestJson(`${baseUrl}/accounts/wa/${encodeURIComponent('wa-isolated')}`, {
      method: 'DELETE',
    });
    assert.strictEqual(removedAccount.ok, true);
    assert.strictEqual(removedAccount.account, 'wa-isolated');
    assert.strictEqual(fs.existsSync(path.join(accountDataDir, 'wa', 'wa-isolated')), false);
  } finally {
    await close(server);
    workbenchDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function accountDbPath(accountDataDir, platform, account, fileName) {
  return path.join(accountDataDir, platform, account, fileName);
}

function readLogin(accountDataDir, platform, account, requestId) {
  const db = new Database(accountDbPath(accountDataDir, platform, account, 'runtime.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM service_account_login_requests WHERE request_id = ?').get(requestId) || null;
  } finally {
    db.close();
  }
}

function assertLoginInAccountDb(accountDataDir, platform, account, requestId) {
  const row = readLogin(accountDataDir, platform, account, requestId);
  assert.ok(row, `${platform}:${account} login request should be in account runtime DB`);
  assert.strictEqual(row.account, account);
}

function assertNoGlobalLogin(runtimeDbPath) {
  const db = new Database(runtimeDbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM service_account_login_requests').get();
    assert.strictEqual(row.count, 0);
  } finally {
    db.close();
  }
}

function assertProfileInAccountDb(accountDataDir, platform, account, status) {
  const db = new Database(accountDbPath(accountDataDir, platform, account, 'raw.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account);
    assert.ok(row, `${platform}:${account} profile should be in account raw DB`);
    assert.strictEqual(row.status, status);
  } finally {
    db.close();
  }
}

function assertNoGlobalProfile(rawDbPath) {
  const db = new Database(rawDbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM accounts').get();
    assert.strictEqual(row.count, 0);
  } finally {
    db.close();
  }
}

function insertAccountRawMessage(accountDataDir, platform, account, input) {
  const db = new Database(accountDbPath(accountDataDir, platform, account, 'raw.sqlite'));
  try {
    const result = db.prepare(`
      INSERT INTO messages (
        platform, receiver_account, message_id, group_id, group_name,
        sender_id, sender_name, content, has_media, timestamp, raw_data
      )
      VALUES (
        @platform, @account, @messageId, @groupId, @groupName,
        @senderId, @senderName, @content, 0, @timestamp, '{}'
      )
    `).run({
      platform,
      account,
      messageId: input.messageId,
      groupId: input.groupId,
      groupName: input.groupName,
      senderId: input.senderId,
      senderName: input.senderName,
      content: input.content,
      timestamp: input.timestamp,
    });
    return result.lastInsertRowid;
  } finally {
    db.close();
  }
}

function setAccountSendEnabled(accountDataDir, platform, account, sendEnabled) {
  const db = new Database(accountDbPath(accountDataDir, platform, account, 'raw.sqlite'));
  try {
    db.prepare(`
      UPDATE channel_account_registry
      SET send_enabled = ?
      WHERE account = ?
    `).run(sendEnabled, account);
  } finally {
    db.close();
  }
}

function assertAccountWorkbenchRow(accountDataDir, platform, account, tableName, expectedCount) {
  const db = new Database(accountDbPath(accountDataDir, platform, account, 'workbench.sqlite'), { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    assert.strictEqual(row.count, expectedCount);
  } finally {
    db.close();
  }
}

function assertGlobalWorkbenchRowCount(workbenchDbPath, tableName, expectedCount) {
  const db = new Database(workbenchDbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    assert.strictEqual(row.count, expectedCount);
  } finally {
    db.close();
  }
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not expose a TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-operator-id': '1469',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  assert.ok(response.ok, `${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
