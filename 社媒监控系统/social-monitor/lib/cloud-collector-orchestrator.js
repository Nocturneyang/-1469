'use strict';

const fs = require('fs');
const path = require('path');
const { createDeployHubAdapter } = require('./wa-runtime-adapters/deploy-hub-runtime-adapter');
const { CLOUD_RUNTIME_PROVIDER } = require('./cloud-runtime-provider');
const { readEnvFile } = require('./env-config');
const {
    db,
    upsertCollectorRuntimeSpec,
    getCollectorRuntimeSpec,
    updateCollectorRuntimeDesiredState,
    deleteCollectorRuntimeSpec
} = require('../db/database');
const { sessionDir } = require('./account-session-store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');

function envFlag(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function isCloudCollectorEnabled() {
    return envFlag('CLOUD_COLLECTOR_ENABLED');
}

function sanitizeRuntimeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

function accountParts(accountId, explicitPlatform = '') {
    if (accountId.startsWith('wa-')) {
        return { accountId, platform: 'whatsapp', collectorPlatform: 'whatsapp', accountName: accountId.slice(3) };
    }
    if (accountId.startsWith('tgu-')) {
        return { accountId, platform: 'telegram', collectorPlatform: 'telegram-user', accountName: accountId.slice(4) };
    }
    if (accountId.startsWith('tg-')) {
        return { accountId, platform: 'telegram', collectorPlatform: 'telegram-bot', accountName: accountId.slice(3) };
    }
    if (accountId.startsWith('teams-')) {
        return { accountId, platform: 'teams', collectorPlatform: 'teams-graph', accountName: accountId.slice(6) };
    }
    if (explicitPlatform === 'whatsapp') return { accountId: `wa-${accountId}`, platform: 'whatsapp', collectorPlatform: 'whatsapp', accountName: accountId };
    if (explicitPlatform === 'teams') return { accountId: `teams-${accountId}`, platform: 'teams', collectorPlatform: 'teams-graph', accountName: accountId };
    return { accountId, platform: explicitPlatform || 'unknown', collectorPlatform: explicitPlatform || 'unknown', accountName: accountId };
}

function deploymentNameFor(accountId) {
    return sanitizeRuntimeName(`${process.env.CLOUD_COLLECTOR_DEPLOYMENT_PREFIX || 'sm-collector-'}${accountId}`);
}

function defaultResources(collectorPlatform) {
    if (collectorPlatform === 'whatsapp') {
        return {
            requests: { cpu: '500m', memory: '1536Mi' },
            limits: { cpu: '2', memory: '4Gi' }
        };
    }
    if (collectorPlatform === 'teams-graph') {
        return {
            requests: { cpu: '150m', memory: '256Mi' },
            limits: { cpu: '800m', memory: '768Mi' }
        };
    }
    return {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '500m', memory: '512Mi' }
    };
}

function envValue(name, value) {
    return { name, value: String(value ?? '') };
}

function accountEnvKey(accountName) {
    return String(accountName || '').toUpperCase().replace(/-/g, '_');
}

function configuredEnvValue(name) {
    try {
        return process.env[name] || readEnvFile()[name] || '';
    } catch (_) {
        return process.env[name] || '';
    }
}

function pushConfiguredEnv(target, name) {
    const value = configuredEnvValue(name);
    if (value !== '') target.push(envValue(name, value));
}

function secretEnv(name, key = name) {
    return {
        name,
        valueFrom: {
            secretKeyRef: {
                name: process.env.CLOUD_COLLECTOR_SECRET_NAME || 'social-monitor-secrets',
                key,
                optional: true
            }
        }
    };
}

function platformEnv(parts, extraEnv = {}) {
    const base = [
        envValue('NODE_ENV', 'production'),
        envValue('DATA_DIR', '/data'),
        envValue('COLLECTOR_PLATFORM', parts.collectorPlatform),
        envValue('COLLECTOR_REMOTE_ONLY', 'true'),
        envValue('COLLECTOR_API_URL', process.env.CLOUD_COLLECTOR_API_URL || 'http://social-monitor/api/collector'),
        envValue('COLLECTOR_ID', `${CLOUD_RUNTIME_PROVIDER}:${parts.accountId}`),
        envValue('COLLECTOR_OUTBOX_DIR', `/data/collector-outbox/${parts.accountId}`),
        envValue('ACCOUNT_SESSION_DIR', '/data/collector-sessions'),
        envValue('DISABLE_MEDIA_UPLOAD', process.env.DISABLE_MEDIA_UPLOAD || '1'),
        envValue('PUPPETEER_SKIP_DOWNLOAD', 'true'),
        envValue('PUPPETEER_EXECUTABLE_PATH', process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'),
        envValue('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium'),
        envValue('ENABLE_WORKBENCH', process.env.ENABLE_WORKBENCH || '1'),
        envValue('ENABLE_WORKBENCH_SEND', process.env.ENABLE_WORKBENCH_SEND || '1'),
        envValue('ENABLE_WORKBENCH_SYNC', process.env.ENABLE_WORKBENCH_SYNC || '1'),
        envValue('WORKBENCH_SEND_ACCOUNTS', parts.accountId),
        envValue('WORKBENCH_SYNC_ACCOUNTS', parts.accountId),
        envValue('WORKBENCH_DB_PATH', process.env.WORKBENCH_DB_PATH || '/data/db/workbench.sqlite'),
        envValue('WORKBENCH_OUTBOX_DIR', process.env.WORKBENCH_OUTBOX_DIR || '/data/workbench-outbox'),
        secretEnv('COLLECTOR_TOKEN'),
        secretEnv('ACCOUNT_SESSION_ENCRYPTION_KEY')
    ];

    if (parts.collectorPlatform === 'whatsapp') {
        base.push(
            envValue('ACCOUNT_NAME', parts.accountName),
            envValue('WA_AUTH_DATA_PATH', '/data/collector-sessions/wa'),
            envValue('WA_ORCHESTRATOR_MANAGED_INIT', 'true'),
            envValue('WA_QR_IDLE_TIMEOUT_MS', process.env.WA_QR_IDLE_TIMEOUT_MS || '300000'),
            envValue('WA_INIT_HARD_TIMEOUT_MS', process.env.WA_INIT_HARD_TIMEOUT_MS || '360000')
        );
    } else if (parts.collectorPlatform === 'telegram-bot') {
        const key = accountEnvKey(parts.accountName);
        base.push(
            envValue('TG_ACCOUNT_NAME', parts.accountName),
            envValue('TG_COLLECTOR_TYPE', 'bot')
        );
        pushConfiguredEnv(base, `TG_BOT_TOKEN_${key}`);
        pushConfiguredEnv(base, 'TG_BOT_TOKEN');
    } else if (parts.collectorPlatform === 'telegram-user') {
        const key = accountEnvKey(parts.accountName);
        base.push(
            envValue('TG_ACCOUNT_NAME', parts.accountName),
            envValue('TG_COLLECTOR_TYPE', 'user')
        );
        [
            `TG_API_ID_${key}`,
            `TG_API_HASH_${key}`,
            `TG_USER_SESSION_${key}`,
            `TG_WARMUP_SECONDS_${key}`,
            `TG_DAILY_LIMIT_${key}`,
            `TG_BATCH_SIZE_${key}`,
            `TG_SLEEP_MIN_MS_${key}`,
            `TG_SLEEP_MAX_MS_${key}`,
            `TG_BACKFILL_DAYS_${key}`,
            `TG_ENABLE_BACKFILL_${key}`,
            `TG_WHITELIST_${key}`,
            'TG_API_ID',
            'TG_API_HASH',
            'TG_WARMUP_SECONDS',
            'TG_DAILY_LIMIT',
            'TG_BATCH_SIZE',
            'TG_SLEEP_MIN_MS',
            'TG_SLEEP_MAX_MS',
            'TG_BACKFILL_DAYS',
            'TG_ENABLE_BACKFILL'
        ].forEach(name => pushConfiguredEnv(base, name));
    } else if (parts.collectorPlatform === 'teams-graph') {
        const key = accountEnvKey(parts.accountName);
        base.push(envValue('ACCOUNT_NAME', parts.accountName));
        [
            'MICROSOFT_GRAPH_CLIENT_ID',
            'MICROSOFT_GRAPH_CLIENT_SECRET',
            'MICROSOFT_GRAPH_REDIRECT_URI',
            'TEAMS_AUTH_MODE',
            'TEAMS_ACCOUNT_TYPE',
            `TEAMS_WHITELIST_${key}`
        ].forEach(name => pushConfiguredEnv(base, name));
    }

    for (const [key, value] of Object.entries(extraEnv || {})) {
        if (value !== undefined && value !== null && value !== '') base.push(envValue(key, value));
    }

    return base;
}

function buildDeployment({
    accountId,
    platform,
    accountName,
    collectorPlatform,
    deploymentName,
    namespace,
    image,
    resources,
    replicas = 1,
    extraEnv = {}
}) {
    const labels = {
        'app.kubernetes.io/name': 'social-monitor-collector',
        'app.kubernetes.io/component': 'collector',
        'social-monitor.tyhark.com/account-id': accountId,
        'social-monitor.tyhark.com/platform': collectorPlatform
    };
    if (collectorPlatform === 'whatsapp') {
        labels['app.kubernetes.io/part-of'] = 'social-monitor-wa';
        labels['wa-account'] = accountName;
    } else {
        labels['app.kubernetes.io/part-of'] = 'social-monitor-collector';
    }

    return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: deploymentName,
            namespace,
            labels
        },
        spec: {
            replicas,
            strategy: { type: 'Recreate' },
            selector: { matchLabels: labels },
            template: {
                metadata: { labels },
                spec: {
                    serviceAccountName: process.env.CLOUD_COLLECTOR_SERVICE_ACCOUNT || 'social-monitor',
                    containers: [
                        {
                            name: 'collector',
                            image,
                            imagePullPolicy: process.env.CLOUD_COLLECTOR_IMAGE_PULL_POLICY || 'IfNotPresent',
                            env: platformEnv({ accountId, platform, accountName, collectorPlatform }, extraEnv),
                            envFrom: [
                                {
                                    secretRef: {
                                        name: process.env.CLOUD_COLLECTOR_SECRET_NAME || 'social-monitor-secrets',
                                        optional: true
                                    }
                                }
                            ],
                            resources,
                            volumeMounts: [
                                { name: 'sqlite-data', mountPath: '/data' }
                            ]
                        }
                    ],
                    volumes: [
                        {
                            name: 'sqlite-data',
                            persistentVolumeClaim: {
                                claimName: process.env.CLOUD_COLLECTOR_PVC || 'social-monitor-sqlite-pvc'
                            }
                        }
                    ]
                }
            }
        }
    };
}

class CloudCollectorOrchestrator {
    constructor({ logger = console } = {}) {
        this.logger = logger;
        this.image = process.env.CLOUD_COLLECTOR_IMAGE || process.env.IMAGE || '';
        this.adapter = createDeployHubAdapter({ logger });
        this.namespace = process.env.DEPLOY_HUB_NAMESPACE ||
            process.env.CLOUD_COLLECTOR_NAMESPACE ||
            'g1469';
        this.adapter.namespace = this.namespace;
        logger.log('[CloudOrchestrator] Using Deploy Hub adapter');
    }

    requireEnabled() {
        if (!isCloudCollectorEnabled()) {
            throw new Error('CLOUD_COLLECTOR_ENABLED is not enabled');
        }
        if (!this.image) {
            throw new Error('CLOUD_COLLECTOR_IMAGE is required to create Deploy Hub collector components');
        }
        if (!process.env.DEPLOY_HUB_TOKEN) {
            throw new Error('DEPLOY_HUB_TOKEN is required to manage cloud collectors via Deploy Hub');
        }
    }

    buildRuntimeSpec(accountId, options = {}) {
        const parts = accountParts(accountId, options.platform);
        const deploymentName = options.deploymentName || deploymentNameFor(parts.accountId);
        const resources = options.resources || defaultResources(parts.collectorPlatform);
        const sessionPlatform = parts.collectorPlatform === 'teams-graph' ? 'teams' : parts.collectorPlatform;
        const sessionRoot = parts.collectorPlatform === 'whatsapp'
            ? path.join('/data/collector-sessions/wa', `session-${parts.accountName}`)
            : sessionDir(sessionPlatform, parts.accountName).replace(DATA_DIR, '/data');

        return {
            ...parts,
            deploymentName,
            namespace: this.namespace,
            image: options.image || this.image,
            resources,
            sessionDir: sessionRoot,
            runtimeProvider: CLOUD_RUNTIME_PROVIDER,
            desiredState: options.desiredState || 'running',
            migrationSource: options.migrationSource || null,
            extraEnv: options.extraEnv || {}
        };
    }

    async ensureRuntime(accountId, options = {}) {
        this.requireEnabled();
        const spec = this.buildRuntimeSpec(accountId, options);
        const deployment = buildDeployment({
            ...spec,
            replicas: spec.desiredState === 'stopped' ? 0 : 1
        });

        try {
            await this.adapter.applyDeployment(deployment);
            upsertCollectorRuntimeSpec(spec);
            db.prepare(`
                INSERT INTO accounts (id, platform, status, runtime_provider, runtime_desired_state, deployment_name, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
                ON CONFLICT(id) DO UPDATE SET
                    runtime_provider = excluded.runtime_provider,
                    runtime_desired_state = excluded.runtime_desired_state,
                    deployment_name = excluded.deployment_name,
                    status = CASE WHEN status IN ('authenticated','monitoring','warmup','qr') THEN status ELSE excluded.status END,
                    updated_at = datetime('now', '+8 hours')
            `).run(
                spec.accountId,
                spec.platform,
                spec.desiredState === 'stopped' ? 'stopped' : 'initializing',
                CLOUD_RUNTIME_PROVIDER,
                spec.desiredState,
                spec.deploymentName
            );
            return spec;
        } catch (err) {
            upsertCollectorRuntimeSpec({ ...spec, lastError: err.message });
            throw err;
        }
    }

    async start(accountId) {
        let spec = getCollectorRuntimeSpec(accountId);
        if (!spec) {
            await this.ensureRuntime(accountId);
            spec = getCollectorRuntimeSpec(accountId);
        } else {
            await this.ensureRuntime(accountId, { desiredState: 'running', migrationSource: spec.migration_source || 'api-runtime-start' });
        }
        return updateCollectorRuntimeDesiredState(accountId, 'running', { orchestratorState: 'starting' });
    }

    async stop(accountId) {
        const spec = getCollectorRuntimeSpec(accountId);
        if (!spec) throw new Error(`Runtime spec not found for ${accountId}`);
        await this.adapter.patchScale(spec.deployment_name, { spec: { replicas: 0 } }, [
            'scale',
            `deployment/${spec.deployment_name}`,
            '--replicas=0',
            '-n',
            this.namespace
        ]);
        return updateCollectorRuntimeDesiredState(accountId, 'stopped', { orchestratorState: 'stopped', healthStatus: 'stopped' });
    }

    async restart(accountId) {
        const spec = getCollectorRuntimeSpec(accountId);
        if (!spec) throw new Error(`Runtime spec not found for ${accountId}`);
        await this.ensureRuntime(accountId, {
            desiredState: 'running',
            migrationSource: spec.migration_source || 'api-runtime-restart',
            extraEnv: { COLLECTOR_RESTART_NONCE: new Date().toISOString() }
        });
        return updateCollectorRuntimeDesiredState(accountId, 'running', { orchestratorState: 'restarting' });
    }

    async delete(accountId) {
        const spec = getCollectorRuntimeSpec(accountId);
        if (!spec) return;
        await this.adapter.deleteDeployment(spec.deployment_name);
        deleteCollectorRuntimeSpec(accountId);
    }

    async runtimeStatus(accountId) {
        const spec = getCollectorRuntimeSpec(accountId);
        if (!spec) return null;
        let deployment = null;
        try {
            deployment = await this.adapter.readDeployment(spec.deployment_name);
        } catch (err) {
            deployment = { error: err.message };
        }
        return { spec, deployment };
    }

    clearSession(accountId) {
        const parts = accountParts(accountId);
        if (parts.collectorPlatform !== 'whatsapp') return false;
        const authPath = path.join(DATA_DIR, 'collector-sessions', 'wa', `session-${parts.accountName}`);
        fs.rmSync(authPath, { recursive: true, force: true });
        return true;
    }
}

module.exports = {
    CloudCollectorOrchestrator,
    buildDeployment,
    accountParts,
    deploymentNameFor,
    defaultResources,
    isCloudCollectorEnabled
};
