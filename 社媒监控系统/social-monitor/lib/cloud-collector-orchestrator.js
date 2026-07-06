'use strict';

const fs = require('fs');
const path = require('path');
const { K8sRuntimeAdapter } = require('./wa-runtime-adapters/k8s-runtime-adapter');
const { createDeployHubAdapter } = require('./wa-runtime-adapters/deploy-hub-runtime-adapter');
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

function sanitizeK8sName(value) {
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
    return sanitizeK8sName(`${process.env.CLOUD_COLLECTOR_DEPLOYMENT_PREFIX || 'sm-collector-'}${accountId}`);
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
        envValue('COLLECTOR_ID', `k8s:${parts.accountId}`),
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
        base.push(
            envValue('TG_ACCOUNT_NAME', parts.accountName),
            envValue('TG_COLLECTOR_TYPE', 'bot')
        );
    } else if (parts.collectorPlatform === 'telegram-user') {
        base.push(
            envValue('TG_ACCOUNT_NAME', parts.accountName),
            envValue('TG_COLLECTOR_TYPE', 'user')
        );
    } else if (parts.collectorPlatform === 'teams-graph') {
        base.push(envValue('ACCOUNT_NAME', parts.accountName));
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

        // 优先使用 Deploy Hub 适配器（不需要 K8s RBAC）；
        // 当 DEPLOY_HUB_TOKEN 有值时自动启用。
        if (process.env.DEPLOY_HUB_TOKEN) {
            this.adapter = createDeployHubAdapter({ logger });
            this.namespace = process.env.CLOUD_COLLECTOR_NAMESPACE ||
                process.env.WA_K8S_NAMESPACE || 'g1469';
            logger.log('[CloudOrchestrator] Using DeployHub adapter (no RBAC required)');
        } else {
            this.adapter = new K8sRuntimeAdapter({ logger });
            this.namespace = process.env.CLOUD_COLLECTOR_NAMESPACE || this.adapter.namespace;
            this.adapter.namespace = this.namespace;
            logger.log('[CloudOrchestrator] Using K8s direct API adapter');
        }
    }

    requireEnabled() {
        if (!isCloudCollectorEnabled()) {
            throw new Error('CLOUD_COLLECTOR_ENABLED is not enabled');
        }
        if (!this.image) {
            throw new Error('CLOUD_COLLECTOR_IMAGE is required to create cloud collector deployments');
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
                VALUES (?, ?, ?, 'k8s', ?, ?, datetime('now', '+8 hours'))
                ON CONFLICT(id) DO UPDATE SET
                    runtime_provider = 'k8s',
                    runtime_desired_state = excluded.runtime_desired_state,
                    deployment_name = excluded.deployment_name,
                    status = CASE WHEN status IN ('authenticated','monitoring','warmup','qr') THEN status ELSE excluded.status END,
                    updated_at = datetime('now', '+8 hours')
            `).run(spec.accountId, spec.platform, spec.desiredState === 'stopped' ? 'stopped' : 'initializing', spec.desiredState, spec.deploymentName);
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
        }
        await this.adapter.patchScale(spec.deployment_name, { spec: { replicas: 1 } }, [
            'scale',
            `deployment/${spec.deployment_name}`,
            '--replicas=1',
            '-n',
            this.namespace
        ]);
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
        await this.adapter.patchDeployment(spec.deployment_name, {
            spec: {
                template: {
                    metadata: {
                        annotations: {
                            'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
                        }
                    }
                }
            }
        }, [
            'rollout',
            'restart',
            `deployment/${spec.deployment_name}`,
            '-n',
            this.namespace
        ]);
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
