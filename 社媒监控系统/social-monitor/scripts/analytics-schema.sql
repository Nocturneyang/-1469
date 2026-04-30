-- ================================================================
-- analytics.sqlite 分析库 DDL（全部 IF NOT EXISTS，幂等可重复执行）
-- 采集库 database.sqlite 保持只读，本文件仅建分析输出表
-- ================================================================

-- ① 分析游标（替代给 messages 表加 is_analyzed 字段）
CREATE TABLE IF NOT EXISTS analysis_cursor (
  analyzer      TEXT PRIMARY KEY,   -- 'supplier-analyzer'|'digest'|'lifecycle'|...
  last_msg_id   INTEGER DEFAULT 0,  -- 上次处理到的最大消息 id
  last_ts       INTEGER DEFAULT 0,  -- 上次处理到的最大 timestamp
  updated_at    DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- ② 告警记录
CREATE TABLE IF NOT EXISTS alert_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_msg_ids TEXT,              -- 来源消息 id JSON数组（对应 database.sqlite 的 messages.id）
  group_name    TEXT,
  group_id      TEXT,
  region        TEXT,
  receiver_account TEXT,
  alert_level   TEXT NOT NULL,      -- 'p0'|'p1'|'p2'
  trigger_type  TEXT,               -- 'keyword'|'ai'|'silence'|'no_response'|'sid_change'
  trigger_keywords TEXT,            -- 命中的关键词
  ai_score      REAL,
  ai_title      TEXT,
  ai_type       TEXT,
  ai_action     TEXT,
  ai_commitment TEXT,
  is_pushed     INTEGER DEFAULT 0,
  push_channel  TEXT,               -- 'dingtalk_alert'
  created_at    DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- ③ 问题生命周期
CREATE TABLE IF NOT EXISTS issue_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id         INTEGER,          -- 关联 alert_records.id
  group_name       TEXT NOT NULL,
  group_id         TEXT,
  region           TEXT,
  issue_type       TEXT,             -- '通道故障'|'成功率告警'|'内容过滤'|'SID变更'|'无响应'
  status           TEXT DEFAULT 'open',   -- 'open'|'closed'|'escalated'
  opened_at        INTEGER NOT NULL, -- 毫秒时间戳
  closed_at        INTEGER,
  duration_mins    REAL,             -- 持续时长（分钟），关闭时计算
  commitment_text  TEXT,             -- 供应商承诺原文（若有）
  commitment_due   INTEGER,          -- 承诺截止时间戳（毫秒）
  commitment_met   INTEGER,          -- 1=兑现, 0=未兑现, NULL=无承诺
  closed_by        TEXT,             -- 谁的消息触发了关闭
  recurrence_count INTEGER DEFAULT 1, -- 同类型问题在此群的累计次数
  escalation_count INTEGER DEFAULT 0, -- 已升级次数
  last_escalated_at INTEGER,          -- 最近一次升级时间戳
  created_at       DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- ④ 每日群摘要
CREATE TABLE IF NOT EXISTS daily_digests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date     TEXT NOT NULL,         -- 'YYYY-MM-DD'（前一日）
  group_name      TEXT NOT NULL,
  group_id        TEXT,
  region          TEXT,
  receiver_account TEXT,
  msg_count       INTEGER DEFAULT 0,
  key_points      TEXT,                  -- JSON数组字符串
  follow_up       TEXT,                  -- JSON数组字符串
  open_issues_cnt INTEGER DEFAULT 0,
  has_alert       INTEGER DEFAULT 0,
  prompt_version  TEXT DEFAULT 'v1.0',
  created_at      DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- 避免同一天同一群重复生成
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_digest_date_group
  ON daily_digests (digest_date, group_name);

-- ⑤ 供应商可靠性周报快照
CREATE TABLE IF NOT EXISTS reliability_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start        TEXT NOT NULL,       -- 'YYYY-MM-DD'（周一日期）
  group_name        TEXT NOT NULL,
  region            TEXT,
  total_issues      INTEGER DEFAULT 0,
  avg_recovery_mins REAL,
  commitment_rate   REAL,               -- 兑现率 0.0~1.0
  proactive_rate    REAL,               -- 主动报告率 0.0~1.0
  reliability_score REAL,               -- 综合评分 0~100
  still_open        INTEGER DEFAULT 0,
  created_at        DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- ⑥ 短信内容审核知识库
CREATE TABLE IF NOT EXISTS content_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name        TEXT,
  submitter_name    TEXT,
  content_submitted TEXT,
  reviewer_reply    TEXT,
  approved          INTEGER,             -- 1=通过, 0=未通过, NULL=待确认
  rejection_reason  TEXT,
  source_msg_id     INTEGER,             -- 对应 messages.id
  timestamp         INTEGER,
  created_at        DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- ⑦ Sender ID 变更记录
CREATE TABLE IF NOT EXISTS sid_change_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name    TEXT,
  group_id      TEXT,
  region        TEXT,
  sender_name   TEXT,
  sid_list      TEXT,                    -- JSON数组，本次更新的SID列表
  raw_content   TEXT,                    -- 原始消息内容
  source_msg_id INTEGER,                 -- 对应 messages.id
  is_pushed     INTEGER DEFAULT 0,
  detected_at   DATETIME DEFAULT (datetime('now', '+8 hours'))
);
