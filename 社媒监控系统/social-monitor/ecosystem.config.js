module.exports = {
  apps: [
    // --- WhatsApp Accounts ---
    {
      name: "worker-wa-1", // 账号1
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        ACCOUNT_NAME: "account1"
      }
    },
    /*
    // 如需更多WhatsApp账号，取消注释并修改名称
    {
      name: "worker-wa-2", // 账号2
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        ACCOUNT_NAME: "account2"
      }
    },
    */

    // --- Telegram Accounts ---
    {
      name: "worker-tg-1",
      script: "./workers/worker-tg.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "account1"
        // 默认使用 .env 中的配置
      }
    },
    /*
    // 如需更多Telegram机器人账号，取消注释并修改TOKEN
    {
      name: "worker-tg-2",
      script: "./workers/worker-tg.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        TG_BOT_TOKEN: "your_second_token_here"
      }
    },
    */
        {
      name: "worker-wa-nanya_wa",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "nanya_wa" }
    },
        {
      name: "worker-wa-yatai-wa",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "yatai-wa" }
    },
        {
      name: "worker-wa-yuyin_wa",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "yuyin_wa" }
    },
        {
      name: "worker-wa-wa_oumei2",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "wa_oumei2" }
    },
        {
      name: "worker-tgu-mason_text",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "mason_text",
        TG_API_ID: "33415159",
        TG_API_HASH: "3fed4680fdb1955a909591e91239f852",
        TG_WARMUP_SECONDS: "600",
        TG_DAILY_LIMIT: "2000",
        TG_BATCH_SIZE: "100",
        TG_SLEEP_MIN_MS: "3000",
        TG_SLEEP_MAX_MS: "8000",
        TG_BACKFILL_DAYS: "0",
        TG_ENABLE_BACKFILL: "true"
      }
    },
        {
      name: "worker-wa-wa_shebi",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "wa_shebi" }
    },
        {
      name: "worker-tgu-tgu_supplier",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "tgu_supplier",
        TG_API_ID: "34008866",
        TG_API_HASH: "4fae924fd46ceed34a9654f7b8789998",
        TG_WARMUP_SECONDS: "600",
        TG_DAILY_LIMIT: "2000",
        TG_BATCH_SIZE: "100",
        TG_SLEEP_MIN_MS: "3000",
        TG_SLEEP_MAX_MS: "8000",
        TG_BACKFILL_DAYS: "0",
        TG_ENABLE_BACKFILL: "true"
      }
    },
    // --- Web UI Server ---
    {
      name: "ui-server",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    // --- Data Sync Agent ---
    {
      name: "sync-agent",
      script: "./sync-agent.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },

    // ─── 分析层进程（阶段A：告警/生命周期/日报）─────────────────

    // 维度1+2：供应商告警引擎（P0/P1/无响应/SID变更检测）
    {
      name: "supplier-analyzer",
      script: "./analyzers/supplier-analyzer.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: "production",
      }
    },

    // 维度2：问题生命周期追踪（闭环检测/超时提醒/升级/承诺追踪）
    {
      name: "issue-lifecycle-tracker",
      script: "./analyzers/issue-lifecycle-tracker.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: "production",
      }
    },

    // 维度3：每日群汇总日报（09:00 Asia/Shanghai 定时推送）
    {
      name: "daily-digest",
      script: "./analyzers/daily-digest.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: "production",
      }
    },

    // 维度4：每周一09:00 cron，从 issue_records 聚合评分
    {
      name: "supplier-reliability-scorer",
      script: "./analyzers/supplier-reliability-scorer.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: "production",
      }
    },

    // 维度5：内容审核提取，积累供应商审核标准
    {
      name: "content-review-extractor",
      script: "./analyzers/content-review-extractor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
