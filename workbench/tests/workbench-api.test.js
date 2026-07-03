const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { openWorkbenchDb } = require('../db/workbench-db');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-api-'));
  const rawDbPath = path.join(tmpDir, 'database.sqlite');
  const workbenchDbPath = path.join(tmpDir, 'workbench.sqlite');
  const outboxDir = path.join(tmpDir, 'outbox');
  seedRawDb(rawDbPath);

  const workbenchDb = openWorkbenchDb(workbenchDbPath);
  const app = createApp({ workbenchDb, rawDbPath, outboxDir });
  const { server, port } = await listen(app);
  const baseUrl = `http://127.0.0.1:${port}/api/workbench`;

  try {
    const health = await requestJson(`${baseUrl}/health`);
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.raw_messages_db, 'available');
    assert.strictEqual(health.account_scope.mode, 'logged-in');
    assert.deepStrictEqual(health.account_scope.accounts, [{ platform: 'wa', account: 'nanya_wa' }]);

    const accounts = await requestJson(`${baseUrl}/accounts`);
    assert.strictEqual(accounts.ok, true);
    assert.strictEqual(accounts.accounts.length, 1);
    assert.strictEqual(accounts.accounts[0].account, 'nanya_wa');
    assert.strictEqual(accounts.accounts[0].account_display_name, 'Nanya Support');

    const groups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(groups.ok, true);
    assert.strictEqual(groups.groups.length, 1);
    assert.strictEqual(groups.groups[0].platform, 'wa');
    assert.strictEqual(groups.groups[0].account_display_name, 'Nanya Support');
    assert.strictEqual(groups.groups[0].unread_count, 2);

    const syncRequest = await requestJson(`${baseUrl}/channel-sync`, {
      method: 'POST',
      body: { platform: 'wa' },
    });
    assert.strictEqual(syncRequest.ok, true);
    assert.strictEqual(syncRequest.requests.length, 1);
    assert.ok(fs.readdirSync(path.join(outboxDir, 'sync-worker-wa-nanya_wa')).some((file) => file.endsWith('.json')));

    const hiddenSync = await requestRaw(`${baseUrl}/channel-sync`, {
      method: 'POST',
      body: { platform: 'tg' },
    });
    assert.strictEqual(hiddenSync.status, 404);

    seedSyncedChannelMetadata(workbenchDb);
    const labelList = await requestJson(`${baseUrl}/channel-labels?platform=wa`);
    assert.strictEqual(labelList.ok, true);
    assert.strictEqual(labelList.labels.some((label) => label.native_label_id === 'vip-sync'), true);
    const syncedGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&label_id=vip-sync`);
    assert.strictEqual(syncedGroups.ok, true);
    assert.strictEqual(syncedGroups.groups.length, 1);
    assert.strictEqual(syncedGroups.groups[0].group_id, 'group-synced-only');
    assert.strictEqual(syncedGroups.groups[0].labels[0].name, '同步标签');

    const replyBody = {
      client_msg_id: 'client-1',
      platform: 'wa',
      account: 'nanya_wa',
      group_id: 'group-1',
      text: '已为您查询，请稍等。',
    };
    const firstReply = await requestJson(`${baseUrl}/reply`, {
      method: 'POST',
      body: replyBody,
    });
    const secondReply = await requestJson(`${baseUrl}/reply`, {
      method: 'POST',
      body: replyBody,
    });
    assert.strictEqual(firstReply.status, 'pending');
    assert.strictEqual(secondReply.idempotent, true);
    assert.strictEqual(secondReply.outbound_id, firstReply.outbound_id);
    assert.ok(fs.existsSync(path.join(outboxDir, 'worker-wa-nanya_wa', `${firstReply.outbound_id}.json`)));

    const attachmentReply = await requestJson(`${baseUrl}/reply`, {
      method: 'POST',
      body: {
        client_msg_id: 'client-attachment-1',
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        text: '',
        attachments: [{
          id: 'attachment-1',
          name: 'paste.png',
          type: 'image/png',
          size: 8,
          kind: 'image',
          data_url: 'data:image/png;base64,iVBORw0KGgo=',
        }],
      },
    });
    assert.strictEqual(attachmentReply.status, 'pending');
    assert.ok(fs.existsSync(path.join(outboxDir, 'worker-wa-nanya_wa', `${attachmentReply.outbound_id}.json`)));
    const attachmentRow = workbenchDb.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(attachmentReply.outbound_id);
    const storedAttachments = JSON.parse(attachmentRow.attachment_json);
    assert.strictEqual(storedAttachments.length, 1);
    assert.strictEqual(storedAttachments[0].name, 'paste.png');
    assert.strictEqual(storedAttachments[0].kind, 'image');
    assert.ok(storedAttachments[0].data_url.startsWith('data:image/png;base64,'));

    const hiddenReply = await requestRaw(`${baseUrl}/reply`, {
      method: 'POST',
      body: {
        client_msg_id: 'client-hidden',
        platform: 'tg',
        account: 'jason_tg',
        group_id: 'group-hidden',
        text: 'should not be allowed',
      },
    });
    assert.strictEqual(hiddenReply.status, 403);
    assert.strictEqual(hiddenReply.payload.error, 'account is not available in this Workbench session');

    insertRawAccount(rawDbPath, {
      id: 'wa-extra',
      platform: 'whatsapp',
      status: 'authenticated',
      pushname: 'Extra Support',
    });
    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'wa-extra',
      messageId: 'extra-account-message-1',
      groupId: 'group-extra-account',
      groupName: '多账号筛选测试群',
      senderId: 'customer-extra',
      senderName: '客户C',
      content: 'extra account message',
      timestamp: 1782950465,
      rawData: '{}',
    });
    const filteredAccountGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&accounts=wa:wa-extra`);
    assert.strictEqual(filteredAccountGroups.groups.length, 1);
    assert.strictEqual(filteredAccountGroups.groups[0].account, 'wa-extra');
    assert.strictEqual(filteredAccountGroups.groups[0].group_id, 'group-extra-account');
    const unavailableAccountGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&accounts=wa:not-logged-in`);
    assert.strictEqual(unavailableAccountGroups.groups.length, 0);

    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'mention-inbound-1',
      groupId: 'group-mention',
      groupName: '提及显示测试群',
      senderId: '1703771844@c.us',
      senderName: '客户A',
      content: 'hello',
      timestamp: 1782950470,
      rawData: '{}',
    });
    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'mention-outbound-1',
      groupId: 'group-mention',
      groupName: '提及显示测试群',
      senderId: 'agent-demo',
      senderName: 'Nanya Support',
      content: '请看 @1703771844',
      timestamp: 1782950480,
      rawData: JSON.stringify({ fromMe: true }),
    });
    const mentionMessages = await requestJson(`${baseUrl}/groups/group-mention/messages?platform=wa&account=nanya_wa`);
    const mentionMessage = mentionMessages.messages.find((message) => message.message_id === 'mention-outbound-1');
    assert.strictEqual(mentionMessage.text, '请看 @1703771844');
    assert.strictEqual(mentionMessage.display_text, '请看 @客户A');

    const inboundUnread = insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'unread-inbound-1',
      groupId: 'group-outbound-unread',
      groupName: '自己消息未读测试群',
      senderId: 'customer-outbound-test',
      senderName: '客户B',
      content: 'incoming unread',
      timestamp: 1782950490,
      rawData: '{}',
    });
    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'unread-outbound-1',
      groupId: 'group-outbound-unread',
      groupName: '自己消息未读测试群',
      senderId: 'agent-demo',
      senderName: 'Nanya Support',
      content: 'self follow-up',
      timestamp: 1782950495,
      rawData: JSON.stringify({ fromMe: true }),
    });
    const outboundUnreadGroups = await requestJson(`${baseUrl}/groups?scope=all&search=${encodeURIComponent('自己消息未读测试群')}`);
    assert.strictEqual(outboundUnreadGroups.groups.length, 1);
    assert.strictEqual(outboundUnreadGroups.groups[0].unread_count, 1);
    const outboundUnreadRead = await requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-outbound-unread',
        last_read_message_id: inboundUnread.lastInsertRowid,
      },
    });
    assert.strictEqual(outboundUnreadRead.unread_count, 0);
    const readOutboundUnreadGroups = await requestJson(`${baseUrl}/groups?scope=all&search=${encodeURIComponent('自己消息未读测试群')}`);
    assert.strictEqual(readOutboundUnreadGroups.groups[0].unread_count, 0);

    const messages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa`);
    assert.strictEqual(messages.ok, true);
    assert.strictEqual(messages.messages.some((message) => message.source === 'workbench'), true);
    const attachmentMessage = messages.messages.find((message) => message.outbound_id === attachmentReply.outbound_id);
    assert.strictEqual(attachmentMessage.attachments[0].name, 'paste.png');
    const openedGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(openedGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 2);

    const sentOutbound = workbenchDb.prepare(`
      INSERT INTO outbound_messages (
        client_msg_id, platform, account, group_id, chat_id, text, status,
        remote_msg_id, created_by, created_at, sent_at
      )
      VALUES (
        'client-raw-merge', 'wa', 'nanya_wa', 'group-merge', 'group-merge',
        'sent from workbench', 'sent', 'raw-sent-1', 'demo-operator',
        '2026-07-02 07:08:07', '2026-07-02 07:08:07'
      )
    `).run();
    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'raw-sent-1',
      groupId: 'group-merge',
      groupName: '排序测试群',
      senderId: 'agent-demo',
      senderName: 'nanya_wa',
      content: 'sent from workbench',
      timestamp: 1782950500,
      rawData: JSON.stringify({ fromMe: true }),
    });
    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'raw-inbound-latest',
      groupId: 'group-merge',
      groupName: '排序测试群',
      senderId: 'customer-1',
      senderName: '客户',
      content: 'new inbound message',
      timestamp: 1782950520,
      rawData: '{}',
    });
    const mergedMessages = await requestJson(`${baseUrl}/groups/group-merge/messages?platform=wa&account=nanya_wa`);
    assert.strictEqual(mergedMessages.ok, true);
    assert.strictEqual(
      mergedMessages.messages.filter((message) => message.outbound_id === sentOutbound.lastInsertRowid).length,
      1,
    );
    const mergedRawOutbound = mergedMessages.messages.find((message) => message.message_id === 'raw-sent-1');
    assert.strictEqual(mergedRawOutbound.status, 'sent');
    assert.strictEqual(mergedMessages.messages.at(-1).message_id, 'raw-inbound-latest');

    const pagedMessages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa&limit=1`);
    assert.strictEqual(pagedMessages.ok, true);
    assert.strictEqual(pagedMessages.paging.has_more, true);
    assert.ok(pagedMessages.paging.before_id);
    const afterPagingGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(afterPagingGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 2);

    const partialRead = await requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        last_read_message_id: 1,
      },
    });
    assert.strictEqual(partialRead.unread_count, 1);
    const partiallyReadGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(partiallyReadGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 1);

    const fullRead = await requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        last_read_message_id: 2,
      },
    });
    assert.strictEqual(fullRead.unread_count, 0);
    const readGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(readGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 0);

    const canceled = await requestJson(`${baseUrl}/outbound/${firstReply.outbound_id}/cancel`, { method: 'POST' });
    assert.strictEqual(canceled.outbound.status, 'canceled');

    const retried = await requestJson(`${baseUrl}/outbound/${firstReply.outbound_id}/retry`, {
      method: 'POST',
      body: { client_msg_id: 'client-1-retry' },
    });
    assert.strictEqual(retried.outbound.status, 'pending');
    assert.strictEqual(retried.outbound.retry_of, firstReply.outbound_id);
    assert.ok(fs.existsSync(path.join(outboxDir, 'worker-wa-nanya_wa', `${retried.outbound.outbound_id}.json`)));

    const noAccessAccounts = await requestJson(`${baseUrl}/accounts`, {
      headers: { 'x-operator-id': 'agent-no-access' },
    });
    assert.strictEqual(noAccessAccounts.accounts.length, 0);

    workbenchDb.prepare(`
      INSERT INTO operator_service_group_scopes (
        operator_id, platform, service_account, native_group_id, can_view, can_reply, can_assign, can_manage
      )
      VALUES ('agent-readonly', 'wa', 'nanya_wa', '*', 1, 0, 0, 0)
    `).run();
    const readonlyAccounts = await requestJson(`${baseUrl}/accounts`, {
      headers: { 'x-operator-id': 'agent-readonly' },
    });
    assert.strictEqual(readonlyAccounts.accounts.length, 1);
    const readonlyGroups = await requestJson(`${baseUrl}/groups?scope=all`, {
      headers: { 'x-operator-id': 'agent-readonly' },
    });
    assert.ok(readonlyGroups.groups.length > 0);
    assert.strictEqual(readonlyGroups.groups.every((group) => group.permissions.can_view === true), true);
    assert.strictEqual(readonlyGroups.groups.every((group) => group.permissions.can_reply === false), true);
    const readonlyReply = await requestRaw(`${baseUrl}/reply`, {
      method: 'POST',
      headers: { 'x-operator-id': 'agent-readonly' },
      body: {
        client_msg_id: 'client-readonly-denied',
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        text: 'readonly should fail',
      },
    });
    assert.strictEqual(readonlyReply.status, 403);

    workbenchDb.prepare(`
      UPDATE operator_service_group_scopes
      SET can_reply = 1, can_assign = 1
      WHERE operator_id = 'agent-readonly'
    `).run();
    const agentReply = await requestJson(`${baseUrl}/reply`, {
      method: 'POST',
      headers: { 'x-operator-id': 'agent-readonly' },
      body: {
        client_msg_id: 'client-agent-allowed',
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        text: 'agent reply allowed',
      },
    });
    assert.strictEqual(agentReply.status, 'pending');
  } finally {
    await close(server);
    workbenchDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function seedRawDb(rawDbPath) {
  const db = new Database(rawDbPath);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      receiver_account TEXT,
      message_id TEXT NOT NULL,
      group_id TEXT,
      group_name TEXT,
      sender_id TEXT,
      sender_name TEXT,
      content TEXT,
      has_media BOOLEAN DEFAULT 0,
      media_path TEXT,
      timestamp INTEGER,
      raw_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, message_id)
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      pushname TEXT,
      display_name TEXT
    );
    CREATE TABLE channel_account_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      account TEXT NOT NULL UNIQUE,
      display_name TEXT,
      login_type TEXT NOT NULL DEFAULT 'unknown',
      account_role TEXT NOT NULL DEFAULT 'collector',
      workbench_visible INTEGER NOT NULL DEFAULT 0,
      collect_enabled INTEGER NOT NULL DEFAULT 1,
      send_enabled INTEGER NOT NULL DEFAULT 0,
      sync_groups_enabled INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'low',
      owner_team TEXT,
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO accounts (id, platform, status, pushname) VALUES (?, ?, ?, ?)').run('nanya_wa', 'whatsapp', 'authenticated', 'Nanya Support');
  db.prepare('INSERT INTO accounts (id, platform, status, pushname) VALUES (?, ?, ?, ?)').run('jason_tg', 'telegram', 'idle', 'Jason TG');
  db.prepare(`
    INSERT INTO channel_account_registry (
      platform, account, display_name, login_type, account_role,
      workbench_visible, collect_enabled, send_enabled, sync_groups_enabled, risk_level, status
    )
    VALUES
      ('wa', 'nanya_wa', 'Nanya Support', 'wa_personal_qr', 'service', 1, 1, 1, 1, 'medium', 'authenticated'),
      ('tg', 'jason_tg', 'Jason TG', 'telegram_bot_api', 'collector', 0, 1, 0, 0, 'low', 'idle')
  `).run();
  const insert = db.prepare(`
    INSERT INTO messages (
      platform, receiver_account, message_id, group_id, group_name,
      sender_id, sender_name, content, timestamp, raw_data
    )
    VALUES (@platform, @account, @messageId, @groupId, @groupName, @senderId, @senderName, @content, @timestamp, @rawData)
  `);
  insert.run({
    platform: 'whatsapp',
    account: 'nanya_wa',
    messageId: 'm-1',
    groupId: 'group-1',
    groupName: 'VIP 支持交流群',
    senderId: 'customer-1',
    senderName: '客户',
    content: '订单还没发货，可以帮我看一下吗？',
    timestamp: 1782950400,
    rawData: '{}',
  });
  insert.run({
    platform: 'whatsapp',
    account: 'nanya_wa',
    messageId: 'm-2',
    groupId: 'group-1',
    groupName: 'VIP 支持交流群',
    senderId: 'customer-1',
    senderName: '客户',
    content: '谢谢',
    timestamp: 1782950460,
    rawData: '{}',
  });
  insert.run({
    platform: 'telegram',
    account: 'jason_tg',
    messageId: 'm-hidden',
    groupId: 'group-hidden',
    groupName: '未登录账号会话',
    senderId: 'customer-hidden',
    senderName: '客户',
    content: '这条消息不应在工作台显示',
    timestamp: 1782950520,
    rawData: '{}',
  });
  db.close();
}

function seedSyncedChannelMetadata(db) {
  db.prepare(`
    INSERT INTO channel_groups (platform, account, group_id, group_name, kind, raw_json)
    VALUES ('wa', 'nanya_wa', 'group-synced-only', '仅同步群', 'group', '{}')
  `).run();
  db.prepare(`
    INSERT INTO channel_labels (platform, account, native_label_id, name, color, kind, raw_json)
    VALUES ('wa', 'nanya_wa', 'vip-sync', '同步标签', '#059669', 'label', '{}')
  `).run();
  db.prepare(`
    INSERT INTO conversation_label_map (platform, account, group_id, native_label_id)
    VALUES ('wa', 'nanya_wa', 'group-synced-only', 'vip-sync')
  `).run();
  db.prepare(`
    INSERT INTO service_groups (platform, service_account, native_group_id, name, source, color, raw_json)
    VALUES ('wa', 'nanya_wa', 'vip-sync', '同步标签', 'wa_label', '#059669', '{}')
  `).run();
  db.prepare(`
    INSERT INTO conversation_service_group_map (platform, service_account, chat_id, native_group_id)
    VALUES ('wa', 'nanya_wa', 'group-synced-only', 'vip-sync')
  `).run();
}

function insertRawMessage(rawDbPath, row) {
  const db = new Database(rawDbPath);
  try {
    return db.prepare(`
      INSERT INTO messages (
        platform, receiver_account, message_id, group_id, group_name,
        sender_id, sender_name, content, timestamp, raw_data
      )
      VALUES (@platform, @account, @messageId, @groupId, @groupName, @senderId, @senderName, @content, @timestamp, @rawData)
    `).run(row);
  } finally {
    db.close();
  }
}

function insertRawAccount(rawDbPath, row) {
  const db = new Database(rawDbPath);
  try {
    db.prepare(`
      INSERT INTO accounts (id, platform, status, pushname)
      VALUES (@id, @platform, @status, @pushname)
    `).run(row);
    db.prepare(`
      INSERT INTO channel_account_registry (
        platform, account, display_name, login_type, account_role,
        workbench_visible, collect_enabled, send_enabled, sync_groups_enabled, risk_level, status
      )
      VALUES (@registryPlatform, @id, @pushname, @loginType, @accountRole, 1, 1, 1, 1, 'low', @status)
      ON CONFLICT(account) DO UPDATE SET
        account_role = excluded.account_role,
        workbench_visible = excluded.workbench_visible,
        send_enabled = excluded.send_enabled,
        sync_groups_enabled = excluded.sync_groups_enabled
    `).run({
      ...row,
      registryPlatform: row.platform === 'whatsapp' ? 'wa' : row.platform === 'telegram' ? 'tg' : row.platform,
      loginType: row.platform === 'whatsapp' ? 'wa_personal_qr' : 'telegram_bot_api',
      accountRole: row.account_role || 'service',
    });
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
  const { response, payload } = await requestRaw(url, options);
  assert.ok(response.ok, `${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function requestRaw(url, options = {}) {
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
  return { response, status: response.status, payload };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
