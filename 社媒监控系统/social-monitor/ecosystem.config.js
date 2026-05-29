module.exports = {
  apps: [
    // --- WhatsApp Accounts ---
    /*
    // 如需更多WhatsApp账号，取消注释并修改名称
    {
      name: "worker-wa-2", // 账号2
      script: "./workers/worker-wa.js",
      max_memory_restart: '2G',
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
      cron_restart: '0 4 * * *',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 12000,    // 给 SIGTERM handler 足够时间杀掉 Chrome
      restart_delay: 30000,   // 初始化失败时延迟重启，防止重启风暴
      max_restarts: 5,
      min_uptime: "2m",
      env: { NODE_ENV: "production", ACCOUNT_NAME: "nanya_wa" }
    },
        {
      name: "worker-wa-yatai-wa",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      cron_restart: '0 4 * * *',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 12000,
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
      env: { NODE_ENV: "production", ACCOUNT_NAME: "yatai-wa" }
    },
        {
      name: "worker-wa-wa_oumei2",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      cron_restart: '0 4 * * *',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 12000,
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
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
      cron_restart: '0 4 * * *',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 12000,
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
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
      name: "worker-tgu-laffic_service",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "laffic_service",
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
      name: "worker-tgu-TG_kaxian",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "TG_kaxian",
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
      max_memory_restart: "512M",
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
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      }
    },
    // --- WhatsApp Supervisor ---
    {
      name: "wa-supervisor",
      script: "./workers/wa-supervisor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
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
    },

    // 维度6：QA知识库自动提取，问题闭环时抽取QA知识对
    {
      name: "knowledge-extractor",
      script: "./analyzers/knowledge-extractor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: "production",
      }
    },

    // 维度7：供应商画像计算引擎，每日凌晨汇总
    {
      name: "supplier-profiler",
      script: "./analyzers/supplier-profiler.js",
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
