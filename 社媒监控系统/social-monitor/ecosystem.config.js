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
      name: "worker-wa-oumei_wa",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production", ACCOUNT_NAME: "oumei_wa" }
    },
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
    }
  ]
};
