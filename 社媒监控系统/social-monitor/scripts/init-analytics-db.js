#!/usr/bin/env node
/**
 * scripts/init-analytics-db.js
 * 初始化 analytics.sqlite 分析库
 * 幂等：重复执行不会破坏数据。首次运行建表，后续运行跳过。
 *
 * 用法：node scripts/init-analytics-db.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');
const ANALYTICS_DB_PATH = path.join(ROOT, 'db', 'analytics.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'analytics-schema.sql');

// 确保 db/ 目录存在
const dbDir = path.join(ROOT, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log('✅ 创建 db/ 目录');
}

// 读取 DDL
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');

// 打开/创建 analytics.sqlite
const db = new Database(ANALYTICS_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 执行 DDL（事务保证原子性）
db.exec(schemaSql);

// 初始化游标记录（不存在则插入，存在则跳过）
const cursors = [
  'supplier-analyzer',
  'issue-lifecycle-tracker',
  'daily-digest',
  'sid-change-detector',
  'content-review-extractor',
  'knowledge-asset-analyzer',
  'knowledge-asset-commitments',
];

const insertCursor = db.prepare(`
  INSERT OR IGNORE INTO analysis_cursor (analyzer, last_msg_id, last_ts)
  VALUES (?, 0, 0)
`);

const insertMany = db.transaction((names) => {
  for (const name of names) insertCursor.run(name);
});
insertMany(cursors);

db.close();

console.log(`✅ analytics.sqlite 初始化完成 → ${ANALYTICS_DB_PATH}`);
console.log('   包含表：analysis_cursor, alert_records, issue_records,');
console.log('          daily_digests, reliability_snapshots,');
console.log('          content_reviews, sid_change_records,');
console.log('          knowledge_asset_candidates, knowledge_assets, knowledge_asset_links');
