process.env.LOCAL_DEV_AUTH_BYPASS = '1';
process.env.WORKBENCH_LOCAL_DEV_ADMIN_ID = '1469';
process.env.WORKBENCH_BOOTSTRAP_ADMIN = '1469';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const API_TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-api-data-'));
process.env.DATA_DIR = API_TEST_DATA_DIR;
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { openWorkbenchDb } = require('../db/workbench-db');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-api-'));
  const rawDbPath = path.join(tmpDir, 'database.sqlite');
  const workbenchDbPath = path.join(tmpDir, 'workbench.sqlite');
  const authDbPath = path.join(tmpDir, 'auth.sqlite');
  const outboxDir = path.join(tmpDir, 'outbox');
  const accountDataDir = path.join(tmpDir, 'accounts');
  seedRawDb(rawDbPath);
  seedLegacyWorkbenchDb(workbenchDbPath);

  const workbenchDb = openWorkbenchDb(workbenchDbPath);
  assertLegacyWorkbenchMigration(workbenchDb);
  const app = createApp({ authDbPath, workbenchDb, rawDbPath, outboxDir, accountDataDir, writeRateLimit: { max: 500 } });
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
    assert.strictEqual(accounts.accounts[0].is_connected, true);
    assert.strictEqual(accounts.accounts[0].global_send_enabled, false);
    assert.strictEqual(accounts.accounts[0].can_send, false);
    assert.strictEqual(accounts.accounts.some((account) => account.platform === 'teams'), false);

    const disabledSendSetting = await requestJson(`${baseUrl}/admin/accounts/wa/nanya_wa/settings`, {
      method: 'PATCH', body: { send_enabled: 0 },
    });
    assert.strictEqual(Number(disabledSendSetting.settings.send_enabled), 0);
    await requestJson(`${baseUrl}/admin/accounts/wa/nanya_wa/settings`, {
      method: 'PATCH', body: { send_enabled: 1 },
    });

    const adminAccess = await requestJson(`${baseUrl}/admin/access`);
    assert.strictEqual(adminAccess.ok, true);
    assert.ok(adminAccess.roles.some((role) => role.code === 'agent'));
    assert.ok(adminAccess.permissions.some((permission) => permission.code === 'workbench:view'));

    const createdUser = await requestJson(`${baseUrl}/admin/users`, {
      method: 'POST',
      body: {
        username: 'agent-api',
        display_name: '接口测试坐席',
        password: 'agent-pass-123',
        roles: ['agent'],
      },
    });
    assert.strictEqual(createdUser.ok, true);
    assert.strictEqual(createdUser.user.username, 'agent-api');
    assert.deepStrictEqual(createdUser.user.roles, ['agent']);

    const savedPortal = await requestJson(`${baseUrl}/admin/users/${createdUser.user.id}/portal-access`, {
      method: 'PUT',
      body: {
        can_monitor: false,
        can_workbench: false,
        can_admin: true,
        default_entry: 'admin',
      },
    });
    assert.strictEqual(savedPortal.portal_access.can_workbench, true);
    assert.strictEqual(savedPortal.portal_access.can_admin, false);
    assert.strictEqual(savedPortal.portal_access.default_entry, 'workbench');

    const savedScopes = await requestJson(`${baseUrl}/admin/users/${createdUser.user.id}/scopes`, {
      method: 'PUT',
      body: {
        scopes: [{
          platform: 'wa',
          service_account: 'nanya_wa',
          native_group_id: '*',
          can_view: true,
          can_reply: true,
          can_assign: false,
          can_manage: false,
        }],
      },
    });
    assert.strictEqual(savedScopes.scopes.length, 1);
    assert.strictEqual(savedScopes.scopes[0].service_account, 'nanya_wa');

    const savedAll = await requestJson(`${baseUrl}/admin/users/${createdUser.user.id}/access`, {
      method: 'PUT',
      body: {
        profile: {
          display_name: '一键保存坐席',
          status: 'active',
        },
        roles: ['agent'],
        scopes: savedScopes.scopes,
        role_permissions: {
          agent: ['workbench:view'],
        },
      },
    });
    assert.strictEqual(savedAll.user.display_name, '一键保存坐席');
    assert.deepStrictEqual(savedAll.user.roles, ['agent']);
    assert.strictEqual(savedAll.user.scopes.length, 1);
    assert.deepStrictEqual(
      savedAll.access.roles.find((role) => role.code === 'agent').permissions,
      ['workbench:view'],
    );

    const rejectedGlobalSave = await requestRaw(`${baseUrl}/admin/users/${createdUser.user.id}/access`, {
      method: 'PUT',
      body: {
        profile: { display_name: '不应保存' },
        roles: ['agent'],
        scopes: [{
          platform: 'wa',
          service_account: '',
          native_group_id: '*',
          can_view: true,
        }],
      },
    });
    assert.strictEqual(rejectedGlobalSave.status, 400);
    const accessAfterRejectedGlobalSave = await requestJson(`${baseUrl}/admin/access`);
    assert.strictEqual(
      accessAfterRejectedGlobalSave.users.find((user) => user.id === createdUser.user.id).display_name,
      '一键保存坐席',
    );

    const rejectedEmptyScope = await requestRaw(`${baseUrl}/admin/users/${createdUser.user.id}/scopes`, {
      method: 'PUT',
      body: {
        scopes: [{
          platform: 'wa',
          service_account: '',
          native_group_id: '*',
          can_view: true,
        }],
      },
    });
    assert.strictEqual(rejectedEmptyScope.response.status, 400);
    assert.strictEqual(countRows(workbenchDb, 'operator_service_group_scopes', 'operator_id', createdUser.user.id), 1);

    const deniedAdminDelete = await requestRaw(`${baseUrl}/admin/users/1469`, {
      method: 'DELETE',
    });
    assert.strictEqual(deniedAdminDelete.status, 400);

    const deletedUser = await requestJson(`${baseUrl}/admin/users/${createdUser.user.id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(deletedUser.ok, true);
    assert.strictEqual(deletedUser.deleted.id, createdUser.user.id);
    assert.strictEqual(deletedUser.access.users.some((user) => user.id === createdUser.user.id), false);
    assert.strictEqual(countRows(workbenchDb, 'operators', 'id', createdUser.user.id), 0);
    assert.strictEqual(countRows(workbenchDb, 'operator_roles', 'operator_id', createdUser.user.id), 0);
    assert.strictEqual(countRows(workbenchDb, 'operator_portal_access', 'operator_id', createdUser.user.id), 0);
    assert.strictEqual(countRows(workbenchDb, 'operator_service_group_scopes', 'operator_id', createdUser.user.id), 0);

    const groups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(groups.ok, true);
    assert.strictEqual(groups.groups.length, 1);
    assert.strictEqual(groups.groups[0].platform, 'wa');
    assert.strictEqual(groups.groups[0].account_display_name, 'Nanya Support');
    assert.strictEqual(groups.groups[0].unread_count, 3);
    assert.strictEqual(groups.groups.some((group) => group.platform === 'teams'), false);

    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'wa-phone-name-1',
      groupId: '2349067817414@c.us',
      groupName: '+234 906 781 7414',
      senderId: '2349067817414@c.us',
      senderName: 'Chris Laco',
      content: '媒体资料已收到',
      timestamp: 1782950461,
      rawData: '{}',
    });
    workbenchDb.prepare(`
      INSERT INTO channel_groups (platform, account, group_id, group_name, kind, raw_json)
      VALUES ('wa', 'nanya_wa', '2349067817414@c.us', '+234 906 781 7414', 'chat', '{}')
    `).run();
    const phoneNamedGroups = await requestJson(`${baseUrl}/groups?scope=all&search=${encodeURIComponent('Chris Laco')}`);
    assert.strictEqual(phoneNamedGroups.groups.length, 1);
    assert.strictEqual(phoneNamedGroups.groups[0].group_name, 'Chris Laco');

    const disabledOperator = await createScopedOperator(baseUrl, 'disabled-now', {
      status: 'disabled',
      portal: { can_workbench: true, can_admin: false },
      scope: { can_view: true, can_reply: true, can_manage: true },
    });
    assert.strictEqual((await requestRaw(`${baseUrl}/groups`, { headers: { 'x-operator-id': disabledOperator.id } })).status, 403);

    const legacyPortalOverride = await createScopedOperator(baseUrl, 'portal-denied', {
      portal: { can_workbench: false, can_admin: false },
      scope: { can_view: true, can_reply: true, can_manage: true },
    });
    assert.strictEqual((await requestRaw(`${baseUrl}/groups`, { headers: { 'x-operator-id': legacyPortalOverride.id } })).status, 200);
    await requestJson(`${baseUrl}/admin/users/${legacyPortalOverride.id}/roles`, {
      method: 'PUT',
      body: { roles: [] },
    });
    assert.strictEqual((await requestRaw(`${baseUrl}/groups`, { headers: { 'x-operator-id': legacyPortalOverride.id } })).status, 403);

    const readOnlyOperator = await createScopedOperator(baseUrl, 'read-only-note', {
      portal: { can_workbench: true, can_admin: false },
      scope: { can_view: true, can_reply: false, can_manage: false },
    });
    assert.strictEqual((await requestRaw(`${baseUrl}/groups/group-1/workspace?platform=wa&account=nanya_wa`, {
      headers: { 'x-operator-id': readOnlyOperator.id },
    })).status, 200);
    assert.strictEqual((await requestRaw(`${baseUrl}/groups/group-1/notes`, {
      method: 'POST',
      headers: { 'x-operator-id': readOnlyOperator.id },
      body: { platform: 'wa', account: 'nanya_wa', body: '不应写入' },
    })).status, 403);

    const revokedOperator = await createScopedOperator(baseUrl, 'scope-revoked', {
      portal: { can_workbench: true, can_admin: false },
      scope: { can_view: true, can_reply: true, can_manage: false },
    });
    const visibleBeforeRevoke = await requestJson(`${baseUrl}/groups`, { headers: { 'x-operator-id': revokedOperator.id } });
    assert.strictEqual(visibleBeforeRevoke.groups.length, 2);
    await requestJson(`${baseUrl}/admin/users/${revokedOperator.id}/scopes`, { method: 'PUT', body: { scopes: [] } });
    const visibleAfterRevoke = await requestJson(`${baseUrl}/groups`, { headers: { 'x-operator-id': revokedOperator.id } });
    assert.strictEqual(visibleAfterRevoke.groups.length, 0);

    const teamsGroups = await requestJson(`${baseUrl}/groups?scope=all&platforms=teams`);
    assert.strictEqual(teamsGroups.ok, true);
    assert.strictEqual(teamsGroups.groups.length, 0);

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

    const teamsSync = await requestRaw(`${baseUrl}/channel-sync`, {
      method: 'POST',
      body: { platform: 'teams' },
    });
    assert.strictEqual(teamsSync.status, 400);
    assert.strictEqual(teamsSync.payload.error, 'platform must be one of wa, tg');

    const waLogin = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-login-test',
        display_name: '登录测试 WA',
        login_mode: 'wa_qr',
      },
    });
    assert.strictEqual(waLogin.ok, true);
    assert.strictEqual(waLogin.request.platform, 'wa');
    assert.strictEqual(waLogin.request.status, 'waiting_qr');
    assert.ok(fs.readdirSync(path.join(outboxDir, 'login-worker-wa-wa-login-test')).some((file) => file.endsWith('.json')));

    const waQrPatch = await requestJson(`${baseUrl}/service-account-logins/${waLogin.request.request_id}`, {
      method: 'PATCH',
      body: {
        status: 'waiting_qr',
        qr_payload: 'wa-qr-payload-for-render-test',
        worker_message: 'QR ready',
      },
    });
    assert.strictEqual(waQrPatch.request.qr_payload, 'wa-qr-payload-for-render-test');
    assert.strictEqual(waQrPatch.request.worker_message, 'QR ready');

    const waLoginReplacement = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'wa-login-test',
        display_name: '登录测试 WA 新任务',
        login_mode: 'wa_qr',
      },
    });
    assert.strictEqual(waLoginReplacement.request.status, 'waiting_qr');
    const supersededWaLogin = await requestJson(`${baseUrl}/service-account-logins/${waLogin.request.request_id}`);
    assert.strictEqual(supersededWaLogin.request.status, 'canceled');
    assert.strictEqual(supersededWaLogin.request.worker_message, '已被新的登录任务取代');

    const tgLogin = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'tg',
        account: 'tg-login-bot',
        display_name: '登录测试 TG',
        login_mode: 'tg_bot_token',
        credential: '123456:super-secret-token',
      },
    });
    assert.strictEqual(tgLogin.request.credential_hint, '123456:***');
    assert.strictEqual(JSON.stringify(tgLogin).includes('super-secret-token'), false);
    const loginRequests = await requestJson(`${baseUrl}/service-account-logins`);
    assert.strictEqual(loginRequests.requests.some((request) => request.request_id === tgLogin.request.request_id), true);
    assert.strictEqual(JSON.stringify(loginRequests).includes('super-secret-token'), false);
    const tgLoginFiles = fs.readdirSync(path.join(outboxDir, 'login-worker-tg-tg-login-bot'))
      .filter((file) => file.endsWith('.json'));
    assert.ok(tgLoginFiles.length >= 1);
    const tgDoorbell = JSON.parse(fs.readFileSync(path.join(outboxDir, 'login-worker-tg-tg-login-bot', tgLoginFiles[0]), 'utf8'));
    assert.strictEqual(tgDoorbell.credential.value, '123456:super-secret-token');

    const tgLoginReplacement = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'tg',
        account: 'tg-login-bot',
        display_name: '登录测试 TG 新任务',
        login_mode: 'tg_bot_token',
        credential: '123456:replacement-token',
      },
    });
    assert.strictEqual(tgLoginReplacement.request.account, 'tg-login-bot');

    const tgUserMissingApi = await requestRaw(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'tg',
        account: 'tg-user-missing-api',
        display_name: '缺少 API 的 TG 用户号',
        login_mode: 'tg_user_session',
        credential: 'string-session-only',
      },
    });
    assert.strictEqual(tgUserMissingApi.status, 400);
    assert.match(tgUserMissingApi.payload.error, /api_id/);

    const tgUserLogin = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'tg',
        account: 'tg-user-login',
        display_name: '登录测试 TG 用户号',
        login_mode: 'tg_user_session',
        credential: '1A2B3C4D5E6F-session',
        tg_api_id: 7654321,
        tg_api_hash: 'abcdef0123456789abcdef0123456789',
      },
    });
    assert.strictEqual(tgUserLogin.request.credential_hint, 'api_id 7654321 · session 1A2B***sion');
    assert.strictEqual(JSON.stringify(tgUserLogin).includes('abcdef0123456789abcdef0123456789'), false);
    assert.strictEqual(JSON.stringify(tgUserLogin).includes('1A2B3C4D5E6F-session'), false);
    const tgUserFiles = fs.readdirSync(path.join(outboxDir, 'login-worker-tg-tg-user-login'))
      .filter((file) => file.endsWith('.json'));
    assert.ok(tgUserFiles.length >= 1);
    const tgUserDoorbell = JSON.parse(fs.readFileSync(path.join(outboxDir, 'login-worker-tg-tg-user-login', tgUserFiles[0]), 'utf8'));
    assert.strictEqual(tgUserDoorbell.credential.value, '1A2B3C4D5E6F-session');
    assert.strictEqual(tgUserDoorbell.credential.api_id, 7654321);
    assert.strictEqual(tgUserDoorbell.credential.api_hash, 'abcdef0123456789abcdef0123456789');

    const tgPhoneLogin = await requestJson(`${baseUrl}/service-account-logins`, {
      method: 'POST',
      body: {
        platform: 'tg',
        account: 'tg-phone-login',
        display_name: '登录测试 TG 手机号',
        login_mode: 'tg_user_phone',
        tg_api_id: 112233,
        tg_api_hash: 'fedcba9876543210fedcba9876543210',
        tg_phone_number: '+8613800000000',
      },
    });
    assert.strictEqual(tgPhoneLogin.request.login_mode, 'tg_user_phone');
    assert.strictEqual(tgPhoneLogin.request.credential_hint, 'api_id 112233 · phone +861***0000');
    assert.strictEqual(JSON.stringify(tgPhoneLogin).includes('fedcba9876543210fedcba9876543210'), false);
    assert.strictEqual(JSON.stringify(tgPhoneLogin).includes('+8613800000000'), false);
    const tgPhoneFiles = fs.readdirSync(path.join(outboxDir, 'login-worker-tg-tg-phone-login'))
      .filter((file) => file.endsWith('.json'));
    assert.ok(tgPhoneFiles.length >= 1);
    const tgPhoneDoorbell = JSON.parse(fs.readFileSync(path.join(outboxDir, 'login-worker-tg-tg-phone-login', tgPhoneFiles[0]), 'utf8'));
    assert.strictEqual(tgPhoneDoorbell.credential.phase, 'start');
    assert.strictEqual(tgPhoneDoorbell.credential.api_id, 112233);
    assert.strictEqual(tgPhoneDoorbell.credential.api_hash, 'fedcba9876543210fedcba9876543210');
    assert.strictEqual(tgPhoneDoorbell.credential.phone_number, '+8613800000000');

    await requestJson(`${baseUrl}/service-account-logins/${tgPhoneLogin.request.request_id}`, {
      method: 'PATCH',
      body: {
        status: 'waiting_code',
        worker_message: '验证码已发送',
      },
    });
    const tgPhoneVerify = await requestJson(`${baseUrl}/service-account-logins/${tgPhoneLogin.request.request_id}/verify`, {
      method: 'POST',
      body: {
        code: '12345',
      },
    });
    assert.strictEqual(tgPhoneVerify.request.status, 'waiting_verification');
    assert.strictEqual(JSON.stringify(tgPhoneVerify).includes('12345'), false);
    const tgPhoneFilesAfterVerify = fs.readdirSync(path.join(outboxDir, 'login-worker-tg-tg-phone-login'))
      .filter((file) => file.endsWith('.json'));
    const tgPhoneVerifyDoorbell = tgPhoneFilesAfterVerify
      .map((file) => JSON.parse(fs.readFileSync(path.join(outboxDir, 'login-worker-tg-tg-phone-login', file), 'utf8')))
      .find((payload) => payload.action === 'verify');
    assert.ok(tgPhoneVerifyDoorbell);
    assert.strictEqual(tgPhoneVerifyDoorbell.credential.code, '12345');
    assert.strictEqual(tgPhoneVerifyDoorbell.credential.phase, 'verify');

    await requestJson(`${baseUrl}/service-account-logins/${tgPhoneLogin.request.request_id}`, {
      method: 'PATCH',
      body: {
        status: 'waiting_password',
        worker_message: '需要二步密码',
      },
    });
    const tgPhonePasswordVerify = await requestJson(`${baseUrl}/service-account-logins/${tgPhoneLogin.request.request_id}/verify`, {
      method: 'POST',
      body: {
        password: 'two-step-secret',
      },
    });
    assert.strictEqual(tgPhonePasswordVerify.request.status, 'waiting_verification');
    assert.strictEqual(JSON.stringify(tgPhonePasswordVerify).includes('two-step-secret'), false);

    const deletedTgLogin = await requestJson(`${baseUrl}/service-account-logins/${tgLogin.request.request_id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(deletedTgLogin.ok, true);
    assert.strictEqual(deletedTgLogin.request.request_id, tgLogin.request.request_id);
    assert.strictEqual(deletedTgLogin.request.permanent_deleted, true);
    const loginRequestsAfterDelete = await requestJson(`${baseUrl}/service-account-logins`);
    assert.strictEqual(loginRequestsAfterDelete.requests.some((request) => request.request_id === tgLogin.request.request_id), false);
    assert.strictEqual(loginRequestsAfterDelete.requests.some((request) => request.account === 'tg-login-bot'), false);
    assert.strictEqual(fs.existsSync(path.join(outboxDir, 'login-worker-tg-tg-login-bot')), false);
    assert.strictEqual(countRowsInDbPath(rawDbPath, 'accounts', 'id', 'tg-login-bot'), 0);
    assert.strictEqual(countRowsInDbPath(rawDbPath, 'channel_account_registry', 'account', 'tg-login-bot'), 0);

    insertRawAccount(rawDbPath, {
      id: 'wa-no-messages',
      platform: 'whatsapp',
      status: 'authenticated',
      pushname: 'No Message Support',
    });
    const accountsWithEmptyService = await requestJson(`${baseUrl}/accounts`);
    const emptyServiceAccount = accountsWithEmptyService.accounts.find((account) => account.account === 'wa-no-messages');
    assert.ok(emptyServiceAccount);
    assert.strictEqual(emptyServiceAccount.account_display_name, 'No Message Support');
    assert.strictEqual(emptyServiceAccount.message_count, 0);
    assert.strictEqual(emptyServiceAccount.is_connected, true);

    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'lid-name-message-1',
      groupId: '77408698953978@lid',
      groupName: '77408698953978@lid',
      senderId: '77408698953978@lid',
      senderName: '',
      content: 'LID name resolution test',
      timestamp: 1782950455,
      rawData: '{}',
    });
    insertRawMessage(rawDbPath, {
      platform: 'whatsapp',
      account: 'nanya_wa',
      messageId: 'account-name-collision-1',
      groupId: 'account-name-collision@g.us',
      groupName: 'Nanya Support',
      senderId: 'nanya_wa',
      senderName: 'Nanya Support',
      content: 'account name collision test',
      timestamp: 1782950456,
      rawData: JSON.stringify({ fromMe: true }),
    });
    seedSyncedChannelMetadata(workbenchDb);
    const resolvedLidGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&search=${encodeURIComponent('真实客户名称')}`);
    assert.strictEqual(resolvedLidGroups.groups.length, 1);
    assert.strictEqual(resolvedLidGroups.groups[0].group_id, '77408698953978@lid');
    assert.strictEqual(resolvedLidGroups.groups[0].group_name, '真实客户名称');
    const accountNameCollisionGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&search=${encodeURIComponent('account-name-collision@g.us')}`);
    assert.strictEqual(accountNameCollisionGroups.groups.length, 1);
    assert.strictEqual(accountNameCollisionGroups.groups[0].group_name, 'account-name-collision@g.us');
    const labelList = await requestJson(`${baseUrl}/channel-labels?platform=wa`);
    assert.strictEqual(labelList.ok, true);
    assert.strictEqual(labelList.labels.some((label) => label.native_label_id === 'vip-sync'), true);
    const syncedGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&label_id=vip-sync`);
    assert.strictEqual(syncedGroups.ok, true);
    assert.strictEqual(syncedGroups.groups.length, 1);
    assert.strictEqual(syncedGroups.groups[0].group_id, 'group-synced-only');
    assert.strictEqual(syncedGroups.groups[0].labels[0].name, '同步标签');

    const manualLevelOne = await requestJson(`${baseUrl}/manual-groups`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        name: '售后支持',
        group_level: 1,
      },
    });
    assert.strictEqual(manualLevelOne.ok, true);
    assert.strictEqual(manualLevelOne.group.group_level, 1);
    assert.strictEqual(manualLevelOne.group.is_manual, 1);

    const manualLevelTwo = await requestJson(`${baseUrl}/manual-groups`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        name: 'VIP 客户',
        group_level: 2,
        parent_native_group_id: manualLevelOne.group.native_group_id,
      },
    });
    assert.strictEqual(manualLevelTwo.ok, true);
    assert.strictEqual(manualLevelTwo.group.group_level, 2);
    assert.strictEqual(manualLevelTwo.group.parent_native_group_id, manualLevelOne.group.native_group_id);

    const manualGroupList = await requestJson(`${baseUrl}/manual-groups?platform=wa`);
    assert.strictEqual(
      manualGroupList.groups.some((group) => group.native_group_id === manualLevelOne.group.native_group_id),
      true,
    );
    assert.strictEqual(
      manualGroupList.groups.some((group) => group.native_group_id === manualLevelTwo.group.native_group_id),
      true,
    );

    const saveManualGroups = await requestJson(`${baseUrl}/groups/group-1/manual-groups`, {
      method: 'PUT',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        manual_group_ids: [manualLevelTwo.group.native_group_id],
      },
    });
    assert.strictEqual(saveManualGroups.ok, true);
    assert.strictEqual(saveManualGroups.labels.length, 1);
    assert.strictEqual(saveManualGroups.labels[0].name, 'VIP 客户');
    assert.strictEqual(saveManualGroups.labels[0].parent_name, '售后支持');

    const customerType = await requestJson(`${baseUrl}/admin/accounts/wa/nanya_wa/customer-types`, {
      method: 'POST',
      body: { name: 'VIP', color: '#0f766e' },
    });
    assert.strictEqual(customerType.option.name, 'VIP');

    const savedWorkspace = await requestJson(`${baseUrl}/groups/group-1/workspace`, {
      method: 'PATCH',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        status: 'in_progress',
        priority: 'high',
        starred: true,
        follow_up_at: '2026-07-09T10:30:00.000Z',
        internal_display_name: '重点 VIP 群',
        customer_type_id: customerType.option.id,
        owner_note: '交由白班继续跟进',
      },
    });
    assert.strictEqual(savedWorkspace.ok, true);
    assert.strictEqual(savedWorkspace.profile.status, 'in_progress');
    assert.strictEqual(savedWorkspace.profile.priority, 'high');
    assert.strictEqual(savedWorkspace.profile.starred, true);
    assert.strictEqual(savedWorkspace.profile.internal_display_name, '重点 VIP 群');
    const isolatedStatusGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(
      isolatedStatusGroups.groups.find((group) => group.group_id === 'group-1').conversation_status,
      'in_progress',
    );
    assert.strictEqual(
      isolatedStatusGroups.groups.find((group) => group.group_id === '2349067817414@c.us').conversation_status,
      'pending',
    );

    const note = await requestJson(`${baseUrl}/groups/group-1/notes`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        body: '客户催发货，已备注仓库。',
      },
    });
    assert.strictEqual(note.ok, true);
    assert.strictEqual(note.note.body, '客户催发货，已备注仓库。');
    assert.strictEqual(note.note.actor_name, '1469');

    const noteOwner = await createScopedOperator(baseUrl, 'note-owner', {
      portal: { can_workbench: true, can_admin: false },
      scope: { can_view: true, can_reply: true, can_manage: false },
    });
    const ownedNote = await requestJson(`${baseUrl}/groups/group-1/notes`, {
      method: 'POST',
      headers: { 'x-operator-id': noteOwner.id },
      body: { platform: 'wa', account: 'nanya_wa', body: '待删除的坐席备注' },
    });
    assert.strictEqual((await requestRaw(`${baseUrl}/groups/group-1/notes/${ownedNote.note.id}?platform=wa&account=nanya_wa`, {
      method: 'DELETE',
      headers: { 'x-operator-id': readOnlyOperator.id },
    })).status, 403);
    const deletedOwnedNote = await requestJson(`${baseUrl}/groups/group-1/notes/${ownedNote.note.id}?platform=wa&account=nanya_wa`, {
      method: 'DELETE',
      headers: { 'x-operator-id': noteOwner.id },
    });
    assert.strictEqual(deletedOwnedNote.deleted_note_id, ownedNote.note.id);
    const managerDeleteTarget = await requestJson(`${baseUrl}/groups/group-1/notes`, {
      method: 'POST',
      headers: { 'x-operator-id': noteOwner.id },
      body: { platform: 'wa', account: 'nanya_wa', body: '管理员删除验证' },
    });
    const managerDeletedNote = await requestJson(`${baseUrl}/groups/group-1/notes/${managerDeleteTarget.note.id}?platform=wa&account=nanya_wa`, {
      method: 'DELETE',
    });
    assert.strictEqual(managerDeletedNote.deleted_note_id, managerDeleteTarget.note.id);
    assert.strictEqual((await requestJson(`${baseUrl}/groups/group-1/notes?platform=wa&account=nanya_wa`)).notes.some((item) => item.id === ownedNote.note.id), false);

    const presencePeer = await createScopedOperator(baseUrl, 'presence-peer', {
      portal: { can_workbench: true, can_admin: false },
      scope: { can_view: true, can_reply: false, can_manage: false },
    });
    await requestJson(`${baseUrl}/groups/group-1/presence`, {
      method: 'POST',
      headers: { 'x-operator-id': presencePeer.id },
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        mode: 'viewing',
        active: true,
      },
    });
    const presence = await requestJson(`${baseUrl}/groups/group-1/presence`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        mode: 'viewing',
        active: true,
      },
    });
    assert.strictEqual(presence.ok, true);
    assert.strictEqual(presence.presence.some((item) => item.operator_id === '1469' && item.mode === 'viewing'), true);
    assert.strictEqual(presence.presence.some((item) => item.operator_id === presencePeer.id && item.actor_name === 'presence-peer'), true);

    const workspace = await requestJson(`${baseUrl}/groups/group-1/workspace?platform=wa&account=nanya_wa`);
    assert.strictEqual(workspace.profile.customer_type, 'VIP');
    assert.strictEqual(workspace.profile.customer_type_id, customerType.option.id);
    assert.strictEqual(workspace.notes.length, 1);

    const customerTypeFiltered = await requestJson(`${baseUrl}/groups?scope=all&customer_type_id=${encodeURIComponent(customerType.option.id)}`);
    assert.strictEqual(customerTypeFiltered.groups.length, 1);
    assert.strictEqual(customerTypeFiltered.groups[0].group_id, 'group-1');
    await requestJson(`${baseUrl}/admin/accounts/wa/nanya_wa/customer-types/${customerType.option.id}`, { method: 'DELETE' });
    const activeCustomerTypes = await requestJson(`${baseUrl}/accounts/wa/nanya_wa/customer-types`);
    assert.strictEqual(activeCustomerTypes.options.some((option) => option.id === customerType.option.id), false);
    const workspaceWithDisabledType = await requestJson(`${baseUrl}/groups/group-1/workspace?platform=wa&account=nanya_wa`);
    assert.strictEqual(workspaceWithDisabledType.profile.customer_type, 'VIP');
    assert.strictEqual(workspace.timeline.some((event) => event.action_type === 'conversation.note.create'), true);

    const bulkStatus = await requestJson(`${baseUrl}/groups/bulk`, {
      method: 'POST',
      body: {
        action: 'status',
        status: 'resolved',
        items: [{
          platform: 'wa',
          account: 'nanya_wa',
          group_id: 'group-1',
          last_message_id: 2,
        }],
      },
    });
    assert.strictEqual(bulkStatus.changed, 1);
    const bulkStar = await requestJson(`${baseUrl}/groups/bulk`, {
      method: 'POST',
      body: {
        action: 'star',
        starred: true,
        items: [{
          platform: 'wa',
          account: 'nanya_wa',
          group_id: 'group-1',
          last_message_id: 2,
        }],
      },
    });
    assert.strictEqual(bulkStar.changed, 1);
    const bulkTag = await requestJson(`${baseUrl}/groups/bulk`, {
      method: 'POST',
      body: {
        action: 'add_tags',
        manual_group_ids: [manualLevelOne.group.native_group_id],
        items: [{
          platform: 'wa',
          account: 'nanya_wa',
          group_id: 'group-1',
        }],
      },
    });
    assert.strictEqual(bulkTag.changed, 1);

    const manualChildFilter = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&label_id=${encodeURIComponent(manualLevelTwo.group.native_group_id)}`);
    assert.strictEqual(manualChildFilter.groups.some((group) => group.group_id === 'group-1'), true);
    const manualParentFilter = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all&label_id=${encodeURIComponent(manualLevelOne.group.native_group_id)}`);
    assert.strictEqual(manualParentFilter.groups.some((group) => group.group_id === 'group-1'), true);

    workbenchDb.prepare(`
      INSERT INTO operator_service_group_scopes (
        operator_id, platform, service_account, native_group_id, can_view, can_reply, can_assign, can_manage
      )
      VALUES ('agent-parent-scope', 'wa', 'nanya_wa', ?, 1, 0, 0, 0)
    `).run(manualLevelOne.group.native_group_id);
    const parentScopedGroups = await requestJson(`${baseUrl}/groups?platforms=wa&scope=all`, {
      headers: { 'x-operator-id': 'agent-parent-scope' },
    });
    assert.strictEqual(parentScopedGroups.groups.some((group) => group.group_id === 'group-1'), true);
    assert.strictEqual(parentScopedGroups.groups.some((group) => group.group_id === 'group-synced-only'), false);

    const replyBody = {
      client_msg_id: 'client-1',
      platform: 'wa',
      account: 'nanya_wa',
      group_id: 'group-1',
      text: '已为您查询，请稍等。',
      quote_msg_id: 'm-2',
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
    assert.strictEqual(storedAttachments[0].data_url, undefined);
    assert.ok(storedAttachments[0].local_path.startsWith('attachments/outbound/'));
    assert.match(storedAttachments[0].sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(workbenchDb.prepare('SELECT COUNT(*) AS count FROM outbound_attachments WHERE outbound_id = ?').get(attachmentReply.outbound_id).count, 1);
    workbenchDb.prepare(`
      UPDATE outbound_messages
      SET remote_msg_id = 'wa-attachment-echo-1', status = 'sent'
      WHERE id = ?
    `).run(attachmentReply.outbound_id);
    const rawAttachmentDb = new Database(rawDbPath);
    try {
      rawAttachmentDb.prepare(`
        INSERT INTO messages (
          platform, receiver_account, message_id, group_id, group_name,
          sender_id, sender_name, direction, content, has_media,
          media_name, media_mime, media_size, timestamp, raw_data
        ) VALUES (
          'whatsapp', 'nanya_wa', 'wa-attachment-echo-1', 'group-1', 'VIP 支持交流群',
          'nanya_wa', 'Nanya Support', 'outbound', '图片', 1,
          'paste.png', 'image/png', 8, 1782950430, @rawData
        )
      `).run({ rawData: JSON.stringify({ fromMe: true, media: { kind: 'image', name: 'paste.png', mime: 'image/png', size: 8 } }) });
    } finally {
      rawAttachmentDb.close();
    }

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

    const inboundMediaRelativePath = path.join('media', '2026-07', 'inbound-preview.png');
    const inboundMediaPath = path.join(API_TEST_DATA_DIR, inboundMediaRelativePath);
    const inboundMediaBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.mkdirSync(path.dirname(inboundMediaPath), { recursive: true });
    fs.writeFileSync(inboundMediaPath, inboundMediaBytes);
    const inboundDocumentFixtures = [
      {
        messageId: 'wa-document-word-1',
        relativePath: path.join('media', '2026-07', 'contract.docx'),
        name: 'contract.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: Buffer.from('word-document-test'),
      },
      {
        messageId: 'wa-document-excel-1',
        relativePath: path.join('media', '2026-07', 'report.xlsx'),
        name: 'report.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: Buffer.from('excel-document-test'),
      },
    ];
    inboundDocumentFixtures.forEach((fixture) => {
      fs.writeFileSync(path.join(API_TEST_DATA_DIR, fixture.relativePath), fixture.bytes);
    });
    let inboundMediaRowId;
    const inboundDocumentRowIds = [];
    const mediaDb = new Database(rawDbPath);
    try {
      mediaDb.prepare(`
        INSERT INTO messages (
          platform, receiver_account, message_id, group_id, group_name,
          sender_id, sender_name, direction, content, has_media,
          media_name, media_mime, media_size, timestamp, raw_data
        ) VALUES (
          'whatsapp', 'nanya_wa', 'wa-media-pending-1', 'group-1', 'VIP 支持交流群',
          'nanya_wa', 'Nanya Support', 'outbound', '图片', 1,
          'wa-media-1.png', 'image/png', 2048, 1782950420, @rawData
        )
      `).run({ rawData: JSON.stringify({ fromMe: true, media: { kind: 'image', name: 'wa-media-1.png', mime: 'image/png', size: 2048 } }) });
      inboundMediaRowId = mediaDb.prepare(`
        INSERT INTO messages (
          platform, receiver_account, message_id, group_id, group_name,
          sender_id, sender_name, direction, content, has_media,
          media_path, media_name, media_mime, media_size, timestamp, raw_data
        ) VALUES (
          'whatsapp', 'nanya_wa', 'wa-media-stored-1', 'group-1', 'VIP 支持交流群',
          'customer-1', '客户', 'inbound', '图片', 1,
          @mediaPath, 'inbound-preview.png', 'image/png', @mediaSize, 1782950421, @rawData
        )
      `).run({
        mediaPath: inboundMediaRelativePath,
        mediaSize: inboundMediaBytes.length,
        rawData: JSON.stringify({ fromMe: false, media: { kind: 'image', name: 'inbound-preview.png', mime: 'image/png', size: inboundMediaBytes.length } }),
      }).lastInsertRowid;
      const insertDocument = mediaDb.prepare(`
        INSERT INTO messages (
          platform, receiver_account, message_id, group_id, group_name,
          sender_id, sender_name, direction, content, has_media,
          media_path, media_name, media_mime, media_size, timestamp, raw_data
        ) VALUES (
          'whatsapp', 'nanya_wa', @messageId, 'group-1', 'VIP 支持交流群',
          'customer-1', '客户', 'inbound', '文件', 1,
          @mediaPath, @mediaName, @mediaMime, @mediaSize, @timestamp, @rawData
        )
      `);
      inboundDocumentFixtures.forEach((fixture, index) => {
        inboundDocumentRowIds.push(insertDocument.run({
          messageId: fixture.messageId,
          mediaPath: fixture.relativePath,
          mediaName: fixture.name,
          mediaMime: fixture.mime,
          mediaSize: fixture.bytes.length,
          timestamp: 1782950422 + index,
          rawData: JSON.stringify({ fromMe: false, media: { kind: 'document', name: fixture.name, mime: fixture.mime, size: fixture.bytes.length } }),
        }).lastInsertRowid);
      });
    } finally {
      mediaDb.close();
    }
    const messages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa`);
    assert.strictEqual(messages.ok, true);
    assert.strictEqual(messages.messages.some((message) => message.source === 'workbench'), true);
    const pendingWaMedia = messages.messages.find((message) => message.message_id === 'wa-media-pending-1');
    assert.strictEqual(pendingWaMedia.attachments[0].name, 'wa-media-1.png');
    assert.strictEqual(pendingWaMedia.attachments[0].type, 'image/png');
    assert.strictEqual(pendingWaMedia.attachments[0].size, 2048);
    assert.strictEqual(pendingWaMedia.attachments[0].media_url, null);
    const storedWaMedia = messages.messages.find((message) => message.message_id === 'wa-media-stored-1');
    assert.ok(storedWaMedia.attachments[0].media_url);
    const inboundMediaResponse = await fetch(`http://127.0.0.1:${port}${storedWaMedia.attachments[0].media_url}`, {
      headers: { 'x-operator-id': '1469' },
    });
    assert.strictEqual(inboundMediaResponse.status, 200);
    assert.strictEqual(inboundMediaResponse.headers.get('content-type'), 'image/png');
    assert.match(inboundMediaResponse.headers.get('content-disposition'), /^inline;/);
    assert.strictEqual(Number(inboundMediaRowId) > 0, true);
    assert.deepStrictEqual(Buffer.from(await inboundMediaResponse.arrayBuffer()), inboundMediaBytes);
    for (const fixture of inboundDocumentFixtures) {
      const documentMessage = messages.messages.find((message) => message.message_id === fixture.messageId);
      assert.ok(documentMessage.attachments[0].media_url);
      const documentResponse = await fetch(`http://127.0.0.1:${port}${documentMessage.attachments[0].media_url}`, {
        headers: { 'x-operator-id': '1469' },
      });
      assert.strictEqual(documentResponse.status, 200);
      assert.strictEqual(documentResponse.headers.get('content-type'), fixture.mime);
      assert.match(documentResponse.headers.get('content-disposition'), /^attachment;/);
      assert.match(documentResponse.headers.get('content-disposition'), new RegExp(`filename="${fixture.name.replace('.', '\\.')}"`));
      assert.deepStrictEqual(Buffer.from(await documentResponse.arrayBuffer()), fixture.bytes);
    }
    const cleanupMediaDb = new Database(rawDbPath);
    try {
      cleanupMediaDb.prepare('DELETE FROM messages WHERE id = ?').run(inboundMediaRowId);
      const deleteMedia = cleanupMediaDb.prepare('DELETE FROM messages WHERE id = ?');
      inboundDocumentRowIds.forEach((rowId) => deleteMedia.run(rowId));
    } finally {
      cleanupMediaDb.close();
    }
    const realtimeReady = await readFirstServerEvent(`${baseUrl}/groups/group-1/events?platform=wa&account=nanya_wa`);
    assert.strictEqual(realtimeReady.status, 200);
    assert.match(realtimeReady.contentType, /^text\/event-stream/);
    assert.match(realtimeReady.chunk, /event: ready/);
    assert.match(realtimeReady.chunk, /"group_id":"group-1"/);
    const globalReady = await readFirstServerEvent(`${baseUrl}/events`);
    assert.strictEqual(globalReady.status, 200);
    assert.match(globalReady.contentType, /^text\/event-stream/);
    assert.match(globalReady.chunk, /event: ready/);
    const globalReadEvent = await readServerEventAfterAction(`${baseUrl}/events`, 'conversation_read', () => requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: { platform: 'wa', account: 'nanya_wa', group_id: 'group-1', last_read_message_id: 0 },
    }));
    assert.match(globalReadEvent, /event: conversation_read/);
    assert.match(globalReadEvent, /"group_id":"group-1"/);
    const attachmentMessage = messages.messages.find((message) => message.outbound_id === attachmentReply.outbound_id);
    assert.strictEqual(attachmentMessage.attachments[0].name, 'paste.png');
    assert.strictEqual(attachmentMessage.attachments[0].kind, 'image');
    assert.ok(attachmentMessage.attachments[0].media_url.startsWith('/api/workbench/outbound/'));
    const attachmentDownload = await fetch(`http://127.0.0.1:${port}${attachmentMessage.attachments[0].media_url}`, {
      headers: { 'x-operator-id': '1469' },
    });
    assert.strictEqual(attachmentDownload.status, 200);
    assert.strictEqual(attachmentDownload.headers.get('content-type'), 'image/png');
    assert.ok((await attachmentDownload.arrayBuffer()).byteLength > 0);
    const quotedMessage = messages.messages.find((message) => message.outbound_id === firstReply.outbound_id);
    assert.strictEqual(quotedMessage.quote_msg_id, 'm-2');
    const nativeQuotedMessage = messages.messages.find((message) => message.message_id === 'm-3');
    assert.strictEqual(nativeQuotedMessage.quote_msg_id, 54);
    assert.strictEqual(nativeQuotedMessage.quote_text, '谢谢');
    const searchedMessages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa&message_search=${encodeURIComponent('谢谢')}`);
    assert.strictEqual(searchedMessages.messages.length, 1);
    assert.strictEqual(searchedMessages.messages[0].message_id, 'm-2');
    const senderMessages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa&sender=${encodeURIComponent('客户')}`);
    assert.ok(senderMessages.messages.length >= 2);
    const attachmentMessages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa&has_attachment=1`);
    assert.strictEqual(attachmentMessages.messages.some((message) => message.outbound_id === attachmentReply.outbound_id), true);
    const openedGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(openedGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 3);
    assert.strictEqual(openedGroups.groups.find((group) => group.group_id === 'group-1').conversation_status, 'resolved');
    assert.strictEqual(openedGroups.groups.find((group) => group.group_id === 'group-1').starred, true);
    assert.strictEqual(openedGroups.groups.find((group) => group.group_id === 'group-1').notes_count, 1);

    const claimA = await createScopedOperator(baseUrl, 'claim-a', {
      portal: { can_workbench: true }, scope: { can_view: true, can_assign: true },
    });
    const claimB = await createScopedOperator(baseUrl, 'claim-b', {
      portal: { can_workbench: true }, scope: { can_view: true, can_assign: true },
    });
    const claimed = await requestJson(`${baseUrl}/groups/group-1/assign`, {
      method: 'POST', headers: { 'x-operator-id': claimA.id },
      body: { platform: 'wa', account: 'nanya_wa' },
    });
    assert.strictEqual(claimed.assignment.assigned_to, claimA.id);
    const duplicateClaim = await requestRaw(`${baseUrl}/groups/group-1/assign`, {
      method: 'POST', headers: { 'x-operator-id': claimB.id },
      body: { platform: 'wa', account: 'nanya_wa' },
    });
    assert.strictEqual(duplicateClaim.status, 409);
    const foreignRelease = await requestRaw(`${baseUrl}/groups/group-1/release`, {
      method: 'POST', headers: { 'x-operator-id': claimB.id },
      body: { platform: 'wa', account: 'nanya_wa' },
    });
    assert.strictEqual(foreignRelease.status, 403);
    const adminRelease = await requestJson(`${baseUrl}/groups/group-1/release`, {
      method: 'POST', body: { platform: 'wa', account: 'nanya_wa' },
    });
    assert.strictEqual(adminRelease.released, 1);

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

    const insertPagedOutbound = workbenchDb.prepare(`
      INSERT INTO outbound_messages (
        client_msg_id, platform, account, group_id, chat_id, text, status, created_by, created_at
      ) VALUES (?, 'wa', 'nanya_wa', 'outbound-page', 'outbound-page', ?, 'sent', 'demo-operator', ?)
    `);
    for (let index = 1; index <= 5; index += 1) {
      insertPagedOutbound.run(
        `outbound-page-${index}`,
        `外发分页 ${index}`,
        `2026-07-02 08:00:0${index}`,
      );
    }
    const latestOutboundPage = await requestJson(`${baseUrl}/groups/outbound-page/messages?platform=wa&account=nanya_wa&limit=2`);
    assert.deepStrictEqual(latestOutboundPage.messages.map((message) => message.text), ['外发分页 4', '外发分页 5']);

    const pagedMessages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa&limit=1`);
    assert.strictEqual(pagedMessages.ok, true);
    assert.strictEqual(pagedMessages.paging.has_more, true);
    assert.ok(pagedMessages.paging.before_id);
    const olderMessages = await requestJson(`${baseUrl}/groups/group-1/messages?platform=wa&account=nanya_wa&limit=1&before_id=${pagedMessages.paging.before_id}`);
    assert.strictEqual(olderMessages.ok, true);
    assert.strictEqual(olderMessages.messages.some((message) => message.message_id === 'm-2'), true);
    assert.strictEqual(olderMessages.messages.some((message) => message.message_id === 'm-3'), false);
    const afterPagingGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(afterPagingGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 3);

    const partialRead = await requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        last_read_message_id: 1,
      },
    });
    assert.strictEqual(partialRead.unread_count, 2);
    const partiallyReadGroups = await requestJson(`${baseUrl}/groups?scope=all`);
    assert.strictEqual(partiallyReadGroups.groups.find((group) => group.group_id === 'group-1').unread_count, 2);

    const fullRead = await requestJson(`${baseUrl}/messages/read`, {
      method: 'POST',
      body: {
        platform: 'wa',
        account: 'nanya_wa',
        group_id: 'group-1',
        last_read_message_id: 3,
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
    fs.rmSync(API_TEST_DATA_DIR, { recursive: true, force: true });
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
      direction TEXT,
      content TEXT,
      has_media BOOLEAN DEFAULT 0,
      media_path TEXT,
      media_name TEXT,
      media_mime TEXT,
      media_size INTEGER,
      media_sha256 TEXT,
      timestamp INTEGER,
      raw_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, message_id)
    );
    CREATE TABLE message_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      canonical_message_id TEXT NOT NULL,
      observer_account TEXT NOT NULL,
      observer_role TEXT NOT NULL DEFAULT 'service',
      native_chat_id TEXT,
      native_message_id TEXT,
      raw_json TEXT,
      observed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, canonical_message_id, observer_account)
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
  db.prepare('INSERT INTO accounts (id, platform, status, pushname) VALUES (?, ?, ?, ?)').run('teams-main', 'teams', 'authenticated', 'Teams Service');
  db.prepare(`
    INSERT INTO channel_account_registry (
      platform, account, display_name, login_type, account_role,
      workbench_visible, collect_enabled, send_enabled, sync_groups_enabled, risk_level, status
    )
    VALUES
      ('wa', 'nanya_wa', 'Nanya Support', 'wa_personal_qr', 'service', 1, 1, 1, 1, 'medium', 'authenticated'),
      ('tg', 'jason_tg', 'Jason TG', 'telegram_bot_api', 'collector', 0, 1, 0, 0, 'low', 'idle'),
      ('teams', 'teams-main', 'Teams Service', 'teams_web', 'service', 1, 1, 1, 1, 'low', 'authenticated')
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
    platform: 'whatsapp',
    account: 'nanya_wa',
    messageId: 'm-3',
    groupId: 'group-1',
    groupName: 'VIP 支持交流群',
    senderId: 'customer-2',
    senderName: '另一个客户',
    content: '这是引用编号 54 的回复',
    timestamp: 1782950490,
    rawData: JSON.stringify({ reply_to_msg_id: 54 }),
  });
  const observe = db.prepare(`
    INSERT INTO message_observations (
      platform, canonical_message_id, observer_account, native_chat_id, native_message_id, raw_json
    )
    VALUES (@platform, @messageId, @account, @groupId, @nativeMessageId, @rawJson)
  `);
  observe.run({
    platform: 'whatsapp',
    messageId: 'm-2',
    account: 'nanya_wa',
    groupId: 'group-1',
    nativeMessageId: '54',
    rawJson: '{}',
  });
  observe.run({
    platform: 'whatsapp',
    messageId: 'm-3',
    account: 'nanya_wa',
    groupId: 'group-1',
    nativeMessageId: '55',
    rawJson: JSON.stringify({ reply_to_msg_id: 54 }),
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
  insert.run({
    platform: 'teams',
    account: 'teams-main',
    messageId: 'm-teams-hidden',
    groupId: 'teams-hidden',
    groupName: 'Teams 不应进入工作台',
    senderId: 'teams-customer',
    senderName: 'Teams 客户',
    content: '这条 Teams 消息不应在工作台显示',
    timestamp: 1782950580,
    rawData: '{}',
  });
  db.close();
}

function seedLegacyWorkbenchDb(workbenchDbPath) {
  const db = new Database(workbenchDbPath);
  db.exec(`
    CREATE TABLE service_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      service_account TEXT NOT NULL,
      native_group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      color TEXT,
      raw_json TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, service_account, native_group_id)
    );
  `);
  db.prepare(`
    INSERT INTO service_groups (
      platform, service_account, native_group_id, name, source, color, raw_json
    )
    VALUES ('wa', 'nanya_wa', 'legacy-manual-l2', '旧人工二级', 'manual_l2', '#0f766e', '{}')
  `).run();
  db.close();
}

function assertLegacyWorkbenchMigration(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(service_groups)').all().map((column) => column.name));
  assert.strictEqual(columns.has('parent_native_group_id'), true);
  assert.strictEqual(columns.has('group_level'), true);
  assert.strictEqual(columns.has('is_manual'), true);
  const row = db.prepare(`
    SELECT group_level, is_manual
    FROM service_groups
    WHERE native_group_id = 'legacy-manual-l2'
  `).get();
  assert.strictEqual(row.group_level, 2);
  assert.strictEqual(row.is_manual, 1);
  const indexes = new Set(db.prepare('PRAGMA index_list(service_groups)').all().map((index) => index.name));
  assert.strictEqual(indexes.has('idx_service_groups_parent'), true);
}

function seedSyncedChannelMetadata(db) {
  db.prepare(`
    INSERT INTO channel_groups (platform, account, group_id, group_name, kind, raw_json)
    VALUES ('wa', 'nanya_wa', 'group-synced-only', '仅同步群', 'group', '{}')
  `).run();
  db.prepare(`
    INSERT INTO channel_groups (platform, account, group_id, group_name, kind, raw_json)
    VALUES ('wa', 'nanya_wa', '77408698953978@lid', '真实客户名称', 'chat', '{}')
  `).run();
  db.prepare(`
    INSERT INTO channel_groups (platform, account, group_id, group_name, kind, raw_json)
    VALUES ('wa', 'nanya_wa', 'account-name-collision@g.us', 'Nanya Support', 'group', '{}')
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

function countRows(db, tableName, columnName, value) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} = ?`).get(value);
  return row ? Number(row.count || 0) : 0;
}

function countRowsInDbPath(dbPath, tableName, columnName, value) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return countRows(db, tableName, columnName, value);
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

async function readFirstServerEvent(url) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { 'x-operator-id': '1469' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  try {
    const result = await reader.read();
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      chunk: Buffer.from(result.value || []).toString('utf8'),
    };
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

async function readServerEventAfterAction(url, eventName, action) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(url, {
    headers: { 'x-operator-id': '1469' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let content = '';
  try {
    const ready = await reader.read();
    content += Buffer.from(ready.value || []).toString('utf8');
    await action();
    while (!content.includes(`event: ${eventName}`)) {
      const result = await reader.read();
      if (result.done) break;
      content += Buffer.from(result.value || []).toString('utf8');
    }
    return content;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

async function createScopedOperator(baseUrl, username, { status = 'active', portal = {}, scope = {} } = {}) {
  const created = await requestJson(`${baseUrl}/admin/users`, {
    method: 'POST',
    body: {
      username,
      display_name: username,
      password: `Test-${username}-123!`,
      status,
      roles: ['agent'],
    },
  });
  await requestJson(`${baseUrl}/admin/users/${created.user.id}/portal-access`, {
    method: 'PUT',
    body: {
      can_monitor: false,
      can_workbench: Boolean(portal.can_workbench),
      can_admin: Boolean(portal.can_admin),
      default_entry: 'workbench',
    },
  });
  await requestJson(`${baseUrl}/admin/users/${created.user.id}/scopes`, {
    method: 'PUT',
    body: {
      scopes: [{
        platform: 'wa',
        service_account: 'nanya_wa',
        native_group_id: '*',
        can_view: Boolean(scope.can_view),
        can_reply: Boolean(scope.can_reply),
        can_assign: Boolean(scope.can_assign),
        can_manage: Boolean(scope.can_manage),
      }],
    },
  });
  return created.user;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
