const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const { shanghaiISOString } = require('../time');

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function sanitizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

function podReady(pod) {
    return Boolean((pod.status?.conditions || []).find(condition => condition.type === 'Ready' && condition.status === 'True'));
}

function podStatus(pod) {
    const phase = pod.status?.phase || 'Unknown';
    const statuses = pod.status?.containerStatuses || [];
    const waiting = statuses.find(status => status.state?.waiting);
    const terminated = statuses.find(status => status.state?.terminated);

    if (waiting) {
        const reason = waiting.state.waiting.reason || 'Waiting';
        if (['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'].includes(reason)) return 'errored';
        return 'launching';
    }
    if (terminated && terminated.state.terminated.exitCode !== 0) return 'errored';
    if (phase === 'Running' && podReady(pod)) return 'online';
    if (phase === 'Pending') return 'launching';
    if (phase === 'Succeeded') return 'stopped';
    if (phase === 'Failed') return 'errored';
    return 'unknown';
}

function mergeStatus(current, next) {
    const priority = ['errored', 'online', 'launching', 'stopped', 'unknown', 'missing'];
    const currentIndex = priority.indexOf(current);
    const nextIndex = priority.indexOf(next);
    if (currentIndex === -1) return next;
    if (nextIndex === -1) return current;
    return nextIndex < currentIndex ? next : current;
}

class K8sRuntimeAdapter {
    constructor({ logger = console } = {}) {
        this.name = 'k8s';
        this.logger = logger;
        this.clientMode = (process.env.WA_K8S_CLIENT || 'auto').trim().toLowerCase();
        this.namespace = process.env.WA_K8S_NAMESPACE || process.env.K8S_NAMESPACE || 'default';
        this.labelSelector = process.env.WA_K8S_LABEL_SELECTOR || 'app.kubernetes.io/part-of=social-monitor-wa';
        this.accountLabel = process.env.WA_K8S_ACCOUNT_LABEL || 'wa-account';
        this.deploymentPrefix = process.env.WA_K8S_DEPLOYMENT_PREFIX || 'wa-collector-';
        this.deploymentMap = parseJson(process.env.WA_K8S_DEPLOYMENT_MAP || '{}', {});
        this.apiConfig = this.loadApiConfig();
    }

    workerName(accountName) {
        return this.deploymentName(accountName);
    }

    deploymentName(accountName) {
        return this.deploymentMap[accountName] || `${this.deploymentPrefix}${sanitizeName(accountName)}`;
    }

    async listCollectors() {
        const [pods, deployments] = await Promise.all([
            this.readPods(),
            this.readDeployments()
        ]);
        const map = new Map();

        for (const deployment of deployments.items || []) {
            const accountName = deployment.metadata?.labels?.[this.accountLabel];
            if (!accountName) continue;
            const available = Number(deployment.status?.availableReplicas || 0);
            const desired = Number(deployment.spec?.replicas || 0);
            map.set(accountName, {
                runtime: this.name,
                name: deployment.metadata?.name || this.deploymentName(accountName),
                status: desired === 0 ? 'stopped' : (available > 0 ? 'online' : 'launching'),
                mode: 'deployment',
                pid: 0,
                restartCount: 0,
                uptimeSeconds: 0
            });
        }

        for (const pod of pods.items || []) {
            const accountName = pod.metadata?.labels?.[this.accountLabel];
            if (!accountName) continue;
            const existing = map.get(accountName) || {
                runtime: this.name,
                name: pod.metadata?.name || this.deploymentName(accountName),
                status: 'missing',
                mode: 'pod',
                pid: 0,
                restartCount: 0,
                uptimeSeconds: 0
            };
            const restarts = (pod.status?.containerStatuses || []).reduce((sum, item) => sum + Number(item.restartCount || 0), 0);
            const startTime = pod.status?.startTime ? new Date(pod.status.startTime).getTime() : 0;
            const uptimeSeconds = startTime ? Math.max(0, Math.round((Date.now() - startTime) / 1000)) : existing.uptimeSeconds;

            map.set(accountName, {
                ...existing,
                name: existing.name || pod.metadata?.name,
                status: mergeStatus(existing.status, podStatus(pod)),
                mode: 'deployment',
                restartCount: Math.max(existing.restartCount || 0, restarts),
                uptimeSeconds: Math.max(existing.uptimeSeconds || 0, uptimeSeconds)
            });
        }

        return map;
    }

    restartCollector(accountName) {
        const deployment = this.deploymentName(accountName);
        const body = {
            spec: {
                template: {
                    metadata: {
                        annotations: {
                            'kubectl.kubernetes.io/restartedAt': shanghaiISOString()
                        }
                    }
                }
            }
        };
        return this.patchDeployment(deployment, body, [
            'rollout',
            'restart',
            `deployment/${deployment}`,
            '-n',
            this.namespace
        ]);
    }

    startCollector(accountName) {
        const deployment = this.deploymentName(accountName);
        return this.patchScale(deployment, { spec: { replicas: 1 } }, [
            'scale',
            `deployment/${deployment}`,
            '--replicas=1',
            '-n',
            this.namespace
        ]);
    }

    async readPods() {
        const path = `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/pods?labelSelector=${encodeURIComponent(this.labelSelector)}`;
        return this.readJson(path, ['get', 'pods', '-n', this.namespace, '-l', this.labelSelector, '-o', 'json']);
    }

    async readDeployments() {
        const path = `/apis/apps/v1/namespaces/${encodeURIComponent(this.namespace)}/deployments?labelSelector=${encodeURIComponent(this.labelSelector)}`;
        return this.readJson(path, ['get', 'deployments', '-n', this.namespace, '-l', this.labelSelector, '-o', 'json']);
    }

    async readJson(apiPath, kubectlArgs) {
        if (this.clientMode === 'api' && !this.apiConfig) {
            this.logger.error('[WA RuntimeAdapter:k8s] WA_K8S_CLIENT=api but in-cluster API config is unavailable');
            return { items: [] };
        }
        if (this.shouldUseApi()) {
            try {
                return await this.k8sRequest('GET', apiPath);
            } catch (err) {
                if (this.clientMode === 'api') {
                    this.logger.error(`[WA RuntimeAdapter:k8s] API ${apiPath} failed:`, err.message);
                    return { items: [] };
                }
                this.logger.warn(`[WA RuntimeAdapter:k8s] API ${apiPath} failed, fallback to kubectl: ${err.message}`);
            }
        }
        return this.kubectlJson(kubectlArgs);
    }

    async patchDeployment(deployment, body, kubectlArgs) {
        const path = `/apis/apps/v1/namespaces/${encodeURIComponent(this.namespace)}/deployments/${encodeURIComponent(deployment)}`;
        return this.patchResource(path, body, kubectlArgs, 'application/strategic-merge-patch+json');
    }

    async patchScale(deployment, body, kubectlArgs) {
        const path = `/apis/apps/v1/namespaces/${encodeURIComponent(this.namespace)}/deployments/${encodeURIComponent(deployment)}/scale`;
        return this.patchResource(path, body, kubectlArgs, 'application/merge-patch+json');
    }

    async patchResource(apiPath, body, kubectlArgs, contentType) {
        if (this.clientMode === 'api' && !this.apiConfig) {
            throw new Error('WA_K8S_CLIENT=api but in-cluster API config is unavailable');
        }
        if (this.shouldUseApi()) {
            try {
                await this.k8sRequest('PATCH', apiPath, body, contentType);
                return 'ok';
            } catch (err) {
                if (this.clientMode === 'api') throw err;
                this.logger.warn(`[WA RuntimeAdapter:k8s] API PATCH ${apiPath} failed, fallback to kubectl: ${err.message}`);
            }
        }
        return this.kubectl(kubectlArgs);
    }

    shouldUseApi() {
        return this.clientMode !== 'kubectl' && Boolean(this.apiConfig);
    }

    loadApiConfig() {
        if (this.clientMode === 'kubectl') return null;
        const host = process.env.KUBERNETES_SERVICE_HOST;
        const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || '443';
        const tokenPath = process.env.K8S_SERVICEACCOUNT_TOKEN || `${SERVICE_ACCOUNT_DIR}/token`;
        const namespacePath = `${SERVICE_ACCOUNT_DIR}/namespace`;
        const caPath = process.env.K8S_SERVICEACCOUNT_CA || `${SERVICE_ACCOUNT_DIR}/ca.crt`;

        if (!host || !fs.existsSync(tokenPath)) return null;

        try {
            const token = fs.readFileSync(tokenPath, 'utf8').trim();
            const ca = fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined;
            if (!process.env.WA_K8S_NAMESPACE && fs.existsSync(namespacePath)) {
                this.namespace = fs.readFileSync(namespacePath, 'utf8').trim() || this.namespace;
            }
            return {
                baseUrl: `https://${host}:${port}`,
                token,
                ca
            };
        } catch (err) {
            this.logger.warn('[WA RuntimeAdapter:k8s] Failed to load in-cluster API config:', err.message);
            return null;
        }
    }

    k8sRequest(method, apiPath, body = null, contentType = 'application/json') {
        return new Promise((resolve, reject) => {
            const url = new URL(apiPath, this.apiConfig.baseUrl);
            const payload = body ? JSON.stringify(body) : null;
            const req = https.request(url, {
                method,
                ca: this.apiConfig.ca,
                rejectUnauthorized: process.env.WA_K8S_INSECURE_SKIP_TLS_VERIFY === 'true' ? false : true,
                timeout: Number(process.env.WA_K8S_COMMAND_TIMEOUT_MS || 15000),
                headers: {
                    Authorization: `Bearer ${this.apiConfig.token}`,
                    Accept: 'application/json',
                    ...(payload ? {
                        'Content-Type': contentType,
                        'Content-Length': Buffer.byteLength(payload)
                    } : {})
                }
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
                    }
                    resolve(parseJson(text, {}));
                });
            });
            req.on('timeout', () => req.destroy(new Error('Kubernetes API request timed out')));
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    kubectlJson(args) {
        return this.kubectl(args)
            .then(output => parseJson(output, { items: [] }))
            .catch(err => {
                this.logger.error(`[WA RuntimeAdapter:k8s] kubectl ${args.join(' ')} failed:`, err.message);
                return { items: [] };
            });
    }

    kubectl(args) {
        return new Promise((resolve, reject) => {
            execFile(process.env.KUBECTL_BIN || 'kubectl', args, {
                timeout: Number(process.env.WA_K8S_COMMAND_TIMEOUT_MS || 15000),
                maxBuffer: 8 * 1024 * 1024
            }, (err, stdout, stderr) => {
                if (err) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    return reject(err);
                }
                resolve(stdout);
            });
        });
    }
}

module.exports = {
    K8sRuntimeAdapter
};
