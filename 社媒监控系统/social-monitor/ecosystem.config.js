module.exports = {
  apps: [
    {
      name: "worker-wa",
      script: "./workers/worker-wa.js",
      max_memory_restart: '1G',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "worker-tg",
      script: "./workers/worker-tg.js",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "ui-server",
      script: "./server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
