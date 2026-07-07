module.exports = {
  apps: [
    {
      name: 'social-workbench',
      script: 'server/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        DATA_DIR: process.env.DATA_DIR || '/data',
        WORKBENCH_DB_DIR: process.env.WORKBENCH_DB_DIR || '/data/db',
        SSO_ENABLED: process.env.SSO_ENABLED || 'true',
        SSO_LOGIN_URL: process.env.SSO_LOGIN_URL || 'https://skyline-ark-sso.tyhark.com/login',
        SSO_LOGOUT_URL: process.env.SSO_LOGOUT_URL || 'https://skyline-ark-sso.tyhark.com/logout',
        SSO_REDIRECT_PARAM: process.env.SSO_REDIRECT_PARAM || 'redirect',
        SSO_LOGOUT_REDIRECT_PARAM: process.env.SSO_LOGOUT_REDIRECT_PARAM || 'redirect',
      },
      max_memory_restart: '512M',
      kill_timeout: 5000,
    },
  ],
};
