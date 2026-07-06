const fs = require('fs');
const path = require('path');
const { openWorkbenchDb } = require('../db/workbench-db');

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function syncRequestDir(outboxDir, platform, account) {
  return path.join(outboxDir, `sync-worker-${platform}-${sanitizeSegment(account)}`);
}

function writeChannelSyncRequest(outboxDir, {
  platform,
  account,
  requestedBy = 'system',
  reason = 'manual',
} = {}) {
  if (!platform) throw new Error('platform is required');
  if (!account) throw new Error('account is required');
  const dir = syncRequestDir(outboxDir, platform, account);
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const payload = {
    platform,
    account,
    requested_by: requestedBy,
    reason,
    requested_at: new Date(ts).toISOString(),
  };
  const filePath = path.join(dir, `${ts}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return { ...payload, request_path: filePath };
}

function readAndClearChannelSyncRequests(outboxDir, platform, account) {
  const dir = syncRequestDir(outboxDir, platform, account);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const requests = [];
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    try {
      requests.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (err) {
      requests.push({ platform, account, reason: 'unreadable', error: err.message });
    }
    try {
      fs.unlinkSync(filePath);
    } catch (_) { }
  });
  return requests;
}

function replaceChannelSnapshot({
  db,
  dbPath,
  platform,
  account,
  groups = [],
  labels,
  maps,
} = {}) {
  if (!platform) throw new Error('platform is required');
  if (!account) throw new Error('account is required');
  const ownedDb = db ? null : openWorkbenchDb(dbPath);
  const workbenchDb = db || ownedDb;
  try {
    return workbenchDb.transaction(() => {
      const now = new Date().toISOString();
      const normalizedGroups = normalizeGroups(groups, platform, account);
      const shouldSyncLabels = Array.isArray(labels);
      const normalizedLabels = shouldSyncLabels ? normalizeLabels(labels, platform, account) : [];
      const normalizedMaps = shouldSyncLabels ? normalizeMaps(maps || [], platform, account, normalizedGroups, normalizedLabels) : [];
      const serviceGroups = buildServiceGroups(platform, account, normalizedGroups, normalizedLabels, shouldSyncLabels);
      const serviceMaps = buildServiceGroupMaps(platform, account, normalizedGroups, normalizedMaps, serviceGroups, shouldSyncLabels);
      const shouldSyncServiceGroups = shouldSyncLabels || platform === 'tg';

      const groupIds = new Set(normalizedGroups.map((group) => group.group_id));
      const labelIds = new Set(normalizedLabels.map((label) => label.native_label_id));
      const serviceGroupIds = new Set(serviceGroups.map((group) => group.native_group_id));

      deleteMissing(
        workbenchDb,
        'channel_groups',
        'group_id',
        { platform, account },
        groupIds,
      );
      if (shouldSyncLabels) {
        workbenchDb.prepare(`
          DELETE FROM conversation_label_map
          WHERE platform = @platform AND account = @account
        `).run({ platform, account });
      }
      if (shouldSyncLabels) {
        deleteMissing(
          workbenchDb,
          'channel_labels',
          'native_label_id',
          { platform, account },
          labelIds,
        );
      }
      if (shouldSyncServiceGroups) {
        workbenchDb.prepare(`
          DELETE FROM conversation_service_group_map
          WHERE platform = @platform AND service_account = @account
            AND native_group_id NOT IN (
              SELECT native_group_id
              FROM service_groups
              WHERE platform = @platform
                AND service_account = @account
                AND source IN ('manual', 'manual_l1', 'manual_l2')
            )
        `).run({ platform, account });
        deleteMissing(
          workbenchDb,
          'service_groups',
          'native_group_id',
          { platform, accountColumn: 'service_account', account },
          serviceGroupIds,
          { extraWhere: "(source IS NULL OR source NOT IN ('manual', 'manual_l1', 'manual_l2'))" },
        );
      }

      const groupStmt = workbenchDb.prepare(`
        INSERT INTO channel_groups (platform, account, group_id, group_name, kind, raw_json, synced_at)
        VALUES (@platform, @account, @groupId, @groupName, @kind, @rawJson, @syncedAt)
        ON CONFLICT(platform, account, group_id) DO UPDATE SET
          group_name = excluded.group_name,
          kind = excluded.kind,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at,
          updated_at = CURRENT_TIMESTAMP
      `);
      normalizedGroups.forEach((group) => groupStmt.run({
        platform,
        account,
        groupId: group.group_id,
        groupName: group.group_name,
        kind: group.kind,
        rawJson: safeJson(group.raw_json || group.raw || null),
        syncedAt: now,
      }));

      const labelStmt = workbenchDb.prepare(`
        INSERT INTO channel_labels (platform, account, native_label_id, name, color, kind, raw_json, synced_at)
        VALUES (@platform, @account, @nativeLabelId, @name, @color, @kind, @rawJson, @syncedAt)
        ON CONFLICT(platform, account, native_label_id) DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          kind = excluded.kind,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at,
          updated_at = CURRENT_TIMESTAMP
      `);
      normalizedLabels.forEach((label) => labelStmt.run({
        platform,
        account,
        nativeLabelId: label.native_label_id,
        name: label.name,
        color: label.color || null,
        kind: label.kind,
        rawJson: safeJson(label.raw_json || label.raw || null),
        syncedAt: now,
      }));

      const mapStmt = workbenchDb.prepare(`
        INSERT INTO conversation_label_map (platform, account, group_id, native_label_id, synced_at)
        VALUES (@platform, @account, @groupId, @nativeLabelId, @syncedAt)
        ON CONFLICT(platform, account, group_id, native_label_id) DO UPDATE SET
          synced_at = excluded.synced_at,
          updated_at = CURRENT_TIMESTAMP
      `);
      normalizedMaps.forEach((map) => mapStmt.run({
        platform,
        account,
        groupId: map.group_id,
        nativeLabelId: map.native_label_id,
        syncedAt: now,
      }));

      const serviceGroupStmt = workbenchDb.prepare(`
        INSERT INTO service_groups (
          platform, service_account, native_group_id, name, source,
          parent_native_group_id, group_level, is_manual,
          color, raw_json, synced_at
        )
        VALUES (
          @platform, @account, @nativeGroupId, @name, @source,
          NULL, 1, 0,
          @color, @rawJson, @syncedAt
        )
        ON CONFLICT(platform, service_account, native_group_id) DO UPDATE SET
          name = excluded.name,
          source = excluded.source,
          parent_native_group_id = excluded.parent_native_group_id,
          group_level = excluded.group_level,
          is_manual = excluded.is_manual,
          color = excluded.color,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at,
          updated_at = CURRENT_TIMESTAMP
      `);
      if (shouldSyncServiceGroups) {
        serviceGroups.forEach((group) => serviceGroupStmt.run({
          platform,
          account,
          nativeGroupId: group.native_group_id,
          name: group.name,
          source: group.source,
          color: group.color || null,
          rawJson: safeJson(group.raw_json || null),
          syncedAt: now,
        }));
      }

      const serviceMapStmt = workbenchDb.prepare(`
        INSERT INTO conversation_service_group_map (
          platform, service_account, chat_id, native_group_id, synced_at
        )
        VALUES (
          @platform, @account, @chatId, @nativeGroupId, @syncedAt
        )
        ON CONFLICT(platform, service_account, chat_id, native_group_id) DO UPDATE SET
          synced_at = excluded.synced_at,
          updated_at = CURRENT_TIMESTAMP
      `);
      if (shouldSyncServiceGroups) {
        serviceMaps.forEach((map) => serviceMapStmt.run({
          platform,
          account,
          chatId: map.chat_id,
          nativeGroupId: map.native_group_id,
          syncedAt: now,
        }));
      }

      return {
        synced_at: now,
        group_count: normalizedGroups.length,
        label_count: serviceGroups.length,
        map_count: serviceMaps.length,
      };
    })();
  } finally {
    if (ownedDb) ownedDb.close();
  }
}

function deleteMissing(db, table, field, { platform, account, accountColumn = 'account' }, keepSet, options = {}) {
  const extraWhere = options.extraWhere ? `AND ${options.extraWhere}` : '';
  const rows = db.prepare(`
    SELECT ${field} AS value
    FROM ${table}
    WHERE platform = @platform AND ${accountColumn} = @account
      ${extraWhere}
  `).all({ platform, account });
  const deleteStmt = db.prepare(`
    DELETE FROM ${table}
    WHERE platform = @platform AND ${accountColumn} = @account AND ${field} = @value
      ${extraWhere}
  `);
  rows.forEach((row) => {
    if (!keepSet.has(String(row.value))) deleteStmt.run({ platform, account, value: row.value });
  });
}

function buildServiceGroups(platform, account, groups, labels, shouldSyncLabels) {
  if (shouldSyncLabels) {
    const source = platform === 'wa' ? 'wa_label' : 'manual';
    return labels.map((label) => ({
      platform,
      account,
      native_group_id: label.native_label_id,
      name: label.name,
      source,
      color: label.color,
      raw_json: label.raw_json || label.raw || label,
    }));
  }
  if (platform === 'tg') {
    return groups.map((group) => ({
      platform,
      account,
      native_group_id: group.group_id,
      name: group.group_name,
      source: 'tg_group',
      color: null,
      raw_json: group.raw_json || group.raw || group,
    }));
  }
  return [];
}

function buildServiceGroupMaps(platform, account, groups, labelMaps, serviceGroups, shouldSyncLabels) {
  const serviceGroupIds = new Set(serviceGroups.map((group) => group.native_group_id));
  if (shouldSyncLabels) {
    return labelMaps
      .filter((map) => serviceGroupIds.has(map.native_label_id))
      .map((map) => ({
        platform,
        account,
        chat_id: map.group_id,
        native_group_id: map.native_label_id,
      }));
  }
  if (platform === 'tg') {
    return groups.map((group) => ({
      platform,
      account,
      chat_id: group.group_id,
      native_group_id: group.group_id,
    }));
  }
  return [];
}

function normalizeGroups(groups, platform, account) {
  const seen = new Set();
  return (groups || [])
    .map((group) => ({
      platform,
      account,
      group_id: String(group.group_id || group.id || group.chat_id || '').trim(),
      group_name: String(group.group_name || group.name || group.title || group.id || '').trim(),
      kind: String(group.kind || 'group').trim() || 'group',
      raw_json: group.raw_json || group.raw || group,
    }))
    .filter((group) => group.group_id && group.group_name)
    .filter((group) => {
      if (seen.has(group.group_id)) return false;
      seen.add(group.group_id);
      return true;
    });
}

function normalizeLabels(labels, platform, account) {
  const seen = new Set();
  return (labels || [])
    .map((label) => ({
      platform,
      account,
      native_label_id: String(label.native_label_id || label.id || '').trim(),
      name: String(label.name || label.title || label.id || '').trim(),
      color: label.color || label.hexColor || label.hex || null,
      kind: String(label.kind || 'label').trim() || 'label',
      raw_json: label.raw_json || label.raw || label,
    }))
    .filter((label) => label.native_label_id && label.name)
    .filter((label) => {
      if (seen.has(label.native_label_id)) return false;
      seen.add(label.native_label_id);
      return true;
    });
}

function normalizeMaps(maps, platform, account, groups, labels) {
  const groupIds = new Set(groups.map((group) => group.group_id));
  const labelIds = new Set(labels.map((label) => label.native_label_id));
  const seen = new Set();
  return (maps || [])
    .map((map) => ({
      platform,
      account,
      group_id: String(map.group_id || map.chat_id || '').trim(),
      native_label_id: String(map.native_label_id || map.label_id || map.id || '').trim(),
    }))
    .filter((map) => map.group_id && map.native_label_id)
    .filter((map) => !groupIds.size || groupIds.has(map.group_id))
    .filter((map) => !labelIds.size || labelIds.has(map.native_label_id))
    .filter((map) => {
      const key = `${map.group_id}:${map.native_label_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return null;
  }
}

module.exports = {
  readAndClearChannelSyncRequests,
  replaceChannelSnapshot,
  sanitizeSegment,
  syncRequestDir,
  writeChannelSyncRequest,
};
