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
  business_sector TEXT,             -- 业务板块
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
  business_sector  TEXT,             -- 业务板块
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
  business_sector TEXT,                  -- 业务板块
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
  business_sector   TEXT,                -- 业务板块
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
  business_sector TEXT,                  -- 业务板块
  sender_name   TEXT,
  sid_list      TEXT,                    -- JSON数组，本次更新的SID列表
  raw_content   TEXT,                    -- 原始消息内容
  source_msg_id INTEGER,                 -- 对应 messages.id
  is_pushed     INTEGER DEFAULT 0,
  detected_at   DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- ⑧ P0 误报压制记录（上下文AI判定为非告警的P0候选）
CREATE TABLE IF NOT EXISTS suppressed_alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_msg_id   INTEGER NOT NULL,        -- 对应 messages.id
  group_name      TEXT,
  trigger_keyword TEXT,                    -- 触发关键词
  suppress_reason TEXT,                    -- 压制原因（AI判定摘要）
  ai_response     TEXT,                    -- AI完整返回JSON
  created_at      DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_suppressed_msg ON suppressed_alerts(source_msg_id);

-- ⑨ QA 知识库（问题闭环时自动提取）
CREATE TABLE IF NOT EXISTS qa_knowledge_base (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_sector   TEXT NOT NULL,              -- 设备供应商/直连供应商/语音直连供应商/客服
  question_type     TEXT NOT NULL,              -- 问题分类：设备无法连接/OTP未送达/503错误/...
  question_summary  TEXT NOT NULL,              -- 问题一句话摘要（AI提取）
  question_keywords TEXT,                       -- 检索关键词（逗号分隔）
  answer_pattern    TEXT NOT NULL,              -- 标准解决步骤（1.2.3.）
  answer_category   TEXT,                       -- 解决类型：配置修改/重启/更换硬件/联系运营商/等待恢复/其他
  source_group_name TEXT,                       -- 来源群名（可追溯）
  source_issue_id   INTEGER,                   -- 关联 issue_records.id
  source_msg_ids    TEXT,                       -- 来源消息ID列表（JSON数组）
  frequency         INTEGER DEFAULT 1,          -- 该QA模式出现次数
  last_seen_at      INTEGER,                   -- 最后出现时间（毫秒时间戳）
  confidence        REAL DEFAULT 0.5,           -- 置信度（出现次数越多越高）
  created_at        DATETIME DEFAULT (datetime('now', '+8 hours')),
  updated_at        DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_qa_sector_type ON qa_knowledge_base(business_sector, question_type);
CREATE INDEX IF NOT EXISTS idx_qa_frequency ON qa_knowledge_base(frequency DESC);
CREATE INDEX IF NOT EXISTS idx_qa_confidence ON qa_knowledge_base(confidence DESC);

-- ⑩ 供应商画像（每日凌晨更新）
CREATE TABLE IF NOT EXISTS supplier_profiles (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name          TEXT NOT NULL UNIQUE,         -- 群名即供应商标识
  group_id            TEXT,
  business_sector     TEXT NOT NULL,
  region              TEXT,
  platform            TEXT DEFAULT 'wa',

  -- 响应指标（分钟）
  avg_response_mins   REAL,                        -- 平均响应时间
  p50_response_mins   REAL,                        -- P50 响应时间
  p95_response_mins   REAL,                        -- P95 响应时间

  -- 质量指标
  total_issues        INTEGER DEFAULT 0,           -- 总问题数
  open_issues         INTEGER DEFAULT 0,           -- 当前未闭环
  avg_resolution_mins REAL,                        -- 平均解决时长
  recurrence_rate     REAL,                        -- 复发率（重复问题数/总问题数）

  -- 承诺指标
  total_commitments   INTEGER DEFAULT 0,           -- 总承诺次数
  commitments_met     INTEGER DEFAULT 0,           -- 已兑现承诺
  commitment_rate     REAL,                        -- 承诺兑现率 0.0~1.0

  -- 评分
  reliability_score   REAL DEFAULT 100,            -- 综合可靠性评分 0~100
  score_updated_at    DATETIME,

  -- 画像
  active_hours        TEXT,                        -- 活跃时段分布（JSON: {"00-06":n,"06-12":n,...}）
  primary_language    TEXT,                        -- 主要沟通语言
  top_issue_types     TEXT,                        -- 高频问题类型 Top3（JSON数组）

  -- AI 画像分析字段（ai-client analyzeSupplierProfile）
  ai_attitude_tags       TEXT,                     -- 态度标签 JSON数组
  ai_insight_tags        TEXT,                     -- AI洞察标签 JSON数组
  ai_insight_summary     TEXT,                     -- AI总评文字
  ai_sub_scores          TEXT,                     -- 分项评分 JSON: {label: pct, ...}
  ai_avg_turns           REAL,                     -- 平均交互回合数
  ai_fcr                 REAL,                     -- 首问解决率 FCR 0~1
  ai_tech_contact        TEXT,                     -- 核心技术接口人
  ai_tech_reply_rate     REAL,                     -- 技术回复率 0~1
  ai_planned_maintenance_pct REAL,                 -- 计划内维护占比 0~1
  ai_profile_version     TEXT,                     -- AI画像版本号

  last_alert_at       INTEGER,                     -- 最后一次告警时间戳
  total_messages      INTEGER DEFAULT 0,           -- 累计消息数
  profile_updated_at  DATETIME DEFAULT (datetime('now', '+8 hours')),
  created_at          DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sp_sector ON supplier_profiles(business_sector);
CREATE INDEX IF NOT EXISTS idx_sp_region ON supplier_profiles(region);
CREATE INDEX IF NOT EXISTS idx_sp_score ON supplier_profiles(reliability_score DESC);

-- ⑪ 通道质量时序指标（数值型 KPI 快照）
CREATE TABLE IF NOT EXISTS channel_quality_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name      TEXT NOT NULL,
  metric_date     TEXT NOT NULL,                   -- YYYY-MM-DD
  metric_type     TEXT NOT NULL,                   -- dlr_rate / click_rate / block_rate / asr / concurrent / ...
  metric_value    REAL,                            -- 数值（百分比存储为 0.0~1.0）
  metric_raw_text TEXT,                            -- 原始消息片段（可追溯）
  source_msg_id   INTEGER,                        -- 对应 messages.id
  created_at      DATETIME DEFAULT (datetime('now', '+8 hours')),
  UNIQUE(group_name, metric_date, metric_type)
);

CREATE INDEX IF NOT EXISTS idx_cqm_group_date ON channel_quality_metrics(group_name, metric_date);

-- ⑫ 设备知识图谱（从设备供应商对话中提取）
CREATE TABLE IF NOT EXISTS device_knowledge_graph (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  device_model          TEXT NOT NULL,              -- 设备型号：RFH0606938SM / MP 664U-64N
  device_type           TEXT,                       -- 设备类型：goip / modem / SIM box
  fault_symptom         TEXT NOT NULL,              -- 故障现象
  fault_category        TEXT,                       -- 故障分类：配置/硬件/网络/SIM/IMEI
  solution_steps        TEXT NOT NULL,              -- 解决步骤
  solution_effectiveness INTEGER DEFAULT 0,         -- 方案有效性（成功解决次数）
  source_group_name     TEXT,
  source_msg_ids        TEXT,                       -- JSON数组
  source_issue_id       INTEGER,                    -- 关联 issue_records.id（去重标记）
  frequency             INTEGER DEFAULT 1,
  last_seen_at          INTEGER,
  created_at            DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_dkg_model ON device_knowledge_graph(device_model);
CREATE INDEX IF NOT EXISTS idx_dkg_category ON device_knowledge_graph(fault_category);
CREATE INDEX IF NOT EXISTS idx_dkg_issue ON device_knowledge_graph(source_issue_id);

-- ─── ⑬ 内容模板库（5.3）─────────────────────────────────
CREATE TABLE IF NOT EXISTS content_template_lib (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name         TEXT,                       -- 客户名称：Onbuka / JILI / LAAFFIC
  template_content      TEXT,                       -- 模板内容摘要
  template_type         TEXT,                       -- OTP / Marketing / Notification
  target_region         TEXT,                       -- 目标地区
  target_operator       TEXT,                       -- 目标运营商
  review_result         TEXT,                       -- 审核结果：approved / rejected / modified
  compliance_notes      TEXT,                       -- 合规注意事项
  source_group_name     TEXT,
  source_msg_ids        TEXT,                       -- JSON数组
  source_issue_id       INTEGER,                    -- 关联 issue_records.id
  frequency             INTEGER DEFAULT 1,
  last_seen_at          INTEGER,
  created_at            DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ctl_customer ON content_template_lib(customer_name);
CREATE INDEX IF NOT EXISTS idx_ctl_type ON content_template_lib(template_type);
CREATE INDEX IF NOT EXISTS idx_ctl_issue ON content_template_lib(source_issue_id);

-- ⑭ 统一知识资产候选池（离线回溯 + 实时增量共同写入）
CREATE TABLE IF NOT EXISTS knowledge_asset_candidates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key            TEXT NOT NULL UNIQUE,       -- 稳定去重键
  asset_type            TEXT NOT NULL,              -- entity_relationship / operation_action / ...
  asset_key             TEXT,                       -- 类型内业务键
  title                 TEXT NOT NULL,
  description           TEXT,

  collection_region     TEXT,                       -- 采集账号归属区域
  business_region       TEXT,                       -- 内容指向区域（v1 默认等于 collection_region）
  business_sector       TEXT,
  receiver_account      TEXT,
  value_label           TEXT DEFAULT 'L1',          -- L0/L1/L2/L3
  group_name            TEXT,

  source_msg_ids        TEXT,                       -- JSON数组，对应 messages.id
  time_range            TEXT,                       -- JSON: {start,end}
  evidence              TEXT,                       -- JSON数组，脱敏摘要
  metrics               TEXT,                       -- JSON对象，类型专属指标
  related_entities      TEXT,                       -- JSON数组，客户/国家/运营商/SID/设备等

  confidence            REAL DEFAULT 0.5,           -- 抽取置信度 0~1
  asset_value_score     INTEGER DEFAULT 50,         -- 业务价值分 0~100
  value_level           TEXT DEFAULT 'medium',      -- high / medium / low
  value_reasons         TEXT,                       -- JSON数组
  frequency             INTEGER DEFAULT 1,
  first_seen_at         INTEGER,
  last_seen_at          INTEGER,

  extractor             TEXT DEFAULT 'offline-discovery',
  extractor_version     TEXT DEFAULT 'v1',
  prompt_version        TEXT,
  model_name            TEXT,
  validation_status     TEXT DEFAULT 'rule_validated',
  review_status         TEXT DEFAULT 'pending_review', -- pending_review / confirmed / rejected / merged
  review_note           TEXT,
  reviewed_by           TEXT,
  reviewed_at           DATETIME,

  created_at            DATETIME DEFAULT (datetime('now', '+8 hours')),
  updated_at            DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_kac_type ON knowledge_asset_candidates(asset_type);
CREATE INDEX IF NOT EXISTS idx_kac_status ON knowledge_asset_candidates(review_status);
CREATE INDEX IF NOT EXISTS idx_kac_sector_region ON knowledge_asset_candidates(business_sector, collection_region);
CREATE INDEX IF NOT EXISTS idx_kac_value ON knowledge_asset_candidates(asset_value_score DESC, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_kac_seen ON knowledge_asset_candidates(last_seen_at DESC);

-- ⑮ 正式知识资产库（由已确认候选沉淀而来，供业务页面调用）
CREATE TABLE IF NOT EXISTS knowledge_assets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_uid             TEXT NOT NULL UNIQUE,       -- 正式资产唯一 ID
  asset_type            TEXT NOT NULL,
  asset_key             TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  status                TEXT DEFAULT 'active',      -- active / inactive / merged / deprecated

  collection_region     TEXT,
  business_region       TEXT,
  business_sector       TEXT,
  receiver_account      TEXT,
  value_label           TEXT DEFAULT 'L1',
  group_name            TEXT,

  source_candidate_keys TEXT,                       -- JSON数组，对应 knowledge_asset_candidates.dedupe_key
  source_msg_ids        TEXT,                       -- JSON数组，对应 messages.id
  time_range            TEXT,                       -- JSON: {start,end}
  evidence              TEXT,                       -- JSON数组，脱敏摘要
  metrics               TEXT,                       -- JSON对象，类型专属指标
  related_entities      TEXT,                       -- JSON数组
  tags                  TEXT,                       -- JSON数组，人工/AI标签

  confidence            REAL DEFAULT 0.5,
  asset_value_score     INTEGER DEFAULT 50,
  quality_score         INTEGER DEFAULT 50,         -- 审核后质量分
  frequency             INTEGER DEFAULT 1,
  first_seen_at         INTEGER,
  last_seen_at          INTEGER,
  usage_count           INTEGER DEFAULT 0,
  last_used_at          DATETIME,

  created_from          TEXT DEFAULT 'candidate_review',
  created_by            TEXT,
  reviewed_by           TEXT,
  reviewed_at           DATETIME,
  created_at            DATETIME DEFAULT (datetime('now', '+8 hours')),
  updated_at            DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ka_type ON knowledge_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_ka_status ON knowledge_assets(status);
CREATE INDEX IF NOT EXISTS idx_ka_sector_region ON knowledge_assets(business_sector, collection_region);
CREATE INDEX IF NOT EXISTS idx_ka_group ON knowledge_assets(group_name);
CREATE INDEX IF NOT EXISTS idx_ka_value ON knowledge_assets(asset_value_score DESC, quality_score DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ka_dedupe ON knowledge_assets(asset_type, asset_key, collection_region, business_sector, group_name);

-- ⑯ 候选资产与正式资产关系
CREATE TABLE IF NOT EXISTS knowledge_asset_links (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_uid             TEXT NOT NULL,
  candidate_key         TEXT NOT NULL,
  link_type             TEXT DEFAULT 'promoted',    -- promoted / merged / supporting
  created_by            TEXT,
  created_at            DATETIME DEFAULT (datetime('now', '+8 hours')),
  UNIQUE(asset_uid, candidate_key)
);

CREATE INDEX IF NOT EXISTS idx_kal_asset ON knowledge_asset_links(asset_uid);
CREATE INDEX IF NOT EXISTS idx_kal_candidate ON knowledge_asset_links(candidate_key);

-- ⑰ 知识资产使用日志（后续用于质量反馈和推荐排序）
CREATE TABLE IF NOT EXISTS knowledge_asset_usage_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_uid             TEXT NOT NULL,
  used_in               TEXT,                       -- supplier_profile / alert_detail / issue_resolution / manual
  ref_id                TEXT,
  feedback              TEXT,                       -- helpful / not_helpful / stale
  note                  TEXT,
  used_by               TEXT,
  created_at            DATETIME DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_kaul_asset ON knowledge_asset_usage_log(asset_uid);
CREATE INDEX IF NOT EXISTS idx_kaul_used_in ON knowledge_asset_usage_log(used_in);
