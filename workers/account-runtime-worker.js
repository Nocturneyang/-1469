'use strict';

process.env.WORKBENCH_ACCOUNT_DB_MODE = process.env.WORKBENCH_ACCOUNT_DB_MODE || 'isolated';
process.env.WORKBENCH_WORKER_ROLE = process.env.WORKBENCH_WORKER_ROLE || 'account-runtime';

require('./service-login-worker');
