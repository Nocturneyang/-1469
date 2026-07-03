const express = require('express');
const fs = require('fs');
const path = require('path');

function resolveWorkbenchRoot() {
    const candidates = [
        process.env.WORKBENCH_ROOT,
        path.resolve(__dirname, '..', '..', 'workbench'),
        path.resolve(__dirname, '..', '..', '..', 'workbench')
    ].filter(Boolean);

    return candidates.find((candidate) =>
        fs.existsSync(path.join(candidate, 'db', 'workbench-db.js'))
    ) || candidates[0];
}

const WORKBENCH_ROOT = resolveWorkbenchRoot();

const {
    DEFAULT_WORKBENCH_DB_PATH,
    ensureOperator,
    openWorkbenchDb
} = require(path.join(WORKBENCH_ROOT, 'db', 'workbench-db'));
const {
    DEFAULT_RAW_DB_PATH,
    listAccountProfiles,
    resolveAccountScope
} = require(path.join(WORKBENCH_ROOT, 'db', 'raw-messages'));
const {
    ALL_GROUPS,
    UNGROUPED_GROUP,
    loadPortalAccess,
    requireWorkbenchSuperAdmin,
    resolveWorkbenchOperator
} = require(path.join(WORKBENCH_ROOT, 'lib', 'permissions'));

function createWorkbenchPermissionsRouter(options = {}) {
    const router = express.Router();
    const workbenchDb = options.workbenchDb || openWorkbenchDb(options.workbenchDbPath || DEFAULT_WORKBENCH_DB_PATH);
    const rawDbPath = options.rawDbPath || DEFAULT_RAW_DB_PATH;

    router.get('/me', (req, res) => {
        const operator = resolveWorkbenchOperator(workbenchDb, req);
        res.json({
            success: true,
            data: {
                operator: mapOperator(operator),
                is_super_admin: operator.is_super_admin,
                portal_access: loadPortalAccess(workbenchDb, operator)
            }
        });
    });

    router.use(requireWorkbenchSuperAdmin(workbenchDb));

    router.get('/operators', (req, res) => {
        const search = String(req.query.search || '').trim();
        const params = {
            search: `%${search}%`,
            limit: Math.max(1, Math.min(Number(req.query.limit) || 100, 300))
        };
        const where = search
            ? `WHERE o.id LIKE @search OR o.username LIKE @search OR o.display_name LIKE @search`
            : '';
        const operators = workbenchDb.prepare(`
            SELECT
                o.id,
                o.username,
                o.display_name,
                o.role,
                o.status,
                o.updated_at,
                COUNT(s.id) AS scope_count
            FROM operators o
            LEFT JOIN operator_service_group_scopes s
              ON s.operator_id = o.id
            ${where}
            GROUP BY o.id
            ORDER BY o.updated_at DESC, o.id ASC
            LIMIT @limit
        `).all(params);
        res.json({ success: true, data: operators });
    });

    router.get('/scopes', (req, res) => {
        const operatorId = String(req.query.operator_id || '').trim();
        const operator = operatorId
            ? workbenchDb.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId) || null
            : null;
        res.json({
            success: true,
            data: {
                operator,
                portal_access: operatorId ? loadStoredPortalAccess(workbenchDb, operatorId) : null,
                service_accounts: listServiceAccounts(rawDbPath),
                service_groups: listServiceGroups(workbenchDb, rawDbPath),
                scopes: operatorId ? listScopes(workbenchDb, operatorId) : []
            }
        });
    });

    router.put('/scopes', (req, res) => {
        const body = req.body || {};
        const operatorId = String(body.operator_id || body.operator?.id || '').trim();
        if (!operatorId) {
            return res.status(400).json({ success: false, error: 'operator_id is required' });
        }

        const operatorName = String(body.operator_name || body.operator?.display_name || body.operator?.username || operatorId).trim();
        const portalAccess = normalizePortalAccess(body.portal_access || body.portalAccess || {});
        const serviceAccountSet = new Set(listServiceAccounts(rawDbPath).map((account) => accountKey(account.platform, account.account)));
        const scopes = Array.isArray(body.scopes) ? body.scopes : [];
        const normalizedScopes = scopes
            .map((scope) => normalizeScope(scope, operatorId))
            .filter((scope) => scope.operator_id && serviceAccountSet.has(accountKey(scope.platform, scope.service_account)))
            .filter((scope) => scope.native_group_id)
            .filter((scope) => scope.can_view || scope.can_reply || scope.can_assign || scope.can_manage);

        const save = workbenchDb.transaction(() => {
            ensureOperator(workbenchDb, operatorId, operatorName || operatorId);
            upsertPortalAccess(workbenchDb, operatorId, portalAccess);
            workbenchDb.prepare('DELETE FROM operator_service_group_scopes WHERE operator_id = ?').run(operatorId);
            const insert = workbenchDb.prepare(`
                INSERT INTO operator_service_group_scopes (
                    operator_id, platform, service_account, native_group_id,
                    can_view, can_reply, can_assign, can_manage, updated_at
                )
                VALUES (
                    @operator_id, @platform, @service_account, @native_group_id,
                    @can_view, @can_reply, @can_assign, @can_manage, CURRENT_TIMESTAMP
                )
            `);
            normalizedScopes.forEach((scope) => insert.run(scope));
            return listScopes(workbenchDb, operatorId);
        });

        res.json({
            success: true,
            data: {
                operator: workbenchDb.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId),
                portal_access: loadStoredPortalAccess(workbenchDb, operatorId),
                scopes: save()
            }
        });
    });

    router.delete('/scopes/:id', (req, res) => {
        const result = workbenchDb.prepare('DELETE FROM operator_service_group_scopes WHERE id = ?').run(req.params.id);
        res.json({ success: true, data: { deleted: result.changes } });
    });

    return router;
}

function listServiceAccounts(rawDbPath) {
    const accountScope = resolveAccountScope({ rawDbPath, filterLoggedIn: false });
    return listAccountProfiles({ rawDbPath, accountScope })
        .filter((account) => {
            const role = String(account.account_role || '').toLowerCase();
            return role === 'service' || role === 'both';
        })
        .map((account) => ({
            platform: account.platform,
            account: account.account,
            display_name: account.display_name || account.account,
            account_role: account.account_role,
            status: account.status,
            send_enabled: Number(account.send_enabled) === 1,
            sync_groups_enabled: Number(account.sync_groups_enabled) === 1,
            risk_level: account.risk_level || 'low'
        }));
}

function listServiceGroups(db, rawDbPath) {
    const serviceAccounts = listServiceAccounts(rawDbPath);
    const accountSet = new Set(serviceAccounts.map((account) => accountKey(account.platform, account.account)));
    const groups = db.prepare(`
        SELECT
            id,
            platform,
            service_account,
            native_group_id,
            name,
            source,
            color,
            synced_at
        FROM service_groups
        ORDER BY platform ASC, service_account ASC, source ASC, name ASC
    `).all().filter((group) => accountSet.has(accountKey(group.platform, group.service_account)));

    const virtualGroups = serviceAccounts.flatMap((account) => [
        {
            id: `${account.platform}:${account.account}:${ALL_GROUPS}`,
            platform: account.platform,
            service_account: account.account,
            native_group_id: ALL_GROUPS,
            name: '全部分组',
            source: 'system',
            color: '#0f766e',
            virtual: true
        },
        {
            id: `${account.platform}:${account.account}:${UNGROUPED_GROUP}`,
            platform: account.platform,
            service_account: account.account,
            native_group_id: UNGROUPED_GROUP,
            name: '未分组会话',
            source: 'system',
            color: '#64748b',
            virtual: true
        }
    ]);

    return [...virtualGroups, ...groups];
}

function listScopes(db, operatorId) {
    return db.prepare(`
        SELECT *
        FROM operator_service_group_scopes
        WHERE operator_id = ?
        ORDER BY platform ASC, service_account ASC, native_group_id ASC
    `).all(operatorId);
}

function loadStoredPortalAccess(db, operatorId) {
    const row = db.prepare(`
        SELECT *
        FROM operator_portal_access
        WHERE operator_id = ?
    `).get(operatorId);
    if (!row) {
        return {
            operator_id: operatorId,
            can_monitor: 0,
            can_workbench: 0,
            default_entry: 'auto'
        };
    }
    return row;
}

function upsertPortalAccess(db, operatorId, access) {
    db.prepare(`
        INSERT INTO operator_portal_access (
            operator_id, can_monitor, can_workbench, default_entry, updated_at
        )
        VALUES (
            @operatorId, @canMonitor, @canWorkbench, @defaultEntry, CURRENT_TIMESTAMP
        )
        ON CONFLICT(operator_id) DO UPDATE SET
            can_monitor = excluded.can_monitor,
            can_workbench = excluded.can_workbench,
            default_entry = excluded.default_entry,
            updated_at = CURRENT_TIMESTAMP
    `).run({
        operatorId,
        canMonitor: access.can_monitor,
        canWorkbench: access.can_workbench,
        defaultEntry: access.default_entry
    });
}

function normalizePortalAccess(access) {
    const defaultEntry = String(access.default_entry || access.defaultEntry || 'auto').trim().toLowerCase();
    return {
        can_monitor: truthy(access.can_monitor ?? access.canMonitor) ? 1 : 0,
        can_workbench: truthy(access.can_workbench ?? access.canWorkbench) ? 1 : 0,
        default_entry: ['auto', 'monitor', 'workbench', 'chooser'].includes(defaultEntry) ? defaultEntry : 'auto'
    };
}

function normalizeScope(scope, operatorId) {
    const targetOperatorId = String(operatorId || scope.operator_id || '').trim();
    return {
        operator_id: targetOperatorId,
        platform: String(scope.platform || '').trim().toLowerCase(),
        service_account: String(scope.service_account || '').trim(),
        native_group_id: String(scope.native_group_id || '').trim(),
        can_view: truthy(scope.can_view) ? 1 : 0,
        can_reply: truthy(scope.can_reply) ? 1 : 0,
        can_assign: truthy(scope.can_assign) ? 1 : 0,
        can_manage: truthy(scope.can_manage) ? 1 : 0
    };
}

function truthy(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function accountKey(platform, account) {
    return `${String(platform || '').trim().toLowerCase()}:${String(account || '').trim()}`;
}

function mapOperator(operator) {
    return {
        id: operator.id,
        username: operator.username,
        display_name: operator.display_name,
        role: operator.role,
        status: operator.status,
        is_super_admin: Boolean(operator.is_super_admin)
    };
}

module.exports = createWorkbenchPermissionsRouter;
