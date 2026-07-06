const express = require('express');

function createAccessControlRouter(options = {}) {
    const router = express.Router();
    const workbenchDb = options.workbenchDb;
    const ensureOperator = options.ensureOperator;
    const accessControl = options.accessControl;
    const permissions = options.permissions;

    if (!workbenchDb || !ensureOperator || !accessControl || !permissions) {
        throw new Error('createAccessControlRouter requires workbenchDb, ensureOperator, accessControl and permissions');
    }

    router.use(permissions.requirePermission(workbenchDb, 'admin:access:manage'));

    router.get('/permissions', (req, res) => {
        res.json({ success: true, data: accessControl.listPermissions(workbenchDb) });
    });

    router.get('/roles', (req, res) => {
        res.json({ success: true, data: accessControl.listRoles(workbenchDb) });
    });

    router.post('/roles', (req, res) => {
        try {
            const role = accessControl.createRole(workbenchDb, req.body || {});
            res.json({ success: true, data: role });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.put('/roles/:code/permissions', (req, res) => {
        try {
            accessControl.setRolePermissions(workbenchDb, req.params.code, req.body?.permissions || []);
            const role = accessControl.listRoles(workbenchDb).find((item) => item.code === req.params.code);
            res.json({ success: true, data: role || null });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.get('/operators', (req, res) => {
        const search = String(req.query.search || '').trim();
        const params = {
            search: `%${search}%`,
            limit: Math.max(1, Math.min(Number(req.query.limit) || 100, 300))
        };
        const where = search
            ? `WHERE id LIKE @search OR username LIKE @search OR display_name LIKE @search`
            : '';
        const rows = workbenchDb.prepare(`
            SELECT id, username, display_name, role, status, updated_at
            FROM operators
            ${where}
            ORDER BY updated_at DESC, id ASC
            LIMIT @limit
        `).all(params);
        res.json({
            success: true,
            data: rows.map((row) => operatorPayload(row.id))
        });
    });

    router.get('/operators/:operatorId', (req, res) => {
        const operatorId = String(req.params.operatorId || '').trim();
        const row = workbenchDb.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId);
        if (!row) return res.status(404).json({ success: false, error: 'operator not found' });
        res.json({ success: true, data: operatorPayload(operatorId) });
    });

    router.put('/operators/:operatorId', (req, res) => {
        const operatorId = String(req.params.operatorId || '').trim();
        const displayName = String(req.body?.display_name || req.body?.displayName || req.body?.username || operatorId).trim();
        if (!operatorId) return res.status(400).json({ success: false, error: 'operator_id is required' });
        try {
            ensureOperator(workbenchDb, operatorId, displayName || operatorId);
            const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
            accessControl.setOperatorRoles(workbenchDb, operatorId, roles, req.user?.username || 'admin');
            if (req.body?.portal_access || req.body?.portalAccess) {
                upsertPortalAccess(operatorId, normalizePortalAccess(req.body.portal_access || req.body.portalAccess));
            }
            res.json({ success: true, data: operatorPayload(operatorId) });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    function operatorPayload(operatorId) {
        const stored = workbenchDb.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId) || {
            id: operatorId,
            username: operatorId,
            display_name: operatorId,
            role: 'agent',
            status: 'active'
        };
        const operator = {
            id: stored.id,
            username: stored.username,
            display_name: stored.display_name,
            role: stored.role,
            status: stored.status,
            identities: [stored.id, stored.username, stored.display_name].filter(Boolean)
        };
        const roleCodes = permissions.operatorRoleCodes(workbenchDb, operator);
        return {
            operator,
            roles: roleCodes,
            permissions: [...permissions.operatorPermissionSet(workbenchDb, operator)].sort(),
            portal_access: permissions.loadPortalAccess(workbenchDb, operator)
        };
    }

    function upsertPortalAccess(operatorId, access) {
        workbenchDb.prepare(`
            INSERT INTO operator_portal_access (
                operator_id, can_monitor, can_workbench, can_admin, default_entry, updated_at
            )
            VALUES (
                @operatorId, @canMonitor, @canWorkbench, @canAdmin, @defaultEntry, CURRENT_TIMESTAMP
            )
            ON CONFLICT(operator_id) DO UPDATE SET
                can_monitor = excluded.can_monitor,
                can_workbench = excluded.can_workbench,
                can_admin = excluded.can_admin,
                default_entry = excluded.default_entry,
                updated_at = CURRENT_TIMESTAMP
        `).run({
            operatorId,
            canMonitor: access.can_monitor,
            canWorkbench: access.can_workbench,
            canAdmin: access.can_admin,
            defaultEntry: access.default_entry
        });
    }

    return router;
}

function normalizePortalAccess(access = {}) {
    const defaultEntry = String(access.default_entry || access.defaultEntry || 'auto').trim().toLowerCase();
    return {
        can_monitor: truthy(access.can_monitor ?? access.canMonitor) ? 1 : 0,
        can_workbench: truthy(access.can_workbench ?? access.canWorkbench) ? 1 : 0,
        can_admin: truthy(access.can_admin ?? access.canAdmin) ? 1 : 0,
        default_entry: ['auto', 'monitor', 'workbench', 'admin', 'chooser'].includes(defaultEntry) ? defaultEntry : 'auto'
    };
}

function truthy(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

module.exports = createAccessControlRouter;
