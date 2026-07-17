const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const express = require('express');
const { setServiceAccountSendEnabled } = require('../../db/raw-db');
const { writeChannelSyncRequest } = require('../../lib/channel-sync-store');
const {
  DEFAULT_RAW_DB_PATH,
  WORKBENCH_PLATFORMS,
  accountScopeContains,
  countUnreadForGroups,
  isWorkbenchPlatform,
  listAccountProfiles,
  listAccounts,
  normalizePlatform,
  normalizePlatformList,
  openRawDb,
  parseAccountScopeList,
} = require('../../db/raw-messages');
const { ensureOperator, openWorkbenchDb, parseJson, safeJson } = require('../../db/workbench-db');
const {
  ALL_GROUPS,
  UNGROUPED_GROUP,
  allowedAccountScope,
  capabilitySummary,
  conversationHasCapability,
  filterGroupsByCapability,
  isWorkbenchSuperAdmin,
  loadPortalAccess,
  requireAdminPortalAccess,
  requireActiveWorkbenchOperator,
  requireWorkbenchPortalAccess,
  requireConversationCapability,
  resolveWorkbenchOperator,
  serviceGroupVisible,
} = require('../../lib/permissions');
const {
  listPermissions,
  listOperatorRoles,
  listRoles,
  setOperatorRoles,
  setRolePermissions,
} = require('../../lib/access-control');
const { createAccountDataAccess } = require('../../lib/account-data-access');
const { writeLoginVerificationDoorbell } = require('../../lib/service-account-login-store');
const { listAccountRefs, resolveAccountPaths } = require('../../db/account-db');
const { resolveDataDir } = require('../../db/paths');
const { latestChannelEventId, listChannelEvents, recordChannelEvent } = require('../../lib/channel-events');

const ALLOWED_PLATFORMS = new Set(WORKBENCH_PLATFORMS);
const OUTBOUND_STATUSES = new Set(['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'dead', 'paused', 'canceled']);
const CONVERSATION_STATUSES = new Set(['pending', 'in_progress', 'resolved', 'paused']);
const CONVERSATION_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const PRESENCE_MODES = new Set(['viewing', 'typing', 'replying']);
const CONNECTED_ACCOUNT_STATUSES = new Set(['online', 'authenticated', 'ready', 'monitoring', 'healthy']);
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_INBOUND_MEDIA_BYTES = Math.max(1024, Math.min(Number(process.env.WORKBENCH_INBOUND_MEDIA_MAX_BYTES) || 20 * 1024 * 1024, 100 * 1024 * 1024));
const ALLOWED_ATTACHMENT_KINDS = new Set(['file', 'image', 'sticker']);
const CONVERSATION_EVENT_POLL_MS = Math.max(200, Math.min(Number(process.env.WORKBENCH_CONVERSATION_EVENT_POLL_MS) || 350, 5000));
const CONVERSATION_EVENT_HEARTBEAT_MS = 15000;
const GLOBAL_EVENT_POLL_MS = Math.max(250, Math.min(Number(process.env.WORKBENCH_GLOBAL_EVENT_POLL_MS) || 500, 5000));
let activeGlobalSseClients = 0;

function createWorkbenchRouter({ workbenchDb, runtimeDb, rawDbPath = DEFAULT_RAW_DB_PATH, outboxDir, accountDataDir, accountDbMode } = {}) {
  if (!workbenchDb) throw new Error('workbenchDb is required');
  if (!runtimeDb) throw new Error('runtimeDb is required');
  const router = express.Router();
  const doorbellRoot = outboxDir || process.env.WORKBENCH_OUTBOX_DIR || path.resolve(__dirname, '..', '..', 'outbox');
  const accountData = createAccountDataAccess({
    legacyRawDbPath: rawDbPath,
    legacyRuntimeDb: runtimeDb,
    legacyWorkbenchDb: workbenchDb,
    accountDataDir,
    accountDbMode,
  });
  const getAccountScope = () => accountData.resolveAccountScope();
  const requireAdmin = requireAdminPortalAccess(workbenchDb);
  const emitChannelEvent = (platform, account, groupId, eventType, payload = null) => (
    accountData.withRuntimeDb(platform, account, { create: true }, (db) => recordChannelEvent(db, {
      platform,
      account,
      groupId,
      eventType,
      payload,
    }))
  );

  router.use(requireActiveWorkbenchOperator(workbenchDb));
  router.use(requireWorkbenchPortalAccess(workbenchDb));

  router.get('/health', (req, res) => {
    const rawDb = openRawDb(rawDbPath);
    if (rawDb) rawDb.close();
    const accountScope = getAccountScope();
    res.json({
      ok: true,
      raw_messages_db: accountData.isolated ? 'account-isolated' : (rawDb ? 'available' : 'missing'),
      raw_messages_db_path: rawDbPath,
      workbench_db: 'available',
      account_db_mode: accountData.isolated ? 'isolated' : 'legacy',
      account_scope: mapAccountScope(accountScope),
    });
  });

  router.get('/events', (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleScope = allowedAccountScope(workbenchDb, operator, getAccountScope(), 'can_view');
    const sources = openGlobalEventSources({ accountData, runtimeDb, accountDataDir, visibleScope });
    const restoredCursor = decodeEventCursor(req.headers['last-event-id']);
    const cursor = {};
    sources.forEach((source) => {
      cursor[source.key] = Object.prototype.hasOwnProperty.call(restoredCursor, source.key)
        ? Math.max(0, Number(restoredCursor[source.key]) || 0)
        : latestChannelEventId(source.db);
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    activeGlobalSseClients += 1;
    let closed = false;
    writeGlobalEvent(res, 'ready', { connected: true }, cursor);

    const pollTimer = setInterval(() => {
      if (closed) return;
      const events = [];
      sources.forEach((source) => {
        try {
          listChannelEvents(source.db, { afterId: cursor[source.key], limit: 200 }).forEach((event) => {
            if (!accountScopeContains(visibleScope, event.platform, event.account)) return;
            events.push({ ...event, sourceKey: source.key });
          });
        } catch (_) { }
      });
      events
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id)
        .forEach((event) => {
          cursor[event.sourceKey] = Math.max(Number(cursor[event.sourceKey]) || 0, Number(event.id) || 0);
          writeGlobalEvent(res, event.event_type, {
            platform: event.platform,
            account: event.account,
            group_id: event.group_id,
            event_type: event.event_type,
            created_at: event.created_at,
            ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
          }, cursor);
        });
    }, GLOBAL_EVENT_POLL_MS);
    pollTimer.unref?.();
    const heartbeatTimer = setInterval(() => {
      if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, CONVERSATION_EVENT_HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      activeGlobalSseClients = Math.max(0, activeGlobalSseClients - 1);
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      sources.forEach((source) => {
        if (source.owned) source.db.close();
      });
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  router.get('/me', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const viewScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    res.json({
      ok: true,
      user: sanitizeUser(operator.user),
      operator: mapOperator(operator),
      is_super_admin: operator.is_super_admin,
      portal_access: loadPortalAccess(workbenchDb, operator),
      account_scope: mapAccountScope(viewScope),
      capabilities: capabilitySummary(workbenchDb, operator, accountScope),
    });
  });

  router.get('/admin/access', requireAdmin, (req, res) => {
    res.json(buildAdminAccessPayload({ workbenchDb, rawDbPath, accountScope: getAccountScope(), accountData }));
  });

  router.post('/admin/users', requireAdmin, (req, res) => {
    const body = req.body || {};
    const operator = upsertAdminOperator(workbenchDb, {
      id: body.id || body.operator_id || body.username,
      username: body.username,
      role: body.role || 'agent',
      display_name: body.display_name || body.displayName || body.username,
      status: body.status || 'active',
    });
    setOperatorRoles(workbenchDb, operator.id, Array.isArray(body.roles) && body.roles.length ? body.roles : ['agent'], currentAdminId(req));
    savePortalAccess(workbenchDb, operator.id, {
      can_monitor: false,
      can_workbench: true,
      can_admin: false,
      default_entry: 'workbench',
    });
    res.status(201).json({
      ok: true,
      user: enrichOperatorAccess(workbenchDb, operator),
      access: buildAdminAccessPayload({ workbenchDb, rawDbPath, accountScope: getAccountScope(), accountData }),
    });
  });

  router.patch('/admin/users/:id', requireAdmin, (req, res) => {
    const operator = updateAdminOperator(workbenchDb, req.params.id, req.body || {});
    res.json({
      ok: true,
      user: enrichOperatorAccess(workbenchDb, operator),
      access: buildAdminAccessPayload({ workbenchDb, rawDbPath, accountScope: getAccountScope(), accountData }),
    });
  });

  router.delete('/admin/users/:id', requireAdmin, (req, res) => {
    const deleted = deleteAdminOperator(workbenchDb, req.params.id, currentAdminId(req), accountData);
    res.json({
      ok: true,
      deleted,
      access: buildAdminAccessPayload({ workbenchDb, rawDbPath, accountScope: getAccountScope(), accountData }),
    });
  });

  router.put('/admin/users/:id/roles', requireAdmin, (req, res) => {
    const userId = requireText(req.params.id, 'id');
    const roles = setOperatorRoles(workbenchDb, userId, req.body?.roles || [], currentAdminId(req));
    res.json({ ok: true, operator_id: userId, roles });
  });

  router.put('/admin/users/:id/portal-access', requireAdmin, (req, res) => {
    const userId = requireText(req.params.id, 'id');
    const portal_access = savePortalAccess(workbenchDb, userId, req.body || {});
    res.json({ ok: true, operator_id: userId, portal_access });
  });

  router.put('/admin/users/:id/scopes', requireAdmin, (req, res) => {
    const userId = requireText(req.params.id, 'id');
    const scopes = replaceOperatorScopes(workbenchDb, userId, req.body?.scopes || []);
    res.json({ ok: true, operator_id: userId, scopes });
  });

  router.put('/admin/roles/:code/permissions', requireAdmin, (req, res) => {
    const role = setRolePermissions(workbenchDb, req.params.code, req.body?.permissions || []);
    res.json({ ok: true, role });
  });

  router.get('/accounts', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const accounts = accountData.listAccounts({ accountScope: visibleAccountScope }).map((account) => (
      mapServiceAccount(account, accountData, workbenchDb)
    ));
    res.json({ ok: true, accounts, account_scope: mapAccountScope(visibleAccountScope) });
  });

  router.get('/accounts/:platform/:account/customer-types', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const options = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => (
      listCustomerTypeOptions(accountDb, platform, account, false)
    ));
    res.json({ ok: true, options });
  });

  router.patch('/admin/accounts/:platform/:account/settings', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    if (!hasPatchValue(req.body || {}, 'send_enabled')) throw createHttpError(400, 'send_enabled is required');
    if (!accountData.findAccountProfile(platform, account, getAccountScope())) throw createHttpError(404, 'service account not found');
    const settings = setServiceAccountSendEnabled({
      dbPath: accountData.rawDbPathFor(platform, account),
      platform,
      account,
      sendEnabled: req.body.send_enabled ? 1 : 0,
    });
    if (!settings) throw createHttpError(404, 'service account not found');
    writeAction(workbenchDb, operator.id, 'service_account.send_setting', platform, account, null, account, {
      send_enabled: Number(settings.send_enabled),
    });
    res.json({ ok: true, settings });
  });

  router.post('/admin/accounts/:platform/:account/send-breaker/release', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    const released = accountData.withWorkbenchDb(platform, account, {}, (accountDb) => accountDb.prepare(`
      UPDATE send_circuit_breaker
      SET status = 'open', cooldown_until = NULL, reason = 'manually released by administrator', updated_at = CURRENT_TIMESTAMP
      WHERE platform = ? AND account = ? AND status = 'cooldown'
    `).run(platform, account).changes);
    writeAction(workbenchDb, operator.id, 'service_account.breaker.release', platform, account, null, account, { released });
    res.json({ ok: true, released });
  });

  router.get('/admin/accounts/:platform/:account/customer-types', requireAdmin, (req, res) => {
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    const options = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => (
      listCustomerTypeOptions(accountDb, platform, account, true)
    ));
    res.json({ ok: true, options });
  });

  router.post('/admin/accounts/:platform/:account/customer-types', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    const option = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => (
      createCustomerTypeOption(accountDb, platform, account, req.body || {}, operator.id)
    ));
    res.status(201).json({ ok: true, option });
  });

  router.patch('/admin/accounts/:platform/:account/customer-types/:id', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    const option = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => (
      updateCustomerTypeOption(accountDb, platform, account, req.params.id, req.body || {}, operator.id)
    ));
    res.json({ ok: true, option });
  });

  router.delete('/admin/accounts/:platform/:account/customer-types/:id', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    const option = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => (
      updateCustomerTypeOption(accountDb, platform, account, req.params.id, { status: 'disabled' }, operator.id)
    ));
    res.json({ ok: true, option });
  });

  router.get('/service-account-logins', requireAdmin, (req, res) => {
    res.json({
      ok: true,
      isolated: accountData.isolated,
      requests: accountData.listLoginRequests({ limit: req.query.limit }),
    });
  });

  router.post('/service-account-logins', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    const loginMode = String(body.login_mode || body.loginMode || '').trim();
    const displayName = String(body.display_name || body.displayName || account).trim();
    let request;
    try {
      request = accountData.createLoginRequest({
        outboxDir: doorbellRoot,
        platform,
        account,
        displayName,
        loginMode,
        credential: body.credential,
        tgApiId: body.tg_api_id ?? body.tgApiId ?? body.api_id ?? body.apiId,
        tgApiHash: body.tg_api_hash ?? body.tgApiHash ?? body.api_hash ?? body.apiHash,
        tgPhoneNumber: body.tg_phone_number ?? body.tgPhoneNumber ?? body.phone_number ?? body.phoneNumber,
        requestedBy: operator.id,
      });
      accountData.upsertProfile({
        platform,
        account,
        displayName,
        loginType: request.login_mode,
        status: request.status,
      });
    } catch (err) {
      throw createHttpError(400, err.message);
    }
    accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => writeAction(accountDb, operator.id, 'service_account.login.request', platform, account, null, request.request_id, {
      login_mode: request.login_mode,
      credential_hint: request.credential_hint,
    }));
    res.status(202).json({ ok: true, request });
  });

  router.post('/service-account-logins/:id/verify', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const request = accountData.getLoginRequest(req.params.id);
    if (!request) throw createHttpError(404, 'login request not found');
    if (request.login_mode !== 'tg_user_phone') {
      throw createHttpError(400, 'verification is only supported for TG user phone login');
    }
    if (!['waiting_code', 'waiting_password', 'waiting_verification'].includes(request.status)) {
      throw createHttpError(400, 'login request is not waiting for Telegram verification');
    }

    const body = req.body || {};
    const code = String(body.code || body.phone_code || body.phoneCode || '').trim();
    const password = String(body.password || body.two_factor_password || body.twoFactorPassword || '');
    if (request.status === 'waiting_code' && !code) throw createHttpError(400, 'Telegram verification code is required');
    if (request.status === 'waiting_password' && !password) throw createHttpError(400, 'Telegram two-step password is required');

    writeLoginVerificationDoorbell(doorbellRoot, request, {
      code,
      password,
      requestedBy: operator.id,
    });
    const next = accountData.updateLoginRequest(request.request_id, {
      status: 'waiting_verification',
      worker_message: request.status === 'waiting_password'
        ? '二步密码已提交，等待 TG worker 验证'
        : '验证码已提交，等待 TG worker 验证',
      error_message: '',
    });
    accountData.withWorkbenchDb(request.platform, request.account, { create: true }, (accountDb) => writeAction(accountDb, operator.id, 'service_account.login.verify', request.platform, request.account, null, request.request_id, {
      login_mode: request.login_mode,
      submitted_code: Boolean(code),
      submitted_password: Boolean(password),
    }));
    res.status(202).json({ ok: true, request: next || request });
  });

  router.get('/service-account-logins/:id', requireAdmin, (req, res) => {
    const request = accountData.getLoginRequest(req.params.id);
    if (!request) throw createHttpError(404, 'login request not found');
    res.json({ ok: true, request });
  });

  router.patch('/service-account-logins/:id', requireAdmin, (req, res) => {
    const request = accountData.updateLoginRequest(req.params.id, req.body || {});
    if (!request) throw createHttpError(404, 'login request not found');
    if (request.status) {
      accountData.upsertProfile({
        platform: request.platform,
        account: request.account,
        displayName: request.display_name,
        loginType: request.login_mode,
        status: request.status,
      });
    }
    res.json({ ok: true, request });
  });

  router.delete('/service-account-logins/:id', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const request = accountData.deleteLoginRequest(req.params.id, {
      outboxDir: doorbellRoot,
      permanent: true,
    });
    if (!request) throw createHttpError(404, 'login request not found');
    writeAction(
      workbenchDb,
      operator.id,
      'service_account.login.delete',
      request.platform,
      request.account,
      null,
      request.request_id,
      {
        login_mode: request.login_mode,
        status: request.status,
        deleted_doorbells: request.deleted_doorbells,
        permanent_deleted: true,
        deleted_account_data: request.deleted_account_data,
      },
    );
    res.json({ ok: true, request });
  });

  router.delete('/accounts/:platform/:account', requireAdmin, (req, res) => {
    const operator = currentOperatorContext(workbenchDb, req);
    const platform = requirePlatform(req.params.platform);
    const account = requireText(req.params.account, 'account');
    const accountScope = getAccountScope();
    const manageAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
    requireVisibleAccount(manageAccountScope, platform, account);
    const exists = accountData.listAccounts({ accountScope: manageAccountScope })
      .some((item) => item.platform === platform && item.account === account);
    if (!exists) throw createHttpError(404, 'service account not found');

    const deleted_account_data = accountData.deleteServiceAccountData({ platform, account }, {
      outboxDir: doorbellRoot,
    });
    writeAction(workbenchDb, operator.id, 'service_account.delete', platform, account, null, account, {
      deleted_account_data,
    });
    res.json({ ok: true, platform, account, deleted_account_data });
  });

  router.get('/channel-labels', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const params = {};
    const filters = [];
    const platform = applyWorkbenchPlatformFilter(filters, params, req.query.platform);
    const accountFilterValue = req.query.accounts || (
      req.query.account && platform ? `${platform}:${req.query.account}` : req.query.account
    );
    const selectedAccountScope = resolveSelectedAccountScope(visibleAccountScope, accountFilterValue);
    applyServiceAccountScopeSql(filters, params, selectedAccountScope);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const labels = queryWorkbenchDbs(accountData, {
      platforms: platform ? [platform] : undefined,
      accountScope: selectedAccountScope,
      sql: `
      SELECT
        id,
        platform,
        service_account AS account,
        native_group_id AS native_label_id,
        native_group_id AS native_group_id,
        name,
        color,
        source AS kind,
        source,
        parent_native_group_id,
        group_level,
        is_manual,
        synced_at
      FROM service_groups
      ${where}
      ORDER BY platform ASC, account ASC, kind ASC, name ASC
    `,
      params,
    }).filter((label) => serviceGroupVisible(workbenchDb, operator, {
      platform: label.platform,
      service_account: label.account,
      native_group_id: label.native_group_id,
    }, 'can_view'));
    res.json({ ok: true, labels });
  });

  router.get('/service-groups', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const params = {};
    const filters = [];
    const platform = applyWorkbenchPlatformFilter(filters, params, req.query.platform);
    const accountFilterValue = req.query.accounts || (
      req.query.account && platform ? `${platform}:${req.query.account}` : req.query.account
    );
    const selectedAccountScope = resolveSelectedAccountScope(visibleAccountScope, accountFilterValue);
    applyServiceAccountScopeSql(filters, params, selectedAccountScope);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const groups = queryWorkbenchDbs(accountData, {
      platforms: platform ? [platform] : undefined,
      accountScope: selectedAccountScope,
      sql: `
      SELECT
        id,
        platform,
        service_account,
        native_group_id,
        name,
        source,
        parent_native_group_id,
        group_level,
        is_manual,
        color,
        synced_at
      FROM service_groups
      ${where}
      ORDER BY platform ASC, service_account ASC, source ASC, name ASC
    `,
      params,
    }).filter((group) => serviceGroupVisible(workbenchDb, operator, group, 'can_view'));
    res.json({ ok: true, groups });
  });

  router.get('/manual-groups', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const params = {};
    const filters = [
      "(source IN ('manual', 'manual_l1', 'manual_l2') OR is_manual = 1)",
    ];
    const platform = applyWorkbenchPlatformFilter(filters, params, req.query.platform);
    const accountFilterValue = req.query.accounts || (
      req.query.account && platform ? `${platform}:${req.query.account}` : req.query.account
    );
    const selectedAccountScope = resolveSelectedAccountScope(visibleAccountScope, accountFilterValue);
    applyServiceAccountScopeSql(filters, params, selectedAccountScope);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const groups = queryWorkbenchDbs(accountData, {
      platforms: platform ? [platform] : undefined,
      accountScope: selectedAccountScope,
      sql: `
      SELECT
        id,
        platform,
        service_account,
        native_group_id,
        name,
        source,
        parent_native_group_id,
        group_level,
        is_manual,
        color,
        synced_at,
        created_by,
        updated_by,
        created_at,
        updated_at
      FROM service_groups
      ${where}
      ORDER BY platform ASC, service_account ASC, group_level ASC, name ASC
    `,
      params,
    }).filter((group) => serviceGroupVisible(workbenchDb, operator, group, 'can_view'));
    res.json({ ok: true, groups: orderServiceGroups(groups) });
  });

  router.post('/manual-groups', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const manageAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    requireVisibleAccount(manageAccountScope, platform, account);
    const name = sanitizeManualGroupName(body.name);
    const groupLevel = normalizeManualGroupLevel(body.group_level ?? body.level);
    const parentNativeGroupId = groupLevel === 2
      ? requireText(body.parent_native_group_id || body.parent_id, 'parent_native_group_id')
      : null;
    const nativeGroupId = createManualGroupId();
    const source = groupLevel === 2 ? 'manual_l2' : 'manual_l1';
    const color = normalizeColor(body.color) || defaultManualGroupColor(groupLevel);
    const now = new Date().toISOString();
    const group = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      if (parentNativeGroupId) {
        const parent = getServiceGroup(accountDb, platform, account, parentNativeGroupId);
        if (!parent || Number(parent.group_level || 1) !== 1 || !isManualServiceGroup(parent)) {
          throw createHttpError(400, 'parent group must be an existing manual level-1 group');
        }
      }
      accountDb.prepare(`
        INSERT INTO service_groups (
          platform, service_account, native_group_id, name, source,
          parent_native_group_id, group_level, is_manual,
          color, raw_json, synced_at, created_by, updated_by
        )
        VALUES (
          @platform, @account, @nativeGroupId, @name, @source,
          @parentNativeGroupId, @groupLevel, 1,
          @color, @rawJson, @syncedAt, @operatorId, @operatorId
        )
      `).run({
        platform,
        account,
        nativeGroupId,
        name,
        source,
        parentNativeGroupId,
        groupLevel,
        color,
        rawJson: safeJson({ manual: true, group_level: groupLevel, parent_native_group_id: parentNativeGroupId }),
        syncedAt: now,
        operatorId,
      });
      writeAction(accountDb, operatorId, 'manual_group.create', platform, account, null, nativeGroupId, {
        name,
        group_level: groupLevel,
        parent_native_group_id: parentNativeGroupId,
      });
      return getServiceGroup(accountDb, platform, account, nativeGroupId);
    });
    res.status(201).json({ ok: true, group });
  });

  router.get('/groups', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const selectedAccountScope = resolveSelectedAccountScope(visibleAccountScope, req.query.accounts || req.query.account);
    const operatorId = operator.id;
    const platformFilterValue = req.query.platform || req.query.platforms;
    const platforms = normalizePlatformList(platformFilterValue);
    if (hasQueryValue(platformFilterValue) && !platforms.length) {
      res.json({ ok: true, groups: [], account_scope: mapAccountScope(visibleAccountScope) });
      return;
    }
    const scope = String(req.query.scope || 'all');
    if (scope === 'mine') {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Link', '</docs/product/2026-07-10-three-column-customer-profile.md>; rel="deprecation"');
    }
    const labelId = req.query.label_id ? String(req.query.label_id) : '';
    const customerTypeId = req.query.customer_type_id ? String(req.query.customer_type_id).trim() : '';
    const labelTargets = labelId
      ? loadServiceGroupConversationTargetsAcross(accountData, labelId, selectedAccountScope)
      : null;
    if (labelTargets && !labelTargets.keys.size) {
      res.json({ ok: true, groups: [], account_scope: mapAccountScope(visibleAccountScope) });
      return;
    }
    const groupQueryLimit = labelTargets
      ? Math.max(1, Math.min(labelTargets.keys.size, 500))
      : req.query.limit;
    const rawGroups = accountData.listGroups({
      platforms,
      accountScope: selectedAccountScope,
      search: req.query.search,
      groupIdsByAccount: labelTargets?.groupIdsByAccount,
      limit: groupQueryLimit,
      offset: req.query.offset,
    });
    const syncedGroups = listSyncedGroupsAcross(accountData, {
      platforms,
      accountScope: selectedAccountScope,
      search: req.query.search,
      groupIdsByAccount: labelTargets?.groupIdsByAccount,
      limit: groupQueryLimit,
      offset: req.query.offset,
    });
    const sourceGroups = mergeGroupSources(rawGroups, syncedGroups).filter((group) => (
      !labelTargets || labelTargets.keys.has(groupKey(group.platform, group.account, group.group_id))
    ));
    const enriched = filterGroupsByCapability(
      workbenchDb,
      operator,
      enrichGroupsWithAccountData(accountData, workbenchDb, rawDbPath, sourceGroups, operatorId, selectedAccountScope),
      'can_view',
    )
      .filter((group) => {
        if (scope === 'mine') return group.assignment && group.assignment.assigned_to === operatorId;
        if (scope === 'unread') return group.unread_count > 0;
        return true;
      })
      .filter((group) => !customerTypeId || String(group.customer_type_id || '') === customerTypeId);
    res.json({ ok: true, groups: enriched, account_scope: mapAccountScope(visibleAccountScope) });
  });

  router.post('/channel-sync', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const manageAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
    const operatorId = operator.id;
    const body = req.body || {};
    const requestedPlatform = normalizePlatform(body.platform);
    if (hasQueryValue(body.platform) && !isWorkbenchPlatform(requestedPlatform)) {
      throw createHttpError(400, 'platform must be one of wa, tg');
    }
    const requestedAccount = body.account ? String(body.account).trim() : '';
    const requestedAccounts = Array.isArray(body.accounts)
      ? body.accounts
      : String(body.accounts || '').split(',');
    const requestedAccountSet = new Set(parseAccountScopeList(requestedAccounts.join(',')).accounts.map((entry) => accountKey(entry.platform, entry.account)));
    const visibleAccounts = (manageAccountScope.active ? manageAccountScope.accounts : accountData.listAccounts({ accountScope: manageAccountScope }))
      .filter((account) => (!requestedPlatform || account.platform === requestedPlatform))
      .filter((account) => (!requestedAccount || account.account === requestedAccount))
      .filter((account) => (!requestedAccountSet.size || requestedAccountSet.has(accountKey(account.platform, account.account))));
    if (!visibleAccounts.length) {
      throw createHttpError(404, 'no available account to sync');
    }
    const requests = visibleAccounts.map((account) => {
      requireVisibleAccount(manageAccountScope, account.platform, account.account);
      const request = writeChannelSyncRequest(doorbellRoot, {
        platform: account.platform,
        account: account.account,
        requestedBy: operatorId,
        reason: body.reason || 'manual',
      });
      accountData.withWorkbenchDb(account.platform, account.account, { create: true }, (accountDb) => writeAction(accountDb, operatorId, 'channel.sync.request', account.platform, account.account, null, request.requested_at, {
        reason: request.reason,
      }));
      return {
        platform: account.platform,
        account: account.account,
        requested_at: request.requested_at,
      };
    });
    res.status(202).json({ ok: true, requests });
  });

  router.get('/groups/:groupId/messages', (req, res) => {
    const requestStartedAt = Date.now();
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const messageFilters = normalizeMessageFilters(req.query);
    const requestedLimit = Number(req.query.limit) || 80;
    const rawStartedAt = Date.now();
    const page = accountData.listMessagesPage({
      platform,
      account,
      accountScope: visibleAccountScope,
      groupId,
      beforeId: req.query.before_id,
      limit: messageFilters.active ? Math.max(requestedLimit, 200) : requestedLimit,
    });
    const rawDurationMs = Date.now() - rawStartedAt;
    const inbound = page.messages.map(mapRawMessage);
    const ledgerStartedAt = Date.now();
    const outbound = accountData.withWorkbenchDb(platform, account, { readonly: accountData.isolated }, (accountDb) => listOutboundMessages(accountDb, {
      platform,
      account,
      groupId,
      scopedIds: accountData.isolated,
    }));
    const ledgerDurationMs = Date.now() - ledgerStartedAt;
    const merged = applyMentionDisplayNames(enrichConversationQuoteTexts(
      mergeConversationMessages(inbound, outbound),
      accountData.listQuoteTexts({
        platform,
        account,
        accountScope: visibleAccountScope,
        groupId,
        quoteIds: collectMissingQuoteIds([...inbound, ...outbound]),
      }),
    ));
    const messages = messageFilters.active ? filterConversationMessages(merged, messageFilters) : merged;
    const totalDurationMs = Date.now() - requestStartedAt;
    res.setHeader('Server-Timing', [
      `raw_messages;dur=${rawDurationMs}`,
      `outbound_ledger;dur=${ledgerDurationMs}`,
      `workbench_messages;dur=${totalDurationMs}`,
    ].join(', '));
    if (totalDurationMs >= 1000) {
      console.warn(`[workbench] slow conversation messages platform=${platform} total_ms=${totalDurationMs} raw_ms=${rawDurationMs} ledger_ms=${ledgerDurationMs} rows=${messages.length}`);
    }
    res.json({
      ok: true,
      messages,
      paging: messageFilters.active ? { has_more: false, before_id: null } : page.paging,
    });
  });

  router.get('/groups/:groupId/media/:messageId', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const rawDb = accountData.openAccountRawDb(platform, account, { readonly: true });
    let row;
    try {
      row = rawDb.prepare(`
        SELECT * FROM messages
        WHERE id = @id AND platform = @platform AND group_id = @groupId
      `).get({ id: Number(req.params.messageId), platform, groupId });
    } finally {
      rawDb.close();
    }
    if (!row?.media_path) throw createHttpError(404, 'media not found');
    const baseDir = accountData.isolated
      ? resolveAccountPaths(platform, account, { accountDataDir }).accountDir
      : resolveDataDir();
    const mediaPath = path.resolve(baseDir, row.media_path);
    const relative = path.relative(path.resolve(baseDir), mediaPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw createHttpError(403, 'invalid media path');
    if (!fs.existsSync(mediaPath)) throw createHttpError(404, 'media file missing');
    const mediaStat = fs.statSync(mediaPath);
    if (!mediaStat.isFile()) throw createHttpError(404, 'media file missing');
    if (mediaStat.size > MAX_INBOUND_MEDIA_BYTES) throw createHttpError(413, 'media file exceeds download limit');
    const mime = String(row.media_mime || 'application/octet-stream');
    const safeInline = /^image\/(?:png|jpeg|webp|gif)$/i.test(mime) && req.query.download !== '1';
    const filename = String(row.media_name || path.basename(mediaPath)).replace(/[\r\n"\\/]/g, '_');
    const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_') || 'media';
    const encodedFilename = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(mediaStat.size));
    res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);
    fs.createReadStream(mediaPath).on('error', (err) => res.destroy(err)).pipe(res);
  });

  router.get('/groups/:groupId/events', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const eventDbs = openConversationEventDbs(accountData, workbenchDb, accountDataDir, platform, account);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    let signature = readConversationEventSignature(eventDbs, platform, account, groupId);
    writeConversationEvent(res, 'ready', { platform, account, group_id: groupId });

    const pollTimer = setInterval(() => {
      if (closed) return;
      try {
        const nextSignature = readConversationEventSignature(eventDbs, platform, account, groupId);
        if (nextSignature === signature) return;
        signature = nextSignature;
        writeConversationEvent(res, 'refresh', { platform, account, group_id: groupId });
      } catch (err) {
        writeConversationEvent(res, 'warning', { message: 'conversation refresh temporarily unavailable' });
      }
    }, CONVERSATION_EVENT_POLL_MS);
    const heartbeatTimer = setInterval(() => {
      if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, CONVERSATION_EVENT_HEARTBEAT_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      eventDbs.rawDb.close();
      if (eventDbs.ownedWorkbenchDb) eventDbs.workbenchDb.close();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  router.get('/groups/:groupId/workspace', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const workspace = accountData.withWorkbenchDb(platform, account, { readonly: accountData.isolated }, (accountDb) => (
      buildConversationWorkspace(accountDb, workbenchDb, platform, account, groupId, { notesLimit: 3, timelineLimit: 3 })
    ));
    res.json({ ok: true, ...workspace });
  });

  router.patch('/groups/:groupId/workspace', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const manageAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform || req.query.platform);
    const account = requireText(body.account || req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    if (hasProfileManageFields(body)) {
      requireVisibleAccount(manageAccountScope, platform, account);
      requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_manage');
    }
    const profile = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const next = upsertConversationProfile(accountDb, platform, account, groupId, body, operatorId);
      writeAction(accountDb, operatorId, 'conversation.profile.update', platform, account, groupId, groupId, {
        status: next.status,
        priority: next.priority,
        starred: next.starred,
        follow_up_at: next.follow_up_at,
      });
      return next;
    });
    res.json({ ok: true, profile });
  });

  router.post('/groups/:groupId/notes', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const replyAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_reply');
    const manageAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform || req.query.platform);
    const account = requireText(body.account || req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const mayWriteNote = (
      accountScopeContains(replyAccountScope, platform, account) &&
      conversationHasCapability(workbenchDb, operator, platform, account, groupId, 'can_reply')
    ) || (
      accountScopeContains(manageAccountScope, platform, account) &&
      conversationHasCapability(workbenchDb, operator, platform, account, groupId, 'can_manage')
    );
    if (!mayWriteNote) throw createHttpError(403, 'operator cannot add notes to this conversation');
    const note = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const row = createConversationNote(accountDb, platform, account, groupId, body.body || body.note, operatorId);
      writeAction(accountDb, operatorId, 'conversation.note.create', platform, account, groupId, row.id, {
        note_length: row.body.length,
      });
      return attachActorName(row, loadOperatorNameMap(workbenchDb), 'created_by');
    });
    res.status(201).json({ ok: true, note });
  });

  router.get('/groups/:groupId/notes', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const limit = boundedNumber(req.query.limit, 20, 1, 50);
    const beforeId = Math.max(0, Number(req.query.before_id) || 0);
    const result = accountData.withWorkbenchDb(platform, account, { readonly: accountData.isolated }, (accountDb) => (
      loadConversationNotesPage(accountDb, workbenchDb, platform, account, groupId, { limit, beforeId })
    ));
    res.json({ ok: true, ...result });
  });

  router.post('/groups/:groupId/presence', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const body = req.body || {};
    const platform = requirePlatform(body.platform || req.query.platform);
    const account = requireText(body.account || req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const presence = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      saveConversationPresence(accountDb, platform, account, groupId, operator.id, body.mode, body.active !== false);
      return loadConversationPresence(accountDb, workbenchDb, platform, account, groupId);
    });
    res.json({ ok: true, presence });
  });

  router.get('/groups/:groupId/timeline', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const timeline = accountData.withWorkbenchDb(platform, account, { readonly: accountData.isolated }, (accountDb) => (
      loadConversationTimelinePage(accountDb, workbenchDb, platform, account, groupId, {
        limit: req.query.limit,
        beforeId: req.query.before_id,
      })
    ));
    res.json({ ok: true, ...timeline });
  });

  router.put('/groups/:groupId/manual-groups', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const manageAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    requireVisibleAccount(manageAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_manage');
    const manualGroupIds = normalizeManualGroupIds(
      body.manual_group_ids ?? body.native_group_ids ?? body.group_ids ?? [],
    );
    const labels = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const manualGroups = loadManualServiceGroupsByIds(accountDb, platform, account, manualGroupIds);
      if (manualGroups.length !== manualGroupIds.length) {
        throw createHttpError(400, 'manual_group_ids contains unknown or non-manual groups');
      }
      const save = accountDb.transaction(() => {
        accountDb.prepare(`
          DELETE FROM conversation_service_group_map
          WHERE platform = @platform
            AND service_account = @account
            AND chat_id = @groupId
            AND native_group_id IN (
              SELECT native_group_id
              FROM service_groups
              WHERE platform = @platform
                AND service_account = @account
                AND (source IN ('manual', 'manual_l1', 'manual_l2') OR is_manual = 1)
            )
        `).run({ platform, account, groupId });
        const insert = accountDb.prepare(`
          INSERT INTO conversation_service_group_map (
            platform, service_account, chat_id, native_group_id, synced_at
          )
          VALUES (@platform, @account, @groupId, @nativeGroupId, @syncedAt)
          ON CONFLICT(platform, service_account, chat_id, native_group_id) DO UPDATE SET
            synced_at = excluded.synced_at,
            updated_at = CURRENT_TIMESTAMP
        `);
        const syncedAt = new Date().toISOString();
        manualGroupIds.forEach((nativeGroupId) => {
          insert.run({ platform, account, groupId, nativeGroupId, syncedAt });
        });
        writeAction(accountDb, operatorId, 'conversation.manual_groups.update', platform, account, groupId, groupId, {
          manual_group_ids: manualGroupIds,
        });
        writeConversationTimeline(accountDb, operatorId, 'conversation.manual_groups.update', platform, account, groupId, {
          manual_group_ids: manualGroupIds,
        });
        return loadConversationLabels(accountDb, platform, account, groupId);
      });
      return save();
    });
    res.json({ ok: true, labels });
  });

  router.post('/reply', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const replyAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_reply');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    requireVisibleAccount(replyAccountScope, platform, account);
    const groupId = requireText(body.group_id, 'group_id');
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_reply');
    const accountProfile = accountData.findAccountProfile(platform, account, accountScope);
    if (accountProfile && accountProfile.send_enabled === 0) {
      throw createHttpError(403, 'service account is not enabled for sending');
    }
    const clientMsgId = requireText(body.client_msg_id, 'client_msg_id');
    const text = String(body.text || '').trim();
    const attachments = normalizeAttachments(body.attachments ?? body.attachment_json ?? null);
    if (!text && !attachments.length) {
      throw createHttpError(400, 'text or attachment is required');
    }
    const result = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb, context) => {
      const existing = accountDb.prepare(`
        SELECT * FROM outbound_messages
        WHERE created_by = @operatorId AND client_msg_id = @clientMsgId
      `).get({ operatorId, clientMsgId });
      if (existing) return { insert: { changes: 0 }, outbound: existing, breaker: null };
      const breaker = activeBreaker(accountDb, platform, account);
      const desiredStatus = breaker ? 'paused' : 'pending';
      const storedAttachments = persistOutboundAttachmentFiles(attachments, {
        platform,
        account,
        accountPaths: context.paths,
        accountDataDir,
      });
      const attachmentJson = storedAttachments.length ? safeJson(storedAttachments) : null;
      const insert = accountDb.prepare(`
        INSERT INTO outbound_messages (
          client_msg_id, platform, account, group_id, chat_id, text, quote_msg_id,
          attachment_json, status, created_by
        )
        VALUES (
          @clientMsgId, @platform, @account, @groupId, @chatId, @text, @quoteMsgId,
          @attachmentJson, @status, @createdBy
        )
        ON CONFLICT(created_by, client_msg_id) DO NOTHING
      `).run({
        clientMsgId,
        platform,
        account,
        groupId,
        chatId: body.chat_id || groupId,
        text,
        quoteMsgId: body.quote_msg_id || null,
        attachmentJson,
        status: desiredStatus,
        createdBy: operatorId,
      });
      const outbound = accountDb.prepare(`
        SELECT *
        FROM outbound_messages
        WHERE created_by = @operatorId AND client_msg_id = @clientMsgId
      `).get({ operatorId, clientMsgId });
      if (insert.changes > 0) {
        recordOutboundAttachmentRows(accountDb, outbound.id, storedAttachments);
        writeAction(accountDb, operatorId, 'reply.create', platform, account, groupId, outbound.id, {
          status: outbound.status,
          has_attachment: Boolean(attachmentJson),
        });
        writeConversationTimeline(accountDb, operatorId, 'reply.create', platform, account, groupId, {
          outbound_id: outbound.id,
          status: outbound.status,
          quote_msg_id: outbound.quote_msg_id,
          has_attachment: Boolean(attachmentJson),
        });
        if (outbound.status === 'pending') writeDoorbell(doorbellRoot, outbound);
      }
      return { insert, outbound, breaker };
    });
    if (result.insert.changes > 0) {
      emitChannelEvent(platform, account, groupId, 'outbound_status', {
        outbound_id: result.outbound.id,
        status: result.outbound.status,
      });
    }
    res.status(result.insert.changes > 0 ? 201 : 200).json({
      ok: true,
      outbound_id: publicOutboundId(result.outbound, accountData),
      status: result.outbound.status,
      idempotent: result.insert.changes === 0,
      paused_reason: result.breaker ? result.breaker.reason || 'account cooldown' : undefined,
    });
  });

  router.post('/messages/read', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = requireText(body.group_id, 'group_id');
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const lastReadMessageId = Number(body.last_read_message_id || 0);
    accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      accountDb.prepare(`
        INSERT INTO conversation_reads (
          operator_id, platform, account, group_id, last_read_message_id, last_read_at, updated_at
        )
        VALUES (@operatorId, @platform, @account, @groupId, @lastReadMessageId, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(operator_id, platform, account, group_id) DO UPDATE SET
          last_read_message_id = MAX(COALESCE(conversation_reads.last_read_message_id, 0), excluded.last_read_message_id),
          last_read_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).run({ operatorId, platform, account, groupId, lastReadMessageId });
      writeAction(accountDb, operatorId, 'conversation.read', platform, account, groupId, groupId, {
        last_read_message_id: lastReadMessageId,
      });
      writeConversationTimeline(accountDb, operatorId, 'conversation.read', platform, account, groupId, {
        last_read_message_id: lastReadMessageId,
      });
    });
    const unreadCount = Math.min(accountData.countUnread({
      platform,
      account,
      accountScope: visibleAccountScope,
      groupId,
      lastReadMessageId,
    }), 99);
    emitChannelEvent(platform, account, groupId, 'conversation_read', {
      operator_id: operatorId,
      last_read_message_id: lastReadMessageId,
    });
    res.json({ ok: true, unread_count: unreadCount });
  });

  router.post('/groups/bulk', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const body = req.body || {};
    const action = normalizeBulkAction(body.action);
    const capability = bulkActionCapability(action);
    const scopedAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, capability);
    const viewAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const operatorId = operator.id;
    const items = normalizeBulkConversationItems(body.items || body.groups || body.conversations);
    if (!items.length) throw createHttpError(400, 'bulk items are required');
    const result = {
      action,
      requested: items.length,
      changed: 0,
      failed: 0,
      results: [],
    };
    items.forEach((item) => {
      try {
        requireVisibleAccount(scopedAccountScope, item.platform, item.account);
        requireConversationCapability(workbenchDb, operator, item.platform, item.account, item.group_id, capability);
        if (action === 'assign' && String(body.assigned_to || operatorId).trim() !== operatorId) {
          const manageScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_manage');
          requireVisibleAccount(manageScope, item.platform, item.account);
          requireConversationCapability(workbenchDb, operator, item.platform, item.account, item.group_id, 'can_manage');
        }
        const itemResult = runBulkConversationAction(accountData, workbenchDb, {
          action,
          item,
          body,
          operatorId,
          accountScope: viewAccountScope,
          allowManage: conversationHasCapability(
            workbenchDb,
            operator,
            item.platform,
            item.account,
            item.group_id,
            'can_manage',
          ),
        });
        result.changed += itemResult.changed ? 1 : 0;
        result.results.push({ ...item, ok: true, ...itemResult });
        if (itemResult.changed && ['assign', 'release'].includes(action)) {
          emitChannelEvent(item.platform, item.account, item.group_id, 'assignment', {
            assigned_to: action === 'assign' ? itemResult.assignment?.assigned_to || null : null,
          });
        }
      } catch (err) {
        result.failed += 1;
        result.results.push({ ...item, ok: false, error: err.message });
      }
    });
    res.json({ ok: true, ...result });
  });

  router.post('/groups/:groupId/assign', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const assignAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_assign');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    requireVisibleAccount(assignAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_assign');
    const assignedTo = String(body.assigned_to || operatorId).trim();
    const transfer = assignedTo !== operatorId;
    if (transfer) requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_manage');
    ensureOperator(workbenchDb, assignedTo, body.assigned_to_name || assignedTo);
    const assignmentResult = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const tx = accountDb.transaction(() => {
        const active = accountDb.prepare(`
          SELECT * FROM group_assignments
          WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
        `).get({ platform, account, groupId });
        if (active && active.assigned_to === assignedTo) return { assignment: active, created: false };
        if (active && !transfer) throw createHttpError(409, 'conversation is already assigned');
        if (active) {
          accountDb.prepare(`
            UPDATE group_assignments
            SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
          `).run(active.id);
        }
        const result = accountDb.prepare(`
          INSERT INTO group_assignments (platform, account, group_id, assigned_to, assigned_by)
          SELECT @platform, @account, @groupId, @assignedTo, @assignedBy
          WHERE NOT EXISTS (
            SELECT 1 FROM group_assignments
            WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
          )
        `).run({ platform, account, groupId, assignedTo, assignedBy: operatorId });
        if (!result.changes) throw createHttpError(409, 'conversation is already assigned');
        writeAction(accountDb, operatorId, 'conversation.assign', platform, account, groupId, result.lastInsertRowid, {
          assigned_to: assignedTo,
          transfer,
        });
        writeConversationTimeline(accountDb, operatorId, 'conversation.assign', platform, account, groupId, {
          assigned_to: assignedTo,
        });
        return {
          assignment: accountDb.prepare('SELECT * FROM group_assignments WHERE id = ?').get(result.lastInsertRowid),
          created: true,
        };
      });
      try {
        return tx();
      } catch (err) {
        if (String(err.code || '').includes('SQLITE_CONSTRAINT')) throw createHttpError(409, 'conversation is already assigned');
        throw err;
      }
    });
    if (assignmentResult.created) {
      emitChannelEvent(platform, account, groupId, 'assignment', {
        assigned_to: assignmentResult.assignment.assigned_to,
      });
    }
    res.status(assignmentResult.created ? 201 : 200).json({
      ok: true,
      assignment: assignmentResult.assignment,
      idempotent: !assignmentResult.created,
    });
  });

  router.post('/groups/:groupId/release', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const assignAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_assign');
    const operatorId = operator.id;
    const body = req.body || {};
    const platform = requirePlatform(body.platform);
    const account = requireText(body.account, 'account');
    requireVisibleAccount(assignAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_assign');
    const released = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const active = accountDb.prepare(`
        SELECT * FROM group_assignments
        WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
      `).get({ platform, account, groupId });
      if (!active) return 0;
      if (active.assigned_to !== operatorId) {
        requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_manage');
      }
      const result = accountDb.prepare(`
        UPDATE group_assignments
        SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND status = 'active'
      `).run({ id: active.id });
      writeAction(accountDb, operatorId, 'conversation.release', platform, account, groupId, groupId, {
        released: result.changes,
      });
      writeConversationTimeline(accountDb, operatorId, 'conversation.release', platform, account, groupId, {
        released: result.changes,
      });
      return result.changes;
    });
    if (released) emitChannelEvent(platform, account, groupId, 'assignment', { assigned_to: null });
    res.json({ ok: true, released });
  });

  router.get('/outbound/:id/attachments/:fileKey', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const result = withOutboundForRequest(accountData, req, (accountDb, row, context) => {
      requireVisibleAccount(visibleAccountScope, row.platform, row.account);
      requireConversationCapability(workbenchDb, operator, row.platform, row.account, row.group_id, 'can_view');
      const attachment = accountDb.prepare(`
        SELECT * FROM outbound_attachments WHERE outbound_id = ? AND file_key = ?
      `).get(row.id, req.params.fileKey);
      if (!attachment) throw createHttpError(404, 'attachment not found');
      return { attachment, row, context };
    });
    sendOutboundAttachment(res, result, { accountDataDir });
  });

  router.get('/outbound/:id', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const outbound = withOutboundForRequest(accountData, req, (accountDb, row) => {
      requireVisibleAccount(visibleAccountScope, row.platform, row.account);
      requireConversationCapability(workbenchDb, operator, row.platform, row.account, row.group_id, 'can_view');
      return row;
    });
    res.json({ ok: true, outbound: mapOutboundRow(outbound, { scopedIds: accountData.isolated }) });
  });

  router.post('/outbound/:id/cancel', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const replyAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_reply');
    const operatorId = operator.id;
    const outbound = withOutboundForRequest(accountData, req, (accountDb, row) => {
      requireVisibleAccount(replyAccountScope, row.platform, row.account);
      requireConversationCapability(workbenchDb, operator, row.platform, row.account, row.group_id, 'can_reply');
      if (!['pending', 'paused'].includes(row.status)) {
        throw createHttpError(409, `cannot cancel outbound in ${row.status} status`);
      }
      accountDb.prepare(`
        UPDATE outbound_messages
        SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `).run({ id: row.id });
      writeAction(accountDb, operatorId, 'outbound.cancel', row.platform, row.account, row.group_id, row.id, {});
      writeConversationTimeline(accountDb, operatorId, 'outbound.cancel', row.platform, row.account, row.group_id, {
        outbound_id: row.id,
      });
      return getOutbound(accountDb, row.id);
    });
    emitChannelEvent(outbound.platform, outbound.account, outbound.group_id, 'outbound_status', {
      outbound_id: outbound.id,
      status: outbound.status,
    });
    res.json({ ok: true, outbound: mapOutboundRow(outbound, { scopedIds: accountData.isolated }) });
  });

  router.post('/outbound/:id/retry', (req, res) => {
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const replyAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_reply');
    const operatorId = operator.id;
    const outbound = withOutboundForRequest(accountData, req, (accountDb, previous) => {
      requireVisibleAccount(replyAccountScope, previous.platform, previous.account);
      requireConversationCapability(workbenchDb, operator, previous.platform, previous.account, previous.group_id, 'can_reply');
      if (!['failed', 'dead', 'paused', 'canceled'].includes(previous.status)) {
        throw createHttpError(409, `cannot retry outbound in ${previous.status} status`);
      }
      const breaker = activeBreaker(accountDb, previous.platform, previous.account);
      const clientMsgId = req.body && req.body.client_msg_id
        ? String(req.body.client_msg_id)
        : `retry-${previous.id}-${Date.now()}`;
      const status = breaker ? 'paused' : 'pending';
      const result = accountDb.prepare(`
        INSERT INTO outbound_messages (
          client_msg_id, platform, account, group_id, chat_id, text, quote_msg_id,
          attachment_json, status, created_by, retry_of, retry_count
        )
        VALUES (
          @clientMsgId, @platform, @account, @groupId, @chatId, @text, @quoteMsgId,
          @attachmentJson, @status, @createdBy, @retryOf, @retryCount
        )
      `).run({
        clientMsgId,
        platform: previous.platform,
        account: previous.account,
        groupId: previous.group_id,
        chatId: previous.chat_id || previous.group_id,
        text: previous.text,
        quoteMsgId: previous.quote_msg_id,
        attachmentJson: previous.attachment_json,
        status,
        createdBy: operatorId,
        retryOf: previous.id,
        retryCount: 0,
      });
      const next = getOutbound(accountDb, result.lastInsertRowid);
      recordOutboundAttachmentRows(accountDb, next.id, parseJson(next.attachment_json, []));
      writeAction(accountDb, operatorId, 'outbound.retry', next.platform, next.account, next.group_id, next.id, {
        retry_of: previous.id,
      });
      writeConversationTimeline(accountDb, operatorId, 'outbound.retry', next.platform, next.account, next.group_id, {
        outbound_id: next.id,
        retry_of: previous.id,
      });
      if (next.status === 'pending') writeDoorbell(doorbellRoot, next);
      return next;
    });
    emitChannelEvent(outbound.platform, outbound.account, outbound.group_id, 'outbound_status', {
      outbound_id: outbound.id,
      status: outbound.status,
    });
    res.status(201).json({ ok: true, outbound: mapOutboundRow(outbound, { scopedIds: accountData.isolated }) });
  });

  router.use((err, req, res, next) => {
    if (!err) return next();
    const status = err.statusCode || err.status || 500;
    if (status >= 500) {
      console.error(`[workbench] ${req.method} ${req.originalUrl || req.url} failed:`, err.message);
    }
    res.status(status).json({
      ok: false,
      error: status >= 500 ? 'internal_error' : err.message,
    });
  });

  return router;
}

function enrichGroupsWithAccountData(accountData, workbenchDb, rawDbPath, groups, operatorId, accountScope) {
  if (!accountData.isolated) return enrichGroups(workbenchDb, rawDbPath, groups, operatorId, accountScope);
  const assignments = mergeMaps(accountData.mapWorkbenchDbs({ accountScope }, loadActiveAssignments));
  const reads = mergeMaps(accountData.mapWorkbenchDbs({ accountScope }, (db) => loadReads(db, operatorId)));
  const labels = mergeLabelMaps(accountData.mapWorkbenchDbs({ accountScope }, loadLabelMap));
  const profiles = mergeMaps(accountData.mapWorkbenchDbs({ accountScope }, loadConversationProfileMap));
  const notesCounts = mergeMaps(accountData.mapWorkbenchDbs({ accountScope }, loadConversationNotesCountMap));
  const breakers = mergeMaps(accountData.mapWorkbenchDbs({ accountScope }, loadActiveBreakerMap));
  const presence = mergePresenceMaps(accountData.mapWorkbenchDbs({ accountScope }, (db) => loadPresenceMap(db, workbenchDb)));
  const unreadCounts = accountData.countUnreadForGroups({
    accountScope,
    groups: groups.map((group) => {
      const key = groupKey(group.platform, group.account, group.group_id);
      const read = reads.get(key);
      return {
        platform: group.platform,
        account: group.account,
        group_id: group.group_id,
        last_read_message_id: read ? read.last_read_message_id : 0,
      };
    }),
  });
  const accountProfiles = new Map(accountData.listAccountProfiles({ accountScope }).map((profile) => [
    accountKey(profile.platform, profile.account),
    profile,
  ]));
  return mapEnrichedGroups(groups, accountProfiles, assignments, labels, unreadCounts, profiles, notesCounts, presence, breakers);
}

function enrichGroups(workbenchDb, rawDbPath, groups, operatorId, accountScope) {
  const assignments = loadActiveAssignments(workbenchDb);
  const reads = loadReads(workbenchDb, operatorId);
  const labels = loadLabelMap(workbenchDb);
  const profiles = loadConversationProfileMap(workbenchDb);
  const notesCounts = loadConversationNotesCountMap(workbenchDb);
  const breakers = loadActiveBreakerMap(workbenchDb);
  const presence = loadPresenceMap(workbenchDb, workbenchDb);
  const unreadCounts = countUnreadForGroups({
    rawDbPath,
    accountScope,
    groups: groups.map((group) => {
      const key = groupKey(group.platform, group.account, group.group_id);
      const read = reads.get(key);
      return {
        platform: group.platform,
        account: group.account,
        group_id: group.group_id,
        last_read_message_id: read ? read.last_read_message_id : 0,
      };
    }),
  });
  const accountProfiles = new Map(listAccountProfiles({ rawDbPath, accountScope }).map((profile) => [
    accountKey(profile.platform, profile.account),
    profile,
  ]));
  return mapEnrichedGroups(groups, accountProfiles, assignments, labels, unreadCounts, profiles, notesCounts, presence, breakers);
}

function mapEnrichedGroups(groups, accountProfiles, assignments, labels, unreadCounts, conversationProfiles = new Map(), notesCounts = new Map(), presence = new Map(), breakers = new Map()) {
  return groups.map((group) => {
    const key = groupKey(group.platform, group.account, group.group_id);
    const profile = accountProfiles.get(accountKey(group.platform, group.account));
    const conversationProfile = conversationProfiles.get(key) || defaultConversationProfile(group.platform, group.account, group.group_id);
    const unreadCount = Math.min(Number(unreadCounts.get(key) || 0), 99);
    return {
      id: key,
      platform: group.platform,
      account: group.account,
      account_display_name: profile && profile.display_name ? profile.display_name : group.account,
      account_role: profile && profile.account_role ? profile.account_role : 'service',
      account_status: profile && profile.status ? profile.status : null,
      send_enabled: profile ? Boolean(profile.send_enabled) : false,
      global_send_enabled: process.env.WORKBENCH_SEND_ENABLED === '1',
      send_breaker_active: breakers.has(accountKey(group.platform, group.account)),
      sync_groups_enabled: profile ? Boolean(profile.sync_groups_enabled) : false,
      risk_level: profile && profile.risk_level ? profile.risk_level : 'low',
      group_id: group.group_id,
      group_name: group.group_name,
      display_group_name: conversationProfile.internal_display_name || group.group_name,
      last_message_id: group.id,
      last_native_message_id: group.native_message_id || group.message_id || null,
      last_message_time: group.id ? normalizeTimestamp(group.timestamp, group.created_at) : null,
      last_sender_name: group.sender_name,
      last_content: group.content,
      last_direction: group.id ? inferDirection(group) : 'inbound',
      has_media: Boolean(group.has_media),
      message_count: group.message_count,
      unread_count: unreadCount,
      conversation_status: conversationProfile.status,
      status: conversationProfile.status,
      priority: conversationProfile.priority,
      starred: Boolean(Number(conversationProfile.starred)),
      follow_up_at: conversationProfile.follow_up_at,
      internal_display_name: conversationProfile.internal_display_name,
      customer_type_id: conversationProfile.customer_type_id,
      customer_type: conversationProfile.customer_type,
      owner_note: conversationProfile.owner_note,
      notes_count: Number(notesCounts.get(key) || 0),
      presence: presence.get(key) || [],
      assignment: assignments.get(key) || null,
      labels: labels.get(key) || [],
    };
  });
}

function loadActiveBreakerMap(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT platform, account, reason, cooldown_until
    FROM send_circuit_breaker
    WHERE status = 'cooldown'
      AND (cooldown_until IS NULL OR datetime(cooldown_until) > datetime('now'))
  `).all();
  rows.forEach((row) => map.set(accountKey(row.platform, row.account), row));
  return map;
}

function mergeMaps(maps) {
  const merged = new Map();
  maps.forEach((map) => {
    if (!map) return;
    map.forEach((value, key) => merged.set(key, value));
  });
  return merged;
}

function mergeLabelMaps(maps) {
  const merged = new Map();
  maps.forEach((map) => {
    if (!map) return;
    map.forEach((labels, key) => {
      if (!merged.has(key)) merged.set(key, []);
      merged.get(key).push(...labels);
    });
  });
  return merged;
}

function mergePresenceMaps(maps) {
  const merged = new Map();
  maps.forEach((map) => {
    if (!map) return;
    map.forEach((rows, key) => {
      if (!merged.has(key)) merged.set(key, []);
      merged.get(key).push(...rows);
    });
  });
  return merged;
}

function mergeGroupSources(rawGroups, syncedGroups) {
  const rawKeys = new Set(rawGroups.map((group) => groupKey(group.platform, group.account, group.group_id)));
  return [
    ...rawGroups,
    ...syncedGroups.filter((group) => !rawKeys.has(groupKey(group.platform, group.account, group.group_id))),
  ];
}

function listSyncedGroups(db, {
  platforms,
  accountScope,
  search,
  groupIds,
  limit = 200,
  offset = 0,
} = {}) {
  const params = {
    limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
    offset: Math.max(0, Number(offset) || 0),
  };
  const filters = [];
  const normalizedPlatforms = normalizePlatformList(platforms);
  if (normalizedPlatforms.length) {
    const placeholders = normalizedPlatforms.map((platform, index) => {
      const key = `platform${index}`;
      params[key] = platform;
      return `@${key}`;
    });
    filters.push(`platform IN (${placeholders.join(', ')})`);
  } else {
    applyAllowedPlatformsSql(filters, params);
  }
  applyAccountScopeSql(filters, params, accountScope);
  if (search && String(search).trim()) {
    params.search = `%${String(search).trim()}%`;
    filters.push('(group_name LIKE @search OR group_id LIKE @search OR account LIKE @search)');
  }
  const selectedGroupIds = [...new Set((Array.isArray(groupIds) ? groupIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (Array.isArray(groupIds) && !selectedGroupIds.length) return [];
  if (selectedGroupIds.length) {
    const placeholders = selectedGroupIds.map((id, index) => {
      const key = `groupId${index}`;
      params[key] = id;
      return `@${key}`;
    });
    filters.push(`group_id IN (${placeholders.join(', ')})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      NULL AS id,
      platform,
      account,
      group_id,
      group_name,
      NULL AS sender_id,
      '' AS sender_name,
      '' AS content,
      0 AS has_media,
      NULL AS media_path,
      0 AS timestamp,
      NULL AS raw_data,
      synced_at AS created_at,
      0 AS message_count
    FROM channel_groups
    ${where}
    ORDER BY lower(group_name) ASC, group_id ASC
    LIMIT @limit OFFSET @offset
  `).all(params);
}

function listSyncedGroupsAcross(accountData, {
  platforms,
  accountScope,
  search,
  groupIdsByAccount,
  limit = 200,
  offset = 0,
} = {}) {
  if (!accountData.isolated) {
    return listSyncedGroups(accountData.mapWorkbenchDbs({}, (db) => db)[0], {
      platforms,
      accountScope,
      search,
      groupIds: groupIdsByAccount instanceof Map
        ? [...(groupIdsByAccount.get('legacy') || [])]
        : undefined,
      limit,
      offset,
    });
  }
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  const rows = accountData.mapWorkbenchDbs({ platforms, accountScope }, (db, context) => listSyncedGroups(db, {
    platforms,
    accountScope,
    search,
    groupIds: groupIdsByAccount instanceof Map
      ? [...(groupIdsByAccount.get(accountKey(context.platform, context.account)) || [])]
      : undefined,
    limit: Math.min(normalizedLimit + normalizedOffset, 500),
    offset: 0,
  })).flat();
  return rows
    .sort((a, b) => String(a.group_name || '').localeCompare(String(b.group_name || ''), 'zh-Hans-CN') || String(a.group_id).localeCompare(String(b.group_id)))
    .slice(normalizedOffset, normalizedOffset + normalizedLimit);
}

function loadActiveAssignments(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT *
    FROM group_assignments
    WHERE status = 'active'
  `).all();
  rows.forEach((row) => map.set(groupKey(row.platform, row.account, row.group_id), row));
  return map;
}

function loadReads(db, operatorId) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT *
    FROM conversation_reads
    WHERE operator_id = ?
  `).all(operatorId);
  rows.forEach((row) => map.set(groupKey(row.platform, row.account, row.group_id), row));
  return map;
}

function loadLabelMap(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT
      m.platform,
      m.service_account AS account,
      m.chat_id AS group_id,
      l.id,
      l.native_group_id AS native_label_id,
      l.native_group_id,
      l.name,
      l.color,
      l.source AS kind,
      l.source,
      l.parent_native_group_id,
      l.group_level,
      l.is_manual,
      parent.name AS parent_name
    FROM conversation_service_group_map m
    JOIN service_groups l
      ON l.platform = m.platform
     AND l.service_account = m.service_account
     AND l.native_group_id = m.native_group_id
    LEFT JOIN service_groups parent
      ON parent.platform = l.platform
     AND parent.service_account = l.service_account
     AND parent.native_group_id = l.parent_native_group_id
    ORDER BY l.source ASC, l.name ASC
  `).all();
  rows.forEach((row) => {
    const key = groupKey(row.platform, row.account, row.group_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function loadConversationLabels(db, platform, account, groupId) {
  return db.prepare(`
    SELECT
      l.id,
      l.platform,
      l.service_account AS account,
      l.native_group_id AS native_label_id,
      l.native_group_id,
      l.name,
      l.color,
      l.source AS kind,
      l.source,
      l.parent_native_group_id,
      l.group_level,
      l.is_manual,
      parent.name AS parent_name
    FROM conversation_service_group_map m
    JOIN service_groups l
      ON l.platform = m.platform
     AND l.service_account = m.service_account
     AND l.native_group_id = m.native_group_id
    LEFT JOIN service_groups parent
      ON parent.platform = l.platform
     AND parent.service_account = l.service_account
     AND parent.native_group_id = l.parent_native_group_id
    WHERE m.platform = @platform
      AND m.service_account = @account
      AND m.chat_id = @groupId
    ORDER BY l.source ASC, l.name ASC
  `).all({
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    groupId: String(groupId || '').trim(),
  });
}

function defaultConversationProfile(platform, account, groupId) {
  return {
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    group_id: String(groupId || '').trim(),
    status: 'pending',
    priority: 'normal',
    starred: 0,
    follow_up_at: null,
    internal_display_name: '',
    customer_type_id: '',
    customer_type: '',
    owner_note: '',
    updated_by: null,
    created_at: null,
    updated_at: null,
  };
}

function serializeConversationProfile(row) {
  const profile = row || {};
  return {
    id: profile.id || null,
    platform: profile.platform,
    account: profile.account,
    group_id: profile.group_id,
    status: sanitizeConversationStatus(profile.status),
    priority: sanitizeConversationPriority(profile.priority),
    starred: Boolean(Number(profile.starred || 0)),
    follow_up_at: profile.follow_up_at || null,
    internal_display_name: profile.internal_display_name || '',
    customer_type_id: profile.customer_type_id || '',
    customer_type: profile.customer_type_option_name || profile.customer_type || '',
    owner_note: profile.owner_note || '',
    updated_by: profile.updated_by || null,
    created_at: profile.created_at || null,
    updated_at: profile.updated_at || null,
  };
}

function loadConversationProfile(db, platform, account, groupId) {
  const normalized = {
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    groupId: String(groupId || '').trim(),
  };
  const row = db.prepare(`
    SELECT p.*, o.name AS customer_type_option_name
    FROM conversation_profiles p
    LEFT JOIN customer_type_options o ON o.id = p.customer_type_id
    WHERE p.platform = @platform
      AND p.account = @account
      AND p.group_id = @groupId
  `).get(normalized);
  return serializeConversationProfile(row || defaultConversationProfile(normalized.platform, normalized.account, normalized.groupId));
}

function loadConversationProfileMap(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT p.*, o.name AS customer_type_option_name
    FROM conversation_profiles p
    LEFT JOIN customer_type_options o ON o.id = p.customer_type_id
  `).all();
  rows.forEach((row) => {
    map.set(groupKey(row.platform, row.account, row.group_id), serializeConversationProfile(row));
  });
  return map;
}

function listCustomerTypeOptions(db, platform, account, includeDisabled = false) {
  return db.prepare(`
    SELECT * FROM customer_type_options
    WHERE platform = @platform
      AND service_account = @account
      ${includeDisabled ? '' : "AND status = 'active'"}
    ORDER BY sort_order ASC, name ASC, id ASC
  `).all({
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
  });
}

function resolveCustomerTypeSelection(db, platform, account, value) {
  const id = String(value || '').trim();
  if (!id) return null;
  const option = db.prepare(`
    SELECT * FROM customer_type_options
    WHERE id = @id AND platform = @platform AND service_account = @account
  `).get({ id, platform: normalizePlatform(platform), account: String(account || '').trim() });
  if (!option || option.status !== 'active') throw createHttpError(400, 'customer type is not available for this account');
  return option;
}

function findCustomerTypeByName(db, platform, account, name) {
  return db.prepare(`
    SELECT * FROM customer_type_options
    WHERE platform = @platform AND service_account = @account AND name = @name
  `).get({
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    name: String(name || '').trim(),
  }) || null;
}

function createCustomerTypeOption(db, platform, account, input, operatorId) {
  const row = {
    id: `ctype-${crypto.randomBytes(10).toString('hex')}`,
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    name: sanitizeShortText(input.name, 60),
    color: normalizeColor(input.color) || '#64748b',
    sortOrder: Math.max(0, Math.min(Number(input.sort_order) || 0, 9999)),
    operatorId,
  };
  if (!row.name) throw createHttpError(400, 'customer type name is required');
  try {
    db.prepare(`
      INSERT INTO customer_type_options (
        id, platform, service_account, name, color, sort_order, status, created_by, updated_by
      ) VALUES (@id, @platform, @account, @name, @color, @sortOrder, 'active', @operatorId, @operatorId)
    `).run(row);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) throw createHttpError(409, 'customer type name already exists for this account');
    throw err;
  }
  writeAction(db, operatorId, 'customer_type.create', row.platform, row.account, null, row.id, { name: row.name });
  return db.prepare('SELECT * FROM customer_type_options WHERE id = ?').get(row.id);
}

function updateCustomerTypeOption(db, platform, account, optionId, input, operatorId) {
  const params = {
    id: String(optionId || '').trim(),
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
  };
  const current = db.prepare(`
    SELECT * FROM customer_type_options
    WHERE id = @id AND platform = @platform AND service_account = @account
  `).get(params);
  if (!current) throw createHttpError(404, 'customer type not found');
  const next = {
    ...params,
    name: hasPatchValue(input, 'name') ? sanitizeShortText(input.name, 60) : current.name,
    color: hasPatchValue(input, 'color') ? (normalizeColor(input.color) || '#64748b') : current.color,
    sortOrder: hasPatchValue(input, 'sort_order') ? Math.max(0, Math.min(Number(input.sort_order) || 0, 9999)) : current.sort_order,
    status: hasPatchValue(input, 'status') && String(input.status) === 'disabled' ? 'disabled' : 'active',
    operatorId,
  };
  if (!next.name) throw createHttpError(400, 'customer type name is required');
  const save = db.transaction(() => {
    try {
      db.prepare(`
        UPDATE customer_type_options
        SET name = @name, color = @color, sort_order = @sortOrder, status = @status,
            updated_by = @operatorId, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND platform = @platform AND service_account = @account
      `).run(next);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw createHttpError(409, 'customer type name already exists for this account');
      throw err;
    }
    db.prepare(`
      UPDATE conversation_profiles
      SET customer_type = @name, updated_at = CURRENT_TIMESTAMP
      WHERE customer_type_id = @id AND platform = @platform AND account = @account
    `).run(next);
    writeAction(db, operatorId, 'customer_type.update', next.platform, next.account, null, next.id, {
      before: { name: current.name, status: current.status },
      after: { name: next.name, status: next.status },
    });
  });
  save();
  return db.prepare('SELECT * FROM customer_type_options WHERE id = ?').get(next.id);
}

function loadConversationNotesCountMap(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT platform, account, group_id, COUNT(*) AS count
    FROM conversation_notes
    GROUP BY platform, account, group_id
  `).all();
  rows.forEach((row) => {
    map.set(groupKey(row.platform, row.account, row.group_id), Number(row.count || 0));
  });
  return map;
}

function loadConversationNotes(db, centralDb, platform, account, groupId, limit = 20, beforeId = 0) {
  const actorNames = loadOperatorNameMap(centralDb);
  return db.prepare(`
    SELECT *
    FROM conversation_notes
    WHERE platform = @platform
      AND account = @account
      AND group_id = @groupId
      AND (@beforeId = 0 OR id < @beforeId)
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `).all({
    platform,
    account,
    groupId,
    beforeId: Math.max(0, Number(beforeId) || 0),
    limit: Math.max(1, Math.min(Number(limit) || 20, 50)),
  }).map((row) => attachActorName(row, actorNames, 'created_by'));
}

function loadConversationNotesPage(db, centralDb, platform, account, groupId, { limit = 20, beforeId = 0 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 50));
  const rows = loadConversationNotes(db, centralDb, platform, account, groupId, bounded + 1, beforeId);
  const hasMore = rows.length > bounded;
  const notes = rows.slice(0, bounded);
  return {
    notes,
    paging: {
      has_more: hasMore,
      before_id: hasMore && notes.length ? notes[notes.length - 1].id : null,
    },
  };
}

function createConversationNote(db, platform, account, groupId, body, operatorId) {
  const noteBody = sanitizeLongText(body, 2000);
  if (!noteBody) throw createHttpError(400, 'note body is required');
  const result = db.prepare(`
    INSERT INTO conversation_notes (
      platform, account, group_id, body, created_by
    )
    VALUES (@platform, @account, @groupId, @body, @operatorId)
  `).run({
    platform,
    account,
    groupId,
    body: noteBody,
    operatorId,
  });
  writeConversationTimeline(db, operatorId, 'conversation.note.create', platform, account, groupId, {
    note_id: result.lastInsertRowid,
    note_length: noteBody.length,
  });
  return db.prepare('SELECT * FROM conversation_notes WHERE id = ?').get(result.lastInsertRowid);
}

function upsertConversationProfile(db, platform, account, groupId, patch = {}, operatorId = 'system') {
  const existing = loadConversationProfile(db, platform, account, groupId);
  const next = {
    ...existing,
    platform,
    account,
    group_id: groupId,
    updated_by: operatorId,
  };
  if (hasPatchValue(patch, 'status') || hasPatchValue(patch, 'conversation_status')) {
    next.status = sanitizeConversationStatus(patch.status ?? patch.conversation_status);
  }
  if (hasPatchValue(patch, 'priority')) next.priority = sanitizeConversationPriority(patch.priority);
  if (hasPatchValue(patch, 'starred')) next.starred = boolToInt(patch.starred);
  if (hasPatchValue(patch, 'follow_up_at') || hasPatchValue(patch, 'followUpAt')) {
    next.follow_up_at = normalizeFollowUpAt(patch.follow_up_at ?? patch.followUpAt);
  }
  if (hasPatchValue(patch, 'internal_display_name') || hasPatchValue(patch, 'internalDisplayName')) {
    next.internal_display_name = sanitizeShortText(patch.internal_display_name ?? patch.internalDisplayName, 120);
  }
  if (hasPatchValue(patch, 'customer_type_id') || hasPatchValue(patch, 'customerTypeId')) {
    const selection = resolveCustomerTypeSelection(
      db,
      platform,
      account,
      patch.customer_type_id ?? patch.customerTypeId,
    );
    next.customer_type_id = selection ? selection.id : '';
    next.customer_type = selection ? selection.name : '';
  }
  if (hasPatchValue(patch, 'customer_type') || hasPatchValue(patch, 'customerType')) {
    // Legacy clients may clear the field, but cannot create unmanaged values.
    const legacyName = sanitizeShortText(patch.customer_type ?? patch.customerType, 80);
    if (!legacyName) {
      next.customer_type_id = '';
      next.customer_type = '';
    } else if (!hasPatchValue(patch, 'customer_type_id') && !hasPatchValue(patch, 'customerTypeId')) {
      const selection = findCustomerTypeByName(db, platform, account, legacyName);
      if (!selection || selection.status !== 'active') throw createHttpError(400, 'customer type is not available for this account');
      next.customer_type_id = selection.id;
      next.customer_type = selection.name;
    }
  }
  if (hasPatchValue(patch, 'owner_note') || hasPatchValue(patch, 'ownerNote')) {
    next.owner_note = sanitizeLongText(patch.owner_note ?? patch.ownerNote, 1000);
  }

  db.prepare(`
    INSERT INTO conversation_profiles (
      platform, account, group_id, status, priority, starred, follow_up_at,
      internal_display_name, customer_type_id, customer_type, owner_note, updated_by, updated_at
    )
    VALUES (
      @platform, @account, @group_id, @status, @priority, @starred, @follow_up_at,
      @internal_display_name, @customer_type_id, @customer_type, @owner_note, @updated_by, CURRENT_TIMESTAMP
    )
    ON CONFLICT(platform, account, group_id) DO UPDATE SET
      status = excluded.status,
      priority = excluded.priority,
      starred = excluded.starred,
      follow_up_at = excluded.follow_up_at,
      internal_display_name = excluded.internal_display_name,
      customer_type_id = excluded.customer_type_id,
      customer_type = excluded.customer_type,
      owner_note = excluded.owner_note,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    ...next,
    starred: boolToInt(next.starred),
  });

  const saved = loadConversationProfile(db, platform, account, groupId);
  const changes = changedProfileFields(existing, saved);
  if (changes.length) {
    writeConversationTimeline(db, operatorId, 'conversation.profile.update', platform, account, groupId, {
      fields: changes,
      status: saved.status,
      priority: saved.priority,
      starred: saved.starred,
      follow_up_at: saved.follow_up_at,
    });
  }
  return saved;
}

function changedProfileFields(before, after) {
  return [
    'status',
    'priority',
    'starred',
    'follow_up_at',
    'internal_display_name',
    'customer_type_id',
    'customer_type',
    'owner_note',
  ].filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
}

function buildConversationWorkspace(db, centralDb, platform, account, groupId, { notesLimit = 3, timelineLimit = 3 } = {}) {
  const notesPage = loadConversationNotesPage(db, centralDb, platform, account, groupId, { limit: notesLimit });
  const timelinePage = loadConversationTimelinePage(db, centralDb, platform, account, groupId, { limit: timelineLimit });
  return {
    profile: loadConversationProfile(db, platform, account, groupId),
    notes: notesPage.notes,
    notes_paging: notesPage.paging,
    timeline: timelinePage.timeline,
    timeline_paging: timelinePage.paging,
    presence: loadConversationPresence(db, centralDb, platform, account, groupId),
  };
}

function saveConversationPresence(db, platform, account, groupId, operatorId, modeValue, active = true) {
  const mode = sanitizePresenceMode(modeValue);
  if (!active) {
    db.prepare(`
      DELETE FROM conversation_presence
      WHERE operator_id = @operatorId
        AND platform = @platform
        AND account = @account
        AND group_id = @groupId
        AND mode = @mode
    `).run({ operatorId, platform, account, groupId, mode });
    return;
  }
  const expiresAt = new Date(Date.now() + 90 * 1000).toISOString();
  db.prepare(`
    INSERT INTO conversation_presence (
      operator_id, platform, account, group_id, mode, expires_at, updated_at
    )
    VALUES (@operatorId, @platform, @account, @groupId, @mode, @expiresAt, CURRENT_TIMESTAMP)
    ON CONFLICT(operator_id, platform, account, group_id, mode) DO UPDATE SET
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
  `).run({ operatorId, platform, account, groupId, mode, expiresAt });
}

function loadPresenceMap(db, centralDb) {
  // 列表刷新是高频只读路径。过期状态由查询条件排除，不在这里清理，
  // 否则每次打开/刷新会话都会把读取升级为写入并和 worker 争 SQLite 锁。
  const map = new Map();
  const actorNames = loadOperatorNameMap(centralDb);
  const rows = db.prepare(`
    SELECT *
    FROM conversation_presence
    WHERE datetime(expires_at) > datetime('now')
    ORDER BY updated_at DESC
  `).all();
  rows.forEach((row) => {
    const key = groupKey(row.platform, row.account, row.group_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(attachActorName(row, actorNames, 'operator_id'));
  });
  return map;
}

function loadConversationPresence(db, centralDb, platform, account, groupId) {
  return loadPresenceMap(db, centralDb).get(groupKey(platform, account, groupId)) || [];
}

function loadConversationTimeline(db, centralDb, platform, account, groupId, limit = 50) {
  const actorNames = loadOperatorNameMap(centralDb);
  return db.prepare(`
    SELECT *
    FROM conversation_timeline
    WHERE platform = @platform
      AND account = @account
      AND group_id = @groupId
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `).all({
    platform,
    account,
    groupId,
    limit: Math.max(1, Math.min(Number(limit) || 50, 100)),
  }).map((row) => ({
    ...attachActorName(row, actorNames, 'actor_id'),
    payload: parseJson(row.payload_json, {}),
  }));
}

function loadConversationTimelinePage(db, centralDb, platform, account, groupId, { limit = 20, beforeId = 0 } = {}) {
  const actorNames = loadOperatorNameMap(centralDb);
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 100));
  const rows = db.prepare(`
    SELECT * FROM conversation_timeline
    WHERE platform = @platform
      AND account = @account
      AND group_id = @groupId
      AND (@beforeId = 0 OR id < @beforeId)
    ORDER BY created_at DESC, id DESC
    LIMIT @rowLimit
  `).all({
    platform,
    account,
    groupId,
    beforeId: Math.max(0, Number(beforeId) || 0),
    rowLimit: bounded + 1,
  }).map((row) => ({
    ...attachActorName(row, actorNames, 'actor_id'),
    payload: parseJson(row.payload_json, {}),
  }));
  const hasMore = rows.length > bounded;
  const timeline = rows.slice(0, bounded);
  return {
    timeline,
    paging: {
      has_more: hasMore,
      before_id: hasMore && timeline.length ? timeline[timeline.length - 1].id : null,
    },
  };
}

function writeConversationTimeline(db, actorId, actionType, platform, account, groupId, payload) {
  if (!groupId) return;
  db.prepare(`
    INSERT INTO conversation_timeline (
      platform, account, group_id, action_type, actor_id, payload_json
    )
    VALUES (@platform, @account, @groupId, @actionType, @actorId, @payloadJson)
  `).run({
    platform,
    account,
    groupId,
    actionType,
    actorId: String(actorId || 'system'),
    payloadJson: safeJson(payload || {}),
  });
}

function loadOperatorNameMap(db) {
  const rows = db.prepare(`
    SELECT id, display_name, username
    FROM operators
  `).all();
  return new Map(rows.map((row) => [String(row.id), row.display_name || row.username || row.id]));
}

function attachActorName(row, actorNames, fieldName) {
  const actorId = String(row[fieldName] || '');
  return {
    ...row,
    actor_name: actorNames.get(actorId) || actorId,
  };
}

function listOutboundMessages(db, { platform, account, groupId, scopedIds = false }) {
  return db.prepare(`
    SELECT *
    FROM outbound_messages
    WHERE platform = @platform AND account = @account AND group_id = @groupId
    ORDER BY created_at ASC, id ASC
    LIMIT 200
  `).all({ platform, account, groupId }).map((row) => mapOutboundRow(row, { scopedIds }));
}

function mergeConversationMessages(rawMessages, outboundMessages) {
  const outboundByRemoteId = new Map();
  outboundMessages.forEach((message) => {
    if (!message.remote_msg_id) return;
    outboundByRemoteId.set(String(message.remote_msg_id), message);
  });

  const matchedOutboundIds = new Set();
  const mergedRaw = rawMessages.map((message) => {
    const outbound = message.message_id ? outboundByRemoteId.get(String(message.message_id)) : null;
    if (!outbound) return message;
    matchedOutboundIds.add(outbound.outbound_id);
    return {
      ...message,
      outbound_id: outbound.outbound_id,
      client_msg_id: outbound.client_msg_id,
      status: outbound.status,
      remote_msg_id: outbound.remote_msg_id,
      sent_at: outbound.sent_at,
      delivered_at: outbound.delivered_at,
      read_at: outbound.read_at,
      provider_ack: outbound.provider_ack,
      error_code: outbound.error_code,
      error_message: outbound.error_message,
      error_display: outbound.error_display,
      retry_of: outbound.retry_of,
      retry_count: outbound.retry_count,
    };
  });

  return [
    ...mergedRaw,
    ...outboundMessages.filter((message) => !matchedOutboundIds.has(message.outbound_id)),
  ].sort((a, b) => {
    if (a.sort_time === b.sort_time) return String(a.id).localeCompare(String(b.id));
    return a.sort_time - b.sort_time;
  });
}

function collectMissingQuoteIds(messages) {
  return [...new Set((messages || [])
    .filter((message) => message?.quote_msg_id && !String(message.quote_text || '').trim())
    .map((message) => String(message.quote_msg_id).trim())
    .filter(Boolean))];
}

function enrichConversationQuoteTexts(messages, persistedQuoteTexts = new Map()) {
  const inPageQuoteTexts = buildInPageQuoteTextIndex(messages);
  return messages.map((message) => {
    const quoteId = String(message.quote_msg_id || '').trim();
    if (!quoteId || String(message.quote_text || '').trim()) return message;
    const quoteText = inPageQuoteTexts.get(quoteId) || persistedQuoteTexts.get(quoteId) || '';
    return quoteText ? { ...message, quote_text: quoteText } : message;
  });
}

function buildInPageQuoteTextIndex(messages) {
  const index = new Map();
  (messages || []).forEach((message) => {
    const text = quoteDisplayText(message);
    if (!text) return;
    messageReferenceIds(message).forEach((id) => {
      if (!index.has(id)) index.set(id, text);
    });
  });
  return index;
}

function messageReferenceIds(message) {
  const ids = [
    message.message_id,
    message.native_message_id,
    message.remote_msg_id,
    message.outbound_id,
    message.raw_id,
  ].map((id) => String(id || '').trim()).filter(Boolean);
  const groupId = String(message.group_id || '').trim();
  const expanded = [];
  ids.forEach((id) => {
    expanded.push(id);
    if (groupId && id.startsWith(`${groupId}:`)) expanded.push(id.slice(groupId.length + 1));
  });
  return [...new Set(expanded)];
}

function quoteDisplayText(message) {
  return String(message.display_text || message.text || '').trim() ||
    ((message.attachments || []).length || message.has_media ? '[媒体消息]' : '');
}

function mapRawMessage(row) {
  const timestamp = normalizeTimestamp(row.timestamp, row.created_at);
  const direction = inferDirection(row);
  const text = row.content;
  const raw = parseJson(row.raw_data, {});
  return {
    id: `raw-${row.id}`,
    raw_id: row.id,
    platform: row.platform,
    account: row.account,
    group_id: row.group_id,
    message_id: row.message_id,
    native_message_id: row.native_message_id || '',
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    sender_username: raw.sender_username || '',
    group_name: raw.chat_name || row.group_name,
    direction,
    text,
    display_text: text,
    quote_msg_id: raw.reply_to_msg_id || null,
    quote_text: raw.quote_text || '',
    forwarded_from: raw.forwarded_from || '',
    forwarded_at: raw.forwarded_at || '',
    edited_at: raw.edited_at || '',
    views: Number(raw.views) || 0,
    forwards: Number(raw.forwards) || 0,
    post_author: raw.post_author || '',
    media_kind: raw.media?.kind || '',
    has_media: Boolean(row.has_media),
    media_path: row.media_path,
    attachments: row.has_media || row.media_path ? [{
      id: `raw-media-${row.id}`,
      name: row.media_name || (row.media_path ? path.basename(String(row.media_path)) : '媒体消息'),
      type: row.media_mime || 'application/octet-stream',
      size: row.media_size || null,
      kind: raw.media?.kind === 'sticker' ? 'sticker' : (String(row.media_mime || '').startsWith('image/') ? 'image' : 'file'),
      media_kind: raw.media?.kind || '',
      duration: raw.media?.duration || null,
      detail: raw.media?.detail || '',
      media_path: row.media_path || null,
      media_url: row.media_path ? `/api/workbench/groups/${encodeURIComponent(row.group_id)}/media/${row.id}?platform=${encodeURIComponent(row.platform)}&account=${encodeURIComponent(row.account)}` : null,
    }] : [],
    status: direction === 'outbound' ? 'sent' : 'received',
    created_at: row.created_at,
    timestamp,
    sort_time: timestamp,
    source: 'raw',
  };
}

function openConversationEventDbs(accountData, centralWorkbenchDb, accountDataDir, platform, account) {
  const rawDb = openRawDb(accountData.rawDbPathFor(platform, account));
  if (!rawDb) throw createHttpError(404, 'conversation database not found');
  if (!accountData.isolated) return { rawDb, workbenchDb: centralWorkbenchDb, ownedWorkbenchDb: false };
  const accountWorkbenchDb = openWorkbenchDb(
    resolveAccountPaths(platform, account, { accountDataDir }).workbenchDbPath,
    { readonly: true },
  );
  return { rawDb, workbenchDb: accountWorkbenchDb, ownedWorkbenchDb: true };
}

function readConversationEventSignature(eventDbs, platform, account, groupId) {
  const { rawDb, workbenchDb: accountWorkbenchDb } = eventDbs;
  let raw = { max_id: 0, updated_at: '' };
  raw = rawDb.prepare(`
      SELECT
        COALESCE(MAX(m.id), 0) AS max_id,
        COALESCE(MAX(COALESCE(m.updated_at, m.created_at)), '') AS updated_at
      FROM messages m
      WHERE m.platform = @platform
        AND m.group_id = @groupId
        AND (
          COALESCE(NULLIF(m.receiver_account, ''), @account) = @account
          OR EXISTS (
            SELECT 1 FROM message_observations o
            WHERE o.platform = m.platform
              AND o.canonical_message_id = m.message_id
              AND o.observer_account = @account
              AND COALESCE(NULLIF(o.native_chat_id, ''), m.group_id) = @groupId
          )
        )
    `).get({ platform, account, groupId }) || raw;
  let outbound = { max_id: 0, updated_at: '', state_signature: '' };
  outbound = accountWorkbenchDb.prepare(`
      SELECT
        COALESCE(MAX(id), 0) AS max_id,
        COALESCE(MAX(updated_at), '') AS updated_at,
        COALESCE(SUM(status = 'pending'), 0) || ':' || COALESCE(SUM(status = 'sending'), 0) || ':' ||
        COALESCE(SUM(status = 'sent'), 0) || ':' || COALESCE(SUM(status = 'delivered'), 0) || ':' ||
        COALESCE(SUM(status = 'read'), 0) || ':' ||
        COALESCE(SUM(status = 'failed'), 0) || ':' || COALESCE(SUM(status = 'dead'), 0) || ':' ||
        COALESCE(SUM(status = 'paused'), 0) || ':' || COALESCE(SUM(status = 'canceled'), 0) AS state_signature
      FROM outbound_messages
      WHERE platform = @platform AND account = @account AND group_id = @groupId
    `).get({ platform, account, groupId }) || outbound;
  return [raw.max_id, raw.updated_at, outbound?.max_id || 0, outbound?.updated_at || '', outbound?.state_signature || ''].join(':');
}

function writeConversationEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

function mapOutboundRow(row, { scopedIds = false } = {}) {
  const timestamp = normalizeTimestamp(null, row.sent_at || row.created_at);
  const text = row.text;
  const outboundId = scopedIds ? publicOutboundId(row, { isolated: true }) : row.id;
  const attachments = parseJson(row.attachment_json, []).map((attachment) => {
    if (!attachment.local_path || !attachment.file_key) return attachment;
    return {
      ...attachment,
      media_url: `/api/workbench/outbound/${encodeURIComponent(outboundId)}/attachments/${encodeURIComponent(attachment.file_key)}`,
    };
  });
  return {
    id: `outbound-${outboundId}`,
    outbound_id: outboundId,
    local_outbound_id: row.id,
    client_msg_id: row.client_msg_id,
    platform: row.platform,
    account: row.account,
    group_id: row.group_id,
    chat_id: row.chat_id,
    direction: 'outbound',
    sender_name: row.account,
    text,
    display_text: text,
    quote_msg_id: row.quote_msg_id,
    attachments,
    status: row.status,
    remote_msg_id: row.remote_msg_id,
    retry_of: row.retry_of,
    retry_count: row.retry_count,
    error_code: row.error_code,
    error_message: row.error_message,
    error_display: humanizeOutboundFailure(row),
    created_at: row.created_at,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
    read_at: row.read_at,
    provider_ack: Number(row.provider_ack || 0),
    timestamp,
    sort_time: timestamp,
    source: 'workbench',
  };
}

function applyMentionDisplayNames(messages) {
  const contacts = buildConversationContactIndex(messages);
  if (!contacts.byDigits.size && !contacts.singleExternalName) return messages;
  return messages.map((message) => {
    const text = String(message.display_text || message.text || '');
    if (!text || !/@\d{6,20}\b/.test(text)) return message;
    const displayText = text.replace(/@(\d{6,20})\b/g, (match, digits) => {
      const exactName = contacts.byDigits.get(digits);
      if (exactName) return `@${exactName}`;
      if (contacts.singleExternalName && message.direction === 'outbound') return `@${contacts.singleExternalName}`;
      return match;
    });
    if (displayText === text) return message;
    return {
      ...message,
      display_text: displayText,
      mention_display_map: contacts.displayMap,
    };
  });
}

function buildConversationContactIndex(messages) {
  const byDigits = new Map();
  const displayMap = {};
  const externalNames = new Set();
  messages.forEach((message) => {
    if (!message || message.direction === 'outbound') return;
    const name = normalizeDisplayName(message.sender_name);
    if (!name) return;
    externalNames.add(name);
    extractDigits(message.sender_id).forEach((digits) => {
      byDigits.set(digits, name);
      displayMap[digits] = name;
    });
  });
  return {
    byDigits,
    displayMap,
    singleExternalName: externalNames.size === 1 ? [...externalNames][0] : '',
  };
}

function normalizeDisplayName(value) {
  const text = String(value || '').trim();
  if (!text || text === '未知成员') return '';
  if (/^\d{6,20}$/.test(text)) return '';
  return text;
}

function extractDigits(value) {
  const text = String(value || '');
  const matches = text.match(/\d{6,20}/g) || [];
  return [...new Set(matches)];
}

function inferDirection(row) {
  const raw = parseJson(row.raw_data, {});
  if (raw.fromMe === true || raw.is_from_me === true || raw.direction === 'outbound') return 'outbound';
  return 'inbound';
}

function normalizeTimestamp(timestamp, createdAt) {
  const numeric = Number(timestamp);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1000000000000 ? numeric : numeric * 1000;
  }
  const parsed = parseSqlTimestamp(createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseSqlTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return Date.parse(`${text.replace(' ', 'T')}Z`);
  }
  return Date.parse(text);
}

function normalizeAttachments(input) {
  if (input === undefined || input === null || input === '') return [];
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      throw createHttpError(400, 'invalid attachment json');
    }
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > MAX_ATTACHMENTS) {
    throw createHttpError(413, `too many attachments, max ${MAX_ATTACHMENTS}`);
  }
  let totalSize = 0;
  return list.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw createHttpError(400, 'attachment must be an object');
    }
    const name = sanitizeAttachmentName(item.name, index);
    let type = sanitizeMimeType(item.type || item.mime_type);
    const normalizedData = normalizeAttachmentData(item, type);
    type = normalizedData.mimeType || type;
    let kind = normalizeAttachmentKind(item.kind);
    if (type.startsWith('image/') && kind === 'file') kind = 'image';
    if (kind === 'sticker' && !type.startsWith('image/')) {
      throw createHttpError(400, 'sticker attachment must be an image');
    }
    const { dataUrl, size } = normalizedData;
    totalSize += size;
    if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw createHttpError(413, 'attachment total size is too large');
    }
    return {
      id: String(item.id || `attachment-${index + 1}`).slice(0, 80),
      name,
      type,
      size,
      kind,
      data_url: dataUrl,
    };
  });
}

function persistOutboundAttachmentFiles(attachments, { platform, account, accountPaths, accountDataDir } = {}) {
  if (!attachments.length) return [];
  const accountDir = attachmentAccountDir({ platform, account, accountPaths, accountDataDir });
  const month = new Date().toISOString().slice(0, 7);
  const targetDir = path.join(accountDir, 'attachments', 'outbound', month);
  fs.mkdirSync(targetDir, { recursive: true });
  return attachments.map((attachment, index) => {
    const dataUrl = String(attachment.data_url || '');
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw createHttpError(400, 'attachment data is empty');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const extension = attachmentExtension(attachment.type);
    const fileName = `${sha256}${extension}`;
    const absolutePath = path.join(targetDir, fileName);
    if (!fs.existsSync(absolutePath)) {
      const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, buffer, { mode: 0o600 });
      try {
        fs.renameSync(tempPath, absolutePath);
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch (_) { }
        if (!fs.existsSync(absolutePath)) throw err;
      }
    }
    const relativePath = path.relative(accountDir, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw createHttpError(500, 'attachment path escaped account directory');
    }
    return {
      id: attachment.id,
      file_key: `${sha256.slice(0, 24)}-${index + 1}`,
      name: attachment.name,
      type: attachment.type,
      size: buffer.length,
      kind: attachment.kind,
      sha256,
      local_path: relativePath.split(path.sep).join('/'),
    };
  });
}

function recordOutboundAttachmentRows(db, outboundId, attachments) {
  const insert = db.prepare(`
    INSERT INTO outbound_attachments (
      outbound_id, file_key, relative_path, sha256, mime, size, name
    ) VALUES (
      @outboundId, @fileKey, @relativePath, @sha256, @mime, @size, @name
    )
    ON CONFLICT(outbound_id, file_key) DO NOTHING
  `);
  (attachments || []).forEach((attachment) => {
    if (!attachment.local_path || !attachment.file_key || !attachment.sha256) return;
    insert.run({
      outboundId,
      fileKey: attachment.file_key,
      relativePath: attachment.local_path,
      sha256: attachment.sha256,
      mime: attachment.type || 'application/octet-stream',
      size: Number(attachment.size || 0),
      name: attachment.name || 'attachment',
    });
  });
}

function attachmentAccountDir({ platform, account, accountPaths, accountDataDir } = {}) {
  if (accountPaths?.accountDir) return path.resolve(accountPaths.accountDir);
  if (accountDataDir) return path.join(path.resolve(accountDataDir), sanitizeSegment(platform), sanitizeSegment(account));
  return path.join(resolveDataDir(), 'accounts', sanitizeSegment(platform), sanitizeSegment(account));
}

function attachmentExtension(mime) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/zip': '.zip',
  };
  return map[String(mime || '').toLowerCase()] || '.bin';
}

function sendOutboundAttachment(res, { attachment, row, context }, { accountDataDir } = {}) {
  const accountDir = attachmentAccountDir({
    platform: row.platform,
    account: row.account,
    accountPaths: context.paths,
    accountDataDir,
  });
  const absolutePath = path.resolve(accountDir, attachment.relative_path);
  const relative = path.relative(accountDir, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createHttpError(403, 'invalid attachment path');
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw createHttpError(404, 'attachment file missing');
  }
  const mime = String(attachment.mime || 'application/octet-stream');
  const safeInline = /^image\/(?:png|jpeg|webp|gif)$/i.test(mime) && res.req.query.download !== '1';
  const name = String(attachment.name || 'attachment').replace(/[\r\n"\\/]/g, '_');
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_') || 'attachment';
  const encodedName = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(fs.statSync(absolutePath).size));
  res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  fs.createReadStream(absolutePath).on('error', (err) => res.destroy(err)).pipe(res);
}

function sanitizeAttachmentName(name, index) {
  const cleaned = String(name || `attachment-${index + 1}`)
    .replace(/[\\/\r\n]/g, '_')
    .trim()
    .slice(0, 180);
  return cleaned || `attachment-${index + 1}`;
}

function sanitizeMimeType(type) {
  const cleaned = String(type || 'application/octet-stream').trim().toLowerCase().slice(0, 120);
  return cleaned || 'application/octet-stream';
}

function normalizeAttachmentKind(kind) {
  const cleaned = String(kind || '').trim().toLowerCase();
  return ALLOWED_ATTACHMENT_KINDS.has(cleaned) ? cleaned : 'file';
}

function normalizeAttachmentData(item, fallbackType) {
  let dataUrl = String(item.data_url || item.dataUrl || '').trim();
  let base64 = '';
  let mimeType = fallbackType || 'application/octet-stream';
  if (dataUrl) {
    const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/s);
    if (!match) throw createHttpError(400, 'attachment data_url must be base64 data URL');
    if (match[1]) mimeType = sanitizeMimeType(match[1]);
    base64 = match[2].replace(/\s/g, '');
  } else if (item.data_base64 || item.base64) {
    base64 = String(item.data_base64 || item.base64).replace(/\s/g, '');
  }
  if (!base64) throw createHttpError(400, 'attachment data is required');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw createHttpError(400, 'attachment data is not valid base64');
  }
  const actualSize = Buffer.byteLength(base64, 'base64');
  const declaredSize = Number(item.size || actualSize);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0 || actualSize <= 0) {
    throw createHttpError(400, 'attachment size is invalid');
  }
  const size = Math.max(declaredSize, actualSize);
  if (size > MAX_ATTACHMENT_BYTES) {
    throw createHttpError(413, 'attachment is too large');
  }
  return {
    dataUrl: `data:${mimeType};base64,${base64}`,
    size,
    mimeType,
  };
}

function normalizeMessageFilters(query = {}) {
  const search = sanitizeShortText(query.message_search ?? query.q ?? query.search, 160).toLowerCase();
  const sender = sanitizeShortText(query.sender ?? query.sender_name, 120).toLowerCase();
  const dateFrom = parseFilterTime(query.date_from ?? query.from);
  const dateTo = parseFilterTime(query.date_to ?? query.to, true);
  const hasAttachment = hasQueryValue(query.has_attachment)
    ? ['1', 'true', 'yes', 'on'].includes(String(query.has_attachment).trim().toLowerCase())
    : null;
  return {
    search,
    sender,
    dateFrom,
    dateTo,
    hasAttachment,
    active: Boolean(search || sender || dateFrom || dateTo || hasAttachment !== null),
  };
}

function filterConversationMessages(messages, filters) {
  return messages.filter((message) => {
    if (filters.search) {
      const text = [
        message.display_text,
        message.text,
        message.sender_name,
        message.message_id,
        ...(message.attachments || []).map((attachment) => attachment.name),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!text.includes(filters.search)) return false;
    }
    if (filters.sender) {
      const sender = String(message.sender_name || '').toLowerCase();
      if (!sender.includes(filters.sender)) return false;
    }
    const time = messageTimestampMs(message);
    if (filters.dateFrom && (!time || time < filters.dateFrom)) return false;
    if (filters.dateTo && (!time || time > filters.dateTo)) return false;
    if (filters.hasAttachment !== null && messageHasAttachment(message) !== filters.hasAttachment) return false;
    return true;
  });
}

function parseFilterTime(value, endOfDay = false) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const dateOnly = Date.parse(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
    return Number.isFinite(dateOnly) ? dateOnly : null;
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function messageTimestampMs(message) {
  const timestamp = Number(message.timestamp || message.sort_time || 0);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp > 1000000000000 ? timestamp : timestamp * 1000;
  return parseSqlTimestamp(message.created_at);
}

function messageHasAttachment(message) {
  return Boolean(
    message &&
    (
      message.has_media ||
      message.media_path ||
      (Array.isArray(message.attachments) && message.attachments.length)
    )
  );
}

function sanitizeConversationStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return CONVERSATION_STATUSES.has(status) ? status : 'pending';
}

function sanitizeConversationPriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return CONVERSATION_PRIORITIES.has(priority) ? priority : 'normal';
}

function sanitizePresenceMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return PRESENCE_MODES.has(mode) ? mode : 'viewing';
}

function sanitizeShortText(value, maxLength = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeLongText(value, maxLength = 2000) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function normalizeFollowUpAt(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw createHttpError(400, 'follow_up_at is invalid');
  return new Date(parsed).toISOString();
}

function hasPatchValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function hasProfileManageFields(body = {}) {
  return [
    'internal_display_name',
    'internalDisplayName',
    'customer_type',
    'customerType',
    'customer_type_id',
    'customerTypeId',
    'status',
    'conversation_status',
    'owner_note',
    'ownerNote',
  ].some((key) => hasPatchValue(body, key));
}

function normalizeBulkAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (['mark_read', 'assign', 'release', 'status', 'star', 'add_tags'].includes(action)) return action;
  throw createHttpError(400, 'unsupported bulk action');
}

function bulkActionCapability(action) {
  if (action === 'assign' || action === 'release') return 'can_assign';
  if (action === 'add_tags') return 'can_manage';
  return 'can_view';
}

function normalizeBulkConversationItems(value) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, 100).map((item) => ({
    platform: requirePlatform(item.platform),
    account: requireText(item.account, 'account'),
    group_id: requireText(item.group_id || item.groupId, 'group_id'),
    last_message_id: item.last_message_id ?? item.lastMessageId ?? null,
    last_read_message_id: item.last_read_message_id ?? item.lastReadMessageId ?? null,
  }));
}

function runBulkConversationAction(accountData, centralDb, {
  action,
  item,
  body,
  operatorId,
  accountScope,
  allowManage = false,
}) {
  if (action === 'mark_read') {
    const lastReadMessageId = Number(
      item.last_read_message_id ||
      body.last_read_message_id ||
      item.last_message_id ||
      body.last_message_id ||
      0,
    );
    if (!lastReadMessageId) throw createHttpError(400, 'last_read_message_id is required for mark_read');
    accountData.withWorkbenchDb(item.platform, item.account, { create: true }, (accountDb) => {
      accountDb.prepare(`
        INSERT INTO conversation_reads (
          operator_id, platform, account, group_id, last_read_message_id, last_read_at, updated_at
        )
        VALUES (@operatorId, @platform, @account, @groupId, @lastReadMessageId, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(operator_id, platform, account, group_id) DO UPDATE SET
          last_read_message_id = MAX(COALESCE(conversation_reads.last_read_message_id, 0), excluded.last_read_message_id),
          last_read_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).run({
        operatorId,
        platform: item.platform,
        account: item.account,
        groupId: item.group_id,
        lastReadMessageId,
      });
      writeConversationTimeline(accountDb, operatorId, 'conversation.bulk.mark_read', item.platform, item.account, item.group_id, {
        last_read_message_id: lastReadMessageId,
      });
    });
    const unreadCount = Math.min(accountData.countUnread({
      platform: item.platform,
      account: item.account,
      accountScope,
      groupId: item.group_id,
      lastReadMessageId,
    }), 99);
    return { changed: true, unread_count: unreadCount };
  }

  if (action === 'assign') {
    const assignedTo = String(body.assigned_to || operatorId).trim();
    const transfer = assignedTo !== operatorId;
    ensureOperator(centralDb, assignedTo, body.assigned_to_name || assignedTo);
    const result = accountData.withWorkbenchDb(item.platform, item.account, { create: true }, (accountDb) => {
      const tx = accountDb.transaction(() => {
        const params = { platform: item.platform, account: item.account, groupId: item.group_id, assignedTo, operatorId };
        const active = accountDb.prepare(`
          SELECT * FROM group_assignments
          WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
        `).get(params);
        if (active && active.assigned_to === assignedTo) return { assignment: active, changed: false };
        if (active && !transfer) throw createHttpError(409, 'conversation is already assigned');
        if (active) {
          accountDb.prepare(`
            UPDATE group_assignments
            SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
          `).run(active.id);
        }
        const insert = accountDb.prepare(`
          INSERT INTO group_assignments (platform, account, group_id, assigned_to, assigned_by)
          SELECT @platform, @account, @groupId, @assignedTo, @operatorId
          WHERE NOT EXISTS (
            SELECT 1 FROM group_assignments
            WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
          )
        `).run(params);
        if (!insert.changes) throw createHttpError(409, 'conversation is already assigned');
        writeConversationTimeline(accountDb, operatorId, 'conversation.bulk.assign', item.platform, item.account, item.group_id, {
          assigned_to: assignedTo,
        });
        return {
          assignment: accountDb.prepare('SELECT * FROM group_assignments WHERE id = ?').get(insert.lastInsertRowid),
          changed: true,
        };
      });
      return tx();
    });
    return result;
  }

  if (action === 'release') {
    const released = accountData.withWorkbenchDb(item.platform, item.account, { create: true }, (accountDb) => {
      const active = accountDb.prepare(`
        SELECT * FROM group_assignments
        WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
      `).get({ platform: item.platform, account: item.account, groupId: item.group_id });
      if (!active) return 0;
      if (active.assigned_to !== operatorId && !allowManage) {
        throw createHttpError(403, 'cannot release another operator assignment');
      }
      const result = accountDb.prepare(`
        UPDATE group_assignments
        SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND status = 'active'
      `).run({ id: active.id });
      writeConversationTimeline(accountDb, operatorId, 'conversation.bulk.release', item.platform, item.account, item.group_id, {
        released: result.changes,
      });
      return result.changes;
    });
    return { changed: Boolean(released), released };
  }

  if (action === 'status') {
    const profile = accountData.withWorkbenchDb(item.platform, item.account, { create: true }, (accountDb) => (
      upsertConversationProfile(accountDb, item.platform, item.account, item.group_id, { status: body.status }, operatorId)
    ));
    return { changed: true, profile };
  }

  if (action === 'star') {
    const profile = accountData.withWorkbenchDb(item.platform, item.account, { create: true }, (accountDb) => (
      upsertConversationProfile(accountDb, item.platform, item.account, item.group_id, { starred: body.starred !== false }, operatorId)
    ));
    return { changed: true, profile };
  }

  if (action === 'add_tags') {
    const manualGroupIds = normalizeManualGroupIds(body.manual_group_ids ?? body.native_group_ids ?? body.group_ids ?? []);
    if (!manualGroupIds.length) throw createHttpError(400, 'manual_group_ids are required');
    const labels = accountData.withWorkbenchDb(item.platform, item.account, { create: true }, (accountDb) => {
      const manualGroups = loadManualServiceGroupsByIds(accountDb, item.platform, item.account, manualGroupIds);
      if (manualGroups.length !== manualGroupIds.length) {
        throw createHttpError(400, 'manual_group_ids contains unknown or non-manual groups');
      }
      const insert = accountDb.prepare(`
        INSERT INTO conversation_service_group_map (
          platform, service_account, chat_id, native_group_id, synced_at
        )
        VALUES (@platform, @account, @groupId, @nativeGroupId, @syncedAt)
        ON CONFLICT(platform, service_account, chat_id, native_group_id) DO UPDATE SET
          synced_at = excluded.synced_at,
          updated_at = CURRENT_TIMESTAMP
      `);
      const syncedAt = new Date().toISOString();
      manualGroupIds.forEach((nativeGroupId) => {
        insert.run({
          platform: item.platform,
          account: item.account,
          groupId: item.group_id,
          nativeGroupId,
          syncedAt,
        });
      });
      writeConversationTimeline(accountDb, operatorId, 'conversation.bulk.add_tags', item.platform, item.account, item.group_id, {
        manual_group_ids: manualGroupIds,
      });
      return loadConversationLabels(accountDb, item.platform, item.account, item.group_id);
    });
    return { changed: true, labels };
  }

  throw createHttpError(400, 'unsupported bulk action');
}

function humanizeOutboundFailure(row) {
  const code = String(row.error_code || '').trim();
  const message = String(row.error_message || '').trim();
  if (!code && !message) return '';
  if (code === 'CIRCUIT_BREAKER') return '该服务账号短时间失败过多，已暂停发送，稍后可重试。';
  if (code === 'SEND_DISABLED') return '生产发送开关未开启，消息没有真实外发。';
  if (code === 'CHANNEL_NOT_READY') return '服务账号 worker 尚未在线，请确认账号已登录。';
  if (code === 'STALE_SENDING_RECOVERED') return 'worker 重启后已恢复该发送任务。';
  if (/floodwait|peerflood/i.test(`${code} ${message}`)) return 'Telegram 触发频控，当前账号应暂停外发。';
  if (/not.*found|chat.*invalid|peer/i.test(message)) return '找不到目标会话，可能群已退出或账号无权限。';
  return message || code || '发送失败，请稍后重试。';
}

function currentOperatorContext(db, req) {
  if (req.workbenchOperator) return req.workbenchOperator;
  const operator = resolveWorkbenchOperator(db, req);
  req.workbenchOperator = operator;
  return operator;
}

function mapOperator(operator) {
  return {
    id: operator.id,
    username: operator.username,
    display_name: operator.display_name,
    role: operator.role,
    status: operator.status,
    is_super_admin: Boolean(operator.is_super_admin),
  };
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    mobile: user.mobile,
    department: user.department,
    role: user.role,
  };
}

function buildAdminAccessPayload({ workbenchDb, rawDbPath, accountScope, accountData }) {
  const users = listAdminOperators(workbenchDb).map((operator) => enrichOperatorAccess(workbenchDb, operator));
  const accounts = (accountData ? accountData.listAccounts({ accountScope }) : listAccounts({ rawDbPath, accountScope })).map((account) => ({
    platform: account.platform,
    account: account.account,
    account_display_name: account.account_display_name || account.account,
    message_count: Number(account.message_count || 0),
    last_message_at: account.last_message_at || null,
  }));
  const serviceGroups = accountData ? listAdminServiceGroupsAcross(accountData, accountScope) : listAdminServiceGroups(workbenchDb);
  return {
    ok: true,
    users,
    roles: listRoles(workbenchDb),
    permissions: listPermissions(workbenchDb),
    accounts,
    service_groups: serviceGroups,
    scope_special_groups: [
      { native_group_id: ALL_GROUPS, name: '全部会话', source: 'system' },
      { native_group_id: UNGROUPED_GROUP, name: '未分组会话', source: 'system' },
    ],
  };
}

function queryWorkbenchDbs(accountData, { platforms, accountScope, sql, params = {} } = {}) {
  return accountData.mapWorkbenchDbs({ platforms, accountScope }, (db) => db.prepare(sql).all(params)).flat();
}

function accountChannelStats(accountData, workbenchDb, platform, account) {
  return accountData.withWorkbenchDb(platform, account, { readonly: accountData.isolated }, (accountDb) => {
    const breaker = activeBreaker(accountDb, platform, account);
    return {
      label_count: countLabels(accountDb, platform, account),
      synced_group_count: countSyncedGroups(accountDb, platform, account),
      last_channel_sync_at: lastChannelSyncAt(accountDb, platform, account),
      send_breaker_active: Boolean(breaker),
      send_breaker_reason: breaker?.reason || '',
    };
  });
}

function mapServiceAccount(account, accountData, workbenchDb) {
  const status = String(account.account_status || '').toLowerCase();
  const isConnected = CONNECTED_ACCOUNT_STATUSES.has(status);
  const sendEnabled = Number(account.send_enabled) !== 0;
  const globalSendEnabled = process.env.WORKBENCH_SEND_ENABLED === '1';
  return {
    ...account,
    ...accountChannelStats(accountData, workbenchDb, account.platform, account.account),
    is_connected: isConnected,
    global_send_enabled: globalSendEnabled,
    can_send: isConnected && sendEnabled && globalSendEnabled,
  };
}

function listAdminOperators(db) {
  return db.prepare(`
    SELECT id, username, display_name, role, status, created_at, updated_at
    FROM operators
    ORDER BY updated_at DESC, id ASC
  `).all().sort((left, right) => {
    const leftAdmin = isWorkbenchSuperAdmin(db, left) ? 1 : 0;
    const rightAdmin = isWorkbenchSuperAdmin(db, right) ? 1 : 0;
    return rightAdmin - leftAdmin;
  });
}

function upsertAdminOperator(db, input = {}) {
  const id = requireText(input.id || input.username, 'operator_id');
  const username = String(input.username || id).trim() || id;
  const displayName = String(input.display_name || input.displayName || username).trim() || username;
  const role = normalizeAdminOperatorRole(input.role || 'agent');
  const status = normalizeAdminOperatorStatus(input.status || 'active');
  db.prepare(`
    INSERT INTO operators (id, username, display_name, role, status)
    VALUES (@id, @username, @displayName, @role, @status)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      role = excluded.role,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id,
    username,
    displayName,
    role,
    status,
  });
  return getAdminOperator(db, id);
}

function updateAdminOperator(db, operatorId, patch = {}) {
  const existing = getAdminOperator(db, operatorId);
  if (!existing) throw createHttpError(404, 'operator not found');
  return upsertAdminOperator(db, {
    id: existing.id,
    username: patch.username || existing.username,
    display_name: patch.display_name ?? patch.displayName ?? existing.display_name,
    role: patch.role || existing.role,
    status: patch.status || existing.status,
  });
}

function deleteAdminOperator(db, operatorId, currentOperatorId, accountData) {
  const id = requireText(operatorId, 'id');
  const existing = getAdminOperator(db, id);
  if (!existing) throw createHttpError(404, 'operator not found');
  if (isWorkbenchSuperAdmin(db, existing)) throw createHttpError(400, 'super admin cannot be deleted');
  if (id === String(currentOperatorId || '').trim()) throw createHttpError(400, 'current operator cannot be deleted');

  const releaseAssignments = (targetDb) => {
    targetDb.prepare(`
      UPDATE group_assignments
      SET status = 'released',
          released_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE assigned_to = ? AND status = 'active'
    `).run(id);
    targetDb.prepare('DELETE FROM conversation_reads WHERE operator_id = ?').run(id);
  };

  if (accountData?.isolated) {
    accountData.mapWorkbenchDbs({ writable: true }, releaseAssignments);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM operator_roles WHERE operator_id = ?').run(id);
    db.prepare('DELETE FROM operator_portal_access WHERE operator_id = ?').run(id);
    db.prepare('DELETE FROM operator_service_group_scopes WHERE operator_id = ?').run(id);
    releaseAssignments(db);
    db.prepare('DELETE FROM operators WHERE id = ?').run(id);
  })();

  return {
    id: existing.id,
    username: existing.username,
    display_name: existing.display_name,
  };
}

function getAdminOperator(db, operatorId) {
  return db.prepare(`
    SELECT id, username, display_name, role, status, created_at, updated_at
    FROM operators
    WHERE id = ?
  `).get(String(operatorId || '').trim());
}

function enrichOperatorAccess(db, operator) {
  const operatorContext = {
    id: String(operator.id),
    username: operator.username,
    display_name: operator.display_name,
    role: operator.role,
    status: operator.status,
    identities: [String(operator.id), operator.username, operator.display_name].filter(Boolean),
  };
  return {
    id: String(operator.id),
    username: operator.username,
    display_name: operator.display_name,
    role: operator.role,
    status: operator.status,
    operator_id: String(operator.id),
    is_super_admin: isWorkbenchSuperAdmin(db, operatorContext),
    roles: listOperatorRoles(db, String(operator.id)),
    portal_access: loadEditablePortalAccess(db, String(operator.id), operatorContext),
    scopes: listEditableOperatorScopes(db, String(operator.id)),
  };
}

function loadEditablePortalAccess(db, operatorId, operatorContext = null) {
  const row = db.prepare(`
    SELECT can_monitor, can_workbench, can_admin, default_entry
    FROM operator_portal_access
    WHERE operator_id = ?
  `).get(String(operatorId));
  const derived = operatorContext ? loadPortalAccess(db, operatorContext) : {};
  return {
    can_monitor: false,
    can_workbench: Boolean(row ? Number(row.can_workbench) : derived.can_workbench),
    can_admin: Boolean(row ? Number(row.can_admin) : derived.can_admin),
    default_entry: normalizeAdminDefaultEntry(row ? row.default_entry : derived.default_entry),
    landing: derived.landing || '/',
  };
}

function savePortalAccess(db, operatorId, input = {}) {
  const id = String(operatorId || '').trim();
  if (!id) throw createHttpError(400, 'operator_id is required');
  const row = {
    operator_id: id,
    can_monitor: 0,
    can_workbench: boolToInt(input.can_workbench),
    can_admin: boolToInt(input.can_admin),
    default_entry: normalizeAdminDefaultEntry(input.default_entry),
  };
  db.prepare(`
    INSERT INTO operator_portal_access (operator_id, can_monitor, can_workbench, can_admin, default_entry, updated_at)
    VALUES (@operator_id, @can_monitor, @can_workbench, @can_admin, @default_entry, CURRENT_TIMESTAMP)
    ON CONFLICT(operator_id) DO UPDATE SET
      can_monitor = excluded.can_monitor,
      can_workbench = excluded.can_workbench,
      can_admin = excluded.can_admin,
      default_entry = excluded.default_entry,
      updated_at = CURRENT_TIMESTAMP
  `).run(row);
  return loadEditablePortalAccess(db, id);
}

function replaceOperatorScopes(db, operatorId, scopes = []) {
  const id = String(operatorId || '').trim();
  if (!id) throw createHttpError(400, 'operator_id is required');
  const normalized = (Array.isArray(scopes) ? scopes : []).map(normalizeAdminScope).filter(Boolean);
  const save = db.transaction(() => {
    db.prepare('DELETE FROM operator_service_group_scopes WHERE operator_id = ?').run(id);
    const insert = db.prepare(`
      INSERT INTO operator_service_group_scopes (
        operator_id, platform, service_account, native_group_id,
        can_view, can_reply, can_assign, can_manage, updated_at
      )
      VALUES (
        @operator_id, @platform, @service_account, @native_group_id,
        @can_view, @can_reply, @can_assign, @can_manage, CURRENT_TIMESTAMP
      )
    `);
    normalized.forEach((scope) => insert.run({ operator_id: id, ...scope }));
  });
  save();
  return listEditableOperatorScopes(db, id);
}

function normalizeAdminScope(scope = {}) {
  const platform = normalizePlatform(scope.platform);
  if (!ALLOWED_PLATFORMS.has(platform)) return null;
  const serviceAccount = String(scope.service_account || scope.account || '').trim();
  const nativeGroupId = String(scope.native_group_id || ALL_GROUPS).trim();
  if (!serviceAccount || !nativeGroupId) return null;
  return {
    platform,
    service_account: serviceAccount,
    native_group_id: nativeGroupId,
    can_view: boolToInt(scope.can_view ?? true),
    can_reply: boolToInt(scope.can_reply),
    can_assign: boolToInt(scope.can_assign),
    can_manage: boolToInt(scope.can_manage),
  };
}

function listEditableOperatorScopes(db, operatorId) {
  return db.prepare(`
    SELECT
      id, operator_id, platform, service_account, native_group_id,
      can_view, can_reply, can_assign, can_manage, created_at, updated_at
    FROM operator_service_group_scopes
    WHERE operator_id = ?
    ORDER BY platform ASC, service_account ASC, native_group_id ASC
  `).all(String(operatorId)).map((scope) => ({
    ...scope,
    can_view: Boolean(Number(scope.can_view)),
    can_reply: Boolean(Number(scope.can_reply)),
    can_assign: Boolean(Number(scope.can_assign)),
    can_manage: Boolean(Number(scope.can_manage)),
  }));
}

function listAdminServiceGroups(db) {
  return db.prepare(`
    SELECT
      id, platform, service_account, native_group_id, name, source,
      parent_native_group_id, group_level, is_manual, color, synced_at
    FROM service_groups
    ORDER BY platform ASC, service_account ASC, group_level ASC, name ASC
  `).all().map((group) => ({
    ...group,
    is_manual: Boolean(Number(group.is_manual)),
  }));
}

function listAdminServiceGroupsAcross(accountData, accountScope) {
  if (!accountData.isolated) {
    return listAdminServiceGroups(accountData.mapWorkbenchDbs({}, (db) => db)[0]);
  }
  return accountData.mapWorkbenchDbs({ accountScope }, listAdminServiceGroups)
    .flat()
    .sort((a, b) => (
      a.platform.localeCompare(b.platform) ||
      a.service_account.localeCompare(b.service_account) ||
      Number(a.group_level || 1) - Number(b.group_level || 1) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
    ));
}

function currentAdminId(req) {
  const operator = req.workbenchOperator || {};
  const user = req.user || {};
  return String(operator.id || user.id || user.username || 'admin');
}

function boolToInt(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()) || value === true ? 1 : 0;
}

function normalizeAdminOperatorRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['super_admin', 'admin', 'agent', 'viewer'].includes(normalized)) return normalized;
  return 'agent';
}

function normalizeAdminOperatorStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['active', 'disabled'].includes(normalized)) return normalized;
  return 'active';
}

function normalizeAdminDefaultEntry(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['workbench', 'admin', 'auto'].includes(normalized)) return normalized;
  return 'workbench';
}

function countLabels(db, platform, account) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM service_groups
    WHERE platform = ? AND service_account = ?
  `).get(platform, account);
  return row ? row.count : 0;
}

function countSyncedGroups(db, platform, account) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM channel_groups
    WHERE platform = ? AND account = ?
  `).get(platform, account);
  return row ? row.count : 0;
}

function lastChannelSyncAt(db, platform, account) {
  const row = db.prepare(`
    SELECT MAX(synced_at) AS synced_at
    FROM (
      SELECT synced_at FROM channel_groups WHERE platform = @platform AND account = @account
      UNION ALL
      SELECT synced_at FROM service_groups WHERE platform = @platform AND service_account = @account
    )
  `).get({ platform, account });
  return row ? row.synced_at : null;
}

function getServiceGroup(db, platform, account, nativeGroupId) {
  return db.prepare(`
    SELECT *
    FROM service_groups
    WHERE platform = @platform
      AND service_account = @account
      AND native_group_id = @nativeGroupId
  `).get({
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
    nativeGroupId: String(nativeGroupId || '').trim(),
  }) || null;
}

function isManualServiceGroup(group) {
  if (!group) return false;
  return Number(group.is_manual) === 1 || ['manual', 'manual_l1', 'manual_l2'].includes(String(group.source || ''));
}

function createManualGroupId() {
  return `manual:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeManualGroupName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw createHttpError(400, 'name is required');
  return name;
}

function normalizeManualGroupLevel(value) {
  const level = Number(value || 1);
  if (level === 1 || level === 2) return level;
  throw createHttpError(400, 'group level must be 1 or 2');
}

function normalizeManualGroupIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const ids = [];
  list.map((item) => String(item || '').trim()).filter(Boolean).forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  });
  return ids.slice(0, 50);
}

function normalizeColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '';
}

function defaultManualGroupColor(level) {
  return level === 2 ? '#2563eb' : '#7c3aed';
}

function loadManualServiceGroupsByIds(db, platform, account, nativeGroupIds) {
  const ids = normalizeManualGroupIds(nativeGroupIds);
  if (!ids.length) return [];
  const params = {
    platform: normalizePlatform(platform),
    account: String(account || '').trim(),
  };
  const placeholders = ids.map((id, index) => {
    const key = `nativeGroupId${index}`;
    params[key] = id;
    return `@${key}`;
  });
  return db.prepare(`
    SELECT *
    FROM service_groups
    WHERE platform = @platform
      AND service_account = @account
      AND native_group_id IN (${placeholders.join(', ')})
      AND (source IN ('manual', 'manual_l1', 'manual_l2') OR is_manual = 1)
  `).all(params);
}

function expandServiceGroupFilterIds(db, nativeGroupId) {
  const id = String(nativeGroupId || '').trim();
  if (!id) return [];
  const rows = db.prepare(`
    SELECT native_group_id
    FROM service_groups
    WHERE native_group_id = @id
       OR parent_native_group_id = @id
  `).all({ id });
  const ids = new Set([id]);
  rows.forEach((row) => {
    if (row.native_group_id) ids.add(String(row.native_group_id));
  });
  return [...ids];
}

function expandServiceGroupFilterIdsAcross(accountData, nativeGroupId, accountScope) {
  if (!accountData.isolated) {
    return expandServiceGroupFilterIds(accountData.mapWorkbenchDbs({}, (db) => db)[0], nativeGroupId);
  }
  const ids = new Set([String(nativeGroupId || '').trim()].filter(Boolean));
  accountData.mapWorkbenchDbs({ accountScope }, (db) => expandServiceGroupFilterIds(db, nativeGroupId))
    .flat()
    .forEach((id) => ids.add(String(id)));
  return [...ids];
}

function loadServiceGroupConversationTargetsAcross(accountData, nativeGroupId, accountScope) {
  const rows = accountData.mapWorkbenchDbs({ accountScope }, (db) => {
    const ids = expandServiceGroupFilterIds(db, nativeGroupId);
    if (!ids.length) return [];
    const params = {};
    const placeholders = ids.map((id, index) => {
      const key = `nativeGroupId${index}`;
      params[key] = id;
      return `@${key}`;
    });
    return db.prepare(`
      SELECT platform, service_account AS account, chat_id AS group_id
      FROM conversation_service_group_map
      WHERE native_group_id IN (${placeholders.join(', ')})
    `).all(params);
  }).flat().filter((row) => (
    row.group_id && accountScopeContains(accountScope, normalizePlatform(row.platform), row.account)
  ));
  const keys = new Set();
  const groupIdsByAccount = new Map();
  rows.forEach((row) => {
    const platform = normalizePlatform(row.platform);
    const account = String(row.account || '').trim();
    const groupId = String(row.group_id || '').trim();
    if (!platform || !account || !groupId) return;
    keys.add(groupKey(platform, account, groupId));
    const key = accountData.isolated ? accountKey(platform, account) : 'legacy';
    if (!groupIdsByAccount.has(key)) groupIdsByAccount.set(key, new Set());
    groupIdsByAccount.get(key).add(groupId);
  });
  return { keys, groupIdsByAccount };
}

function orderServiceGroups(groups) {
  const byId = new Map(groups.map((group) => [String(group.native_group_id), group]));
  return [...groups].sort((a, b) => {
    const aParent = a.parent_native_group_id ? byId.get(String(a.parent_native_group_id)) : null;
    const bParent = b.parent_native_group_id ? byId.get(String(b.parent_native_group_id)) : null;
    const aPath = `${a.platform}:${a.service_account}:${aParent ? aParent.name : a.name}:${Number(a.group_level || 1)}:${a.name}`;
    const bPath = `${b.platform}:${b.service_account}:${bParent ? bParent.name : b.name}:${Number(b.group_level || 1)}:${b.name}`;
    return aPath.localeCompare(bPath, 'zh-Hans-CN');
  });
}

function hasQueryValue(value) {
  if (Array.isArray(value)) return value.some((item) => hasQueryValue(item));
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function applyAllowedPlatformsSql(filters, params, column = 'platform', prefix = 'allowedPlatform') {
  const placeholders = WORKBENCH_PLATFORMS.map((platform, index) => {
    const key = `${prefix}${index}`;
    params[key] = platform;
    return `@${key}`;
  });
  filters.push(`${column} IN (${placeholders.join(', ')})`);
}

function applyWorkbenchPlatformFilter(filters, params, platformValue, column = 'platform') {
  const platform = normalizePlatform(platformValue);
  if (hasQueryValue(platformValue) && !ALLOWED_PLATFORMS.has(platform)) {
    filters.push('1 = 0');
    return '';
  }
  if (platform) {
    filters.push(`${column} = @platform`);
    params.platform = platform;
    return platform;
  }
  applyAllowedPlatformsSql(filters, params, column);
  return '';
}

function applyAccountScopeSql(filters, params, accountScope) {
  if (!accountScope || !accountScope.active) return;
  if (!accountScope.accounts.length) {
    filters.push('1 = 0');
    return;
  }
  const clauses = accountScope.accounts.map((entry, index) => {
    const platformKey = `scopePlatform${index}`;
    const accountKey = `scopeAccount${index}`;
    params[platformKey] = entry.platform;
    params[accountKey] = entry.account;
    return `(platform = @${platformKey} AND account = @${accountKey})`;
  });
  filters.push(`(${clauses.join(' OR ')})`);
}

function applyServiceAccountScopeSql(filters, params, accountScope) {
  if (!accountScope || !accountScope.active) return;
  if (!accountScope.accounts.length) {
    filters.push('1 = 0');
    return;
  }
  const clauses = accountScope.accounts.map((entry, index) => {
    const platformKey = `scopePlatform${index}`;
    const accountKey = `scopeAccount${index}`;
    params[platformKey] = entry.platform;
    params[accountKey] = entry.account;
    return `(platform = @${platformKey} AND service_account = @${accountKey})`;
  });
  filters.push(`(${clauses.join(' OR ')})`);
}

function resolveSelectedAccountScope(accountScope, accountValue) {
  const selectedScope = parseAccountScopeList(accountValue);
  if (!selectedScope.active) return accountScope;
  const accounts = selectedScope.accounts.filter((entry) => accountScopeContains(accountScope, entry.platform, entry.account));
  return {
    mode: 'selected',
    active: true,
    accounts,
  };
}

function requireVisibleAccount(accountScope, platform, account) {
  if (!accountScopeContains(accountScope, platform, account)) {
    throw createHttpError(403, 'account is not available in this Workbench session');
  }
}

function mapAccountScope(accountScope) {
  return {
    mode: accountScope && accountScope.mode || 'all',
    active: Boolean(accountScope && accountScope.active),
    accounts: accountScope && Array.isArray(accountScope.accounts) ? accountScope.accounts : [],
  };
}

function activeBreaker(db, platform, account) {
  return db.prepare(`
    SELECT *
    FROM send_circuit_breaker
    WHERE platform = @platform
      AND account = @account
      AND status = 'cooldown'
      AND (cooldown_until IS NULL OR cooldown_until > CURRENT_TIMESTAMP)
  `).get({ platform, account });
}

function writeAction(db, operatorId, actionType, platform, account, groupId, targetId, payload) {
  db.prepare(`
    INSERT INTO agent_actions (
      operator_id, action_type, platform, account, group_id, target_id, payload_json
    )
    VALUES (@operatorId, @actionType, @platform, @account, @groupId, @targetId, @payloadJson)
  `).run({
    operatorId,
    actionType,
    platform,
    account,
    groupId,
    targetId: targetId == null ? null : String(targetId),
    payloadJson: safeJson(payload || {}),
  });
}

function writeDoorbell(outboxDir, outbound) {
  const accountSegment = sanitizeSegment(outbound.account);
  const workerDir = path.join(outboxDir, `worker-${outbound.platform}-${accountSegment}`);
  fs.mkdirSync(workerDir, { recursive: true });
  const finalPath = path.join(workerDir, `${outbound.id}.json`);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    outbound_id: outbound.id,
    platform: outbound.platform,
    account: outbound.account,
    created_at: new Date().toISOString(),
  }, null, 2));
  fs.renameSync(tempPath, finalPath);
}

function publicOutboundId(row, accountData) {
  if (!accountData || !accountData.isolated) return row.id;
  return `${row.platform}:${row.account}:${row.id}`;
}

function parseOutboundRequestRef(req) {
  const raw = String(req.params.id || '').trim();
  const body = req.body || {};
  const query = req.query || {};
  if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length >= 3) {
      return {
        platform: normalizePlatform(parts.shift()),
        account: parts.shift(),
        id: parts.join(':'),
      };
    }
  }
  return {
    platform: body.platform ? normalizePlatform(body.platform) : (query.platform ? normalizePlatform(query.platform) : ''),
    account: String(body.account || query.account || '').trim(),
    id: raw,
  };
}

function withOutboundForRequest(accountData, req, fn) {
  const ref = parseOutboundRequestRef(req);
  return accountData.withOutboundDb(ref.id, {
    platform: ref.platform,
    account: ref.account,
  }, (db, outbound, context) => {
    if (context.ambiguous) {
      throw createHttpError(409, 'outbound id is ambiguous, include platform and account');
    }
    if (!outbound) throw createHttpError(404, 'outbound not found');
    if (!OUTBOUND_STATUSES.has(outbound.status)) throw createHttpError(500, 'invalid outbound status');
    return fn(db, outbound, context);
  });
}

function openGlobalEventSources({ accountData, runtimeDb, accountDataDir, visibleScope }) {
  if (!accountData.isolated) return [{ key: 'legacy', db: runtimeDb, owned: false }];
  return listAccountRefs({ accountDataDir })
    .filter((ref) => accountScopeContains(visibleScope, ref.platform, ref.account))
    .filter((ref) => fs.existsSync(ref.paths.runtimeDbPath))
    .map((ref) => {
      const db = new Database(ref.paths.runtimeDbPath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 3000');
      const hasEvents = Boolean(db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_events'
      `).get());
      if (!hasEvents) {
        db.close();
        return null;
      }
      return { key: `${ref.platform}:${ref.account}`, db, owned: true };
    })
    .filter(Boolean);
}

function encodeEventCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor || {})).toString('base64url');
}

function decodeEventCursor(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeGlobalEvent(res, event, payload, cursor) {
  res.write(`id: ${encodeEventCursor(cursor)}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

function getActiveGlobalSseClients() {
  return activeGlobalSseClients;
}

function sanitizeSegment(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function groupKey(platform, account, groupId) {
  return `${platform}:${account}:${groupId}`;
}

function accountKey(platform, account) {
  return `${platform}:${account}`;
}

function requirePlatform(value) {
  const platform = normalizePlatform(value);
  if (!ALLOWED_PLATFORMS.has(platform)) {
    throw createHttpError(400, 'platform must be one of wa, tg');
  }
  return platform;
}

function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw createHttpError(400, `${name} is required`);
  return text;
}

function getOutbound(db, id) {
  const outbound = db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(Number(id));
  if (!outbound) throw createHttpError(404, 'outbound not found');
  if (!OUTBOUND_STATUSES.has(outbound.status)) throw createHttpError(500, 'invalid outbound status');
  return outbound;
}

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = {
  createWorkbenchRouter,
  getActiveGlobalSseClients,
  writeDoorbell,
};
