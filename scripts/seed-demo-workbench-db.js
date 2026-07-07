const { openWorkbenchDb } = require('../db/workbench-db');

const dbPath = process.argv[2] || process.env.WORKBENCH_DB_PATH || '/private/tmp/workbench-demo.sqlite';
const db = openWorkbenchDb(dbPath);

const labels = [
  ['wa', 'nanya_wa', 'vip', 'VIP 客户', '#059669', 'label'],
  ['wa', 'nanya_wa', 'after-sales-eu', '欧洲售后', '#0f766e', 'label'],
  ['wa', 'nanya_wa', 'logistics', '物流跟进', '#b45309', 'label'],
  ['tg', 'jason_tg', 'sea-market', '东南亚市场', '#0284c7', 'folder'],
  ['tg', 'jason_tg', 'promo', '营销活动', '#7c3aed', 'folder'],
  ['teams', 'lily_teams', 'product-feedback', '产品反馈', '#4f46e5', 'folder'],
];

const labelStmt = db.prepare(`
  INSERT INTO channel_labels (platform, account, native_label_id, name, color, kind, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(platform, account, native_label_id) DO UPDATE SET
    name = excluded.name,
    color = excluded.color,
    kind = excluded.kind,
    raw_json = excluded.raw_json,
    synced_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
`);

labels.forEach((label) => {
  labelStmt.run(...label, JSON.stringify({ demo: true }));
});

const maps = [
  ['wa', 'nanya_wa', 'vip-support', 'vip'],
  ['wa', 'nanya_wa', 'logistics-eu', 'after-sales-eu'],
  ['wa', 'nanya_wa', 'packing-issue', 'logistics'],
  ['tg', 'jason_tg', 'sea-seller', 'sea-market'],
  ['tg', 'jason_tg', 'promo', 'promo'],
  ['teams', 'lily_teams', 'product-feedback', 'product-feedback'],
];

const mapStmt = db.prepare(`
  INSERT INTO conversation_label_map (platform, account, group_id, native_label_id)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(platform, account, group_id, native_label_id) DO UPDATE SET
    synced_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
`);

maps.forEach((map) => mapStmt.run(...map));
db.close();

console.log(`[workbench] demo workbench DB written to ${dbPath}`);
