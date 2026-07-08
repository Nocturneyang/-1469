const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
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
const { ensureOperator, parseJson, safeJson } = require('../../db/workbench-db');
const {
  ALL_GROUPS,
  UNGROUPED_GROUP,
  allowedAccountScope,
  capabilitySummary,
  filterGroupsByCapability,
  loadPortalAccess,
  requireAdminPortalAccess,
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

const ALLOWED_PLATFORMS = new Set(WORKBENCH_PLATFORMS);
const OUTBOUND_STATUSES = new Set(['pending', 'sending', 'sent', 'delivered', 'failed', 'dead', 'paused', 'canceled']);
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const ALLOWED_ATTACHMENT_KINDS = new Set(['file', 'image', 'sticker']);

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
    const accounts = accountData.listAccounts({ accountScope: visibleAccountScope }).map((account) => ({
      ...account,
      ...accountChannelStats(accountData, workbenchDb, account.platform, account.account),
    }));
    res.json({ ok: true, accounts, account_scope: mapAccountScope(visibleAccountScope) });
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
    const request = accountData.deleteLoginRequest(req.params.id, { outboxDir: doorbellRoot });
    if (!request) throw createHttpError(404, 'login request not found');
    accountData.withWorkbenchDb(request.platform, request.account, { create: true }, (accountDb) => writeAction(
      accountDb,
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
      },
    ));
    res.json({ ok: true, request });
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
    const labelId = req.query.label_id ? String(req.query.label_id) : '';
    const labelIds = labelId ? new Set(expandServiceGroupFilterIdsAcross(accountData, labelId, selectedAccountScope)) : new Set();
    const rawGroups = accountData.listGroups({
      platforms,
      accountScope: selectedAccountScope,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    const syncedGroups = listSyncedGroupsAcross(accountData, {
      platforms,
      accountScope: selectedAccountScope,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    const enriched = filterGroupsByCapability(
      workbenchDb,
      operator,
      enrichGroupsWithAccountData(accountData, workbenchDb, rawDbPath, mergeGroupSources(rawGroups, syncedGroups), operatorId, selectedAccountScope),
      'can_view',
    )
      .filter((group) => {
        if (scope === 'mine') return group.assignment && group.assignment.assigned_to === operatorId;
        if (scope === 'unread') return group.unread_count > 0;
        return true;
      })
      .filter((group) => {
        if (!labelIds.size) return true;
        return group.labels.some((label) => (
          labelIds.has(String(label.native_label_id)) ||
          labelIds.has(String(label.native_group_id)) ||
          labelIds.has(String(label.id))
        ));
      });
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
    const accountScope = getAccountScope();
    const operator = currentOperatorContext(workbenchDb, req);
    const visibleAccountScope = allowedAccountScope(workbenchDb, operator, accountScope, 'can_view');
    const platform = requirePlatform(req.query.platform);
    const account = requireText(req.query.account, 'account');
    requireVisibleAccount(visibleAccountScope, platform, account);
    const groupId = req.params.groupId;
    requireConversationCapability(workbenchDb, operator, platform, account, groupId, 'can_view');
    const page = accountData.listMessagesPage({
      platform,
      account,
      accountScope: visibleAccountScope,
      groupId,
      beforeId: req.query.before_id,
      limit: req.query.limit,
    });
    const inbound = page.messages.map(mapRawMessage);
    const outbound = accountData.withWorkbenchDb(platform, account, {}, (accountDb) => listOutboundMessages(accountDb, {
      platform,
      account,
      groupId,
      scopedIds: accountData.isolated,
    }));
    const messages = applyMentionDisplayNames(mergeConversationMessages(inbound, outbound));
    res.json({ ok: true, messages, paging: page.paging });
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
    const attachmentJson = attachments.length ? safeJson(attachments) : null;
    if (!text && !attachmentJson) {
      throw createHttpError(400, 'text or attachment is required');
    }
    const result = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const breaker = activeBreaker(accountDb, platform, account);
      const desiredStatus = breaker ? 'paused' : 'pending';
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
        writeAction(accountDb, operatorId, 'reply.create', platform, account, groupId, outbound.id, {
          status: outbound.status,
          has_attachment: Boolean(attachmentJson),
        });
        if (outbound.status === 'pending') writeDoorbell(doorbellRoot, outbound);
      }
      return { insert, outbound, breaker };
    });
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
    });
    const unreadCount = Math.min(accountData.countUnread({
      platform,
      account,
      accountScope: visibleAccountScope,
      groupId,
      lastReadMessageId,
    }), 99);
    res.json({ ok: true, unread_count: unreadCount });
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
    ensureOperator(workbenchDb, assignedTo, body.assigned_to_name || assignedTo);
    const assignment = accountData.withWorkbenchDb(platform, account, { create: true }, (accountDb) => {
      const tx = accountDb.transaction(() => {
        accountDb.prepare(`
          UPDATE group_assignments
          SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
        `).run({ platform, account, groupId });
        const result = accountDb.prepare(`
          INSERT INTO group_assignments (platform, account, group_id, assigned_to, assigned_by)
          VALUES (@platform, @account, @groupId, @assignedTo, @assignedBy)
        `).run({ platform, account, groupId, assignedTo, assignedBy: operatorId });
        writeAction(accountDb, operatorId, 'conversation.assign', platform, account, groupId, result.lastInsertRowid, {
          assigned_to: assignedTo,
        });
        return result.lastInsertRowid;
      });
      const id = tx();
      return accountDb.prepare('SELECT * FROM group_assignments WHERE id = ?').get(id);
    });
    res.status(201).json({ ok: true, assignment });
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
      const result = accountDb.prepare(`
        UPDATE group_assignments
        SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE platform = @platform AND account = @account AND group_id = @groupId AND status = 'active'
      `).run({ platform, account, groupId });
      writeAction(accountDb, operatorId, 'conversation.release', platform, account, groupId, groupId, {
        released: result.changes,
      });
      return result.changes;
    });
    res.json({ ok: true, released });
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
      return getOutbound(accountDb, row.id);
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
        retryCount: Number(previous.retry_count || 0) + 1,
      });
      const next = getOutbound(accountDb, result.lastInsertRowid);
      writeAction(accountDb, operatorId, 'outbound.retry', next.platform, next.account, next.group_id, next.id, {
        retry_of: previous.id,
      });
      if (next.status === 'pending') writeDoorbell(doorbellRoot, next);
      return next;
    });
    res.status(201).json({ ok: true, outbound: mapOutboundRow(outbound, { scopedIds: accountData.isolated }) });
  });

  router.use((err, req, res, next) => {
    if (!err) return next();
    const status = err.statusCode || err.status || 500;
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
  return mapEnrichedGroups(groups, accountProfiles, assignments, labels, unreadCounts);
}

function enrichGroups(workbenchDb, rawDbPath, groups, operatorId, accountScope) {
  const assignments = loadActiveAssignments(workbenchDb);
  const reads = loadReads(workbenchDb, operatorId);
  const labels = loadLabelMap(workbenchDb);
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
  return mapEnrichedGroups(groups, accountProfiles, assignments, labels, unreadCounts);
}

function mapEnrichedGroups(groups, accountProfiles, assignments, labels, unreadCounts) {
  return groups.map((group) => {
    const key = groupKey(group.platform, group.account, group.group_id);
    const profile = accountProfiles.get(accountKey(group.platform, group.account));
    const unreadCount = Math.min(Number(unreadCounts.get(key) || 0), 99);
    return {
      id: key,
      platform: group.platform,
      account: group.account,
      account_display_name: profile && profile.display_name ? profile.display_name : group.account,
      account_role: profile && profile.account_role ? profile.account_role : 'service',
      account_status: profile && profile.status ? profile.status : null,
      send_enabled: profile ? Boolean(profile.send_enabled) : true,
      sync_groups_enabled: profile ? Boolean(profile.sync_groups_enabled) : false,
      risk_level: profile && profile.risk_level ? profile.risk_level : 'low',
      group_id: group.group_id,
      group_name: group.group_name,
      last_message_id: group.id,
      last_message_time: group.id ? normalizeTimestamp(group.timestamp, group.created_at) : null,
      last_sender_name: group.sender_name,
      last_content: group.content,
      has_media: Boolean(group.has_media),
      message_count: group.message_count,
      unread_count: unreadCount,
      assignment: assignments.get(key) || null,
      labels: labels.get(key) || [],
    };
  });
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
  limit = 200,
  offset = 0,
} = {}) {
  if (!accountData.isolated) {
    return listSyncedGroups(accountData.mapWorkbenchDbs({}, (db) => db)[0], {
      platforms,
      accountScope,
      search,
      limit,
      offset,
    });
  }
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  const rows = accountData.mapWorkbenchDbs({ platforms, accountScope }, (db) => listSyncedGroups(db, {
    platforms,
    accountScope,
    search,
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
      error_code: outbound.error_code,
      error_message: outbound.error_message,
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

function mapRawMessage(row) {
  const timestamp = normalizeTimestamp(row.timestamp, row.created_at);
  const direction = inferDirection(row);
  const text = row.content;
  return {
    id: `raw-${row.id}`,
    raw_id: row.id,
    platform: row.platform,
    account: row.account,
    group_id: row.group_id,
    message_id: row.message_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    direction,
    text,
    display_text: text,
    has_media: Boolean(row.has_media),
    media_path: row.media_path,
    status: direction === 'outbound' ? 'sent' : 'received',
    created_at: row.created_at,
    timestamp,
    sort_time: timestamp,
    source: 'raw',
  };
}

function mapOutboundRow(row, { scopedIds = false } = {}) {
  const timestamp = normalizeTimestamp(null, row.sent_at || row.created_at);
  const text = row.text;
  const outboundId = scopedIds ? publicOutboundId(row, { isolated: true }) : row.id;
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
    attachments: parseJson(row.attachment_json, []),
    status: row.status,
    remote_msg_id: row.remote_msg_id,
    retry_of: row.retry_of,
    retry_count: row.retry_count,
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
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
  return accountData.withWorkbenchDb(platform, account, {}, (accountDb) => ({
    label_count: countLabels(accountDb, platform, account),
    synced_group_count: countSyncedGroups(accountDb, platform, account),
    last_channel_sync_at: lastChannelSyncAt(accountDb, platform, account),
  }));
}

function listAdminOperators(db) {
  return db.prepare(`
    SELECT id, username, display_name, role, status, created_at, updated_at
    FROM operators
    ORDER BY
      CASE WHEN id = '1469' THEN 0 ELSE 1 END,
      updated_at DESC,
      id ASC
  `).all();
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
  if (id === '1469') throw createHttpError(400, 'super admin cannot be deleted');
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
    accountData.mapWorkbenchDbs({}, releaseAssignments);
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
    is_super_admin: Boolean(loadPortalAccess(db, operatorContext).can_admin && String(operator.id) === '1469'),
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
  writeDoorbell,
};
