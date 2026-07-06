'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * DeployHubRuntimeAdapter
 *
 * 通过 Deploy Hub MCP HTTP API 管理采集器 Pod 的生命周期，
 * 不依赖 K8s 直接 API 权限，不需要 RBAC 配置。
 *
 * 实现了与 K8sRuntimeAdapter 相同的接口供 CloudCollectorOrchestrator 使用：
 *   applyDeployment(manifest)
 *   deleteDeployment(deploymentName)
 *   patchScale(deploymentName, body, [kubectlArgs])
 *   patchDeployment(deploymentName, body, [kubectlArgs])
 *   readDeployment(deploymentName)
 *   listCollectors()
 */

class DeployHubMcpClient {
    constructor({ apiUrl, token, logger = console }) {
        this.apiUrl = apiUrl;
        this.token = token;
        this.logger = logger;
    }

    _parsed() {
        return new URL(this.apiUrl);
    }

    _lib() {
        return this._parsed().protocol === 'https:' ? https : http;
    }

    async _getSessionId() {
        return new Promise((resolve, reject) => {
            const p = this._parsed();
            const opts = {
                hostname: p.hostname,
                port: p.port || (p.protocol === 'https:' ? 443 : 80),
                path: p.pathname,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.token}`, 'Accept': 'text/event-stream' },
                rejectUnauthorized: false
            };
            const req = this._lib().request(opts, (res) => {
                const sid = res.headers['mcp-session-id'];
                res.resume();
                resolve(sid || null);
            });
            req.on('error', reject);
            req.end();
        });
    }

    async _postRpc(sessionId, method, params, id) {
        return new Promise((resolve, reject) => {
            const p = this._parsed();
            const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });
            const opts = {
                hostname: p.hostname,
                port: p.port || (p.protocol === 'https:' ? 443 : 80),
                path: p.pathname,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'mcp-session-id': sessionId
                },
                rejectUnauthorized: false
            };
            const req = this._lib().request(opts, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    const lines = data.trim().split('\n');
                    const dataLines = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
                    try {
                        resolve(JSON.parse(dataLines.length > 0 ? dataLines[0] : data));
                    } catch (_) {
                        resolve(data);
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    async call(toolName, args) {
        const sessionId = await this._getSessionId();
        if (!sessionId) throw new Error('DeployHub: failed to get MCP session ID');

        await this._postRpc(sessionId, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'social-monitor', version: '1.0.0' }
        }, 1);

        const resp = await this._postRpc(sessionId, 'tools/call', { name: toolName, arguments: args }, 2);

        if (resp && resp.error) throw new Error(`DeployHub ${toolName} error: ${JSON.stringify(resp.error)}`);

        const content = resp && resp.result && resp.result.content;
        if (!Array.isArray(content) || !content[0] || !content[0].text) {
            throw new Error(`DeployHub ${toolName}: unexpected response`);
        }

        try { return JSON.parse(content[0].text); } catch (_) { return content[0].text; }
    }
}

function envArrayToString(envArray) {
    if (!Array.isArray(envArray)) return '';
    return envArray
        .filter(e => e && e.name && e.value !== undefined && !e.valueFrom)
        .map(e => `${e.name}=${String(e.value !== null && e.value !== undefined ? e.value : '')}`)
        .join(',');
}

function rainbondAppName(deploymentName) {
    return String(deploymentName || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

class DeployHubRuntimeAdapter {
    constructor({ apiUrl, token, namespace, image, logger = console }) {
        this.name = 'deploy-hub';
        this.apiUrl = apiUrl;
        this.token = token;
        this.namespace = namespace;
        this.image = image;
        this.logger = logger;
        this.client = new DeployHubMcpClient({ apiUrl, token, logger });
        this.accountLabel = 'social-monitor.tyhark.com/account-id';
        this.labelSelector = 'app.kubernetes.io/component=collector';
    }

    _appName(deploymentName) {
        return rainbondAppName(deploymentName);
    }

    async _findApp(appName) {
        let result;
        try { result = await this.client.call('rainbond_list_apps', {}); } catch (_) { return null; }
        const list = Array.isArray(result) ? result : (result && (result.apps || result.data) ? result.apps || result.data : []);
        return list.find(a => ((a.app_name || a.name || '')).toLowerCase() === appName.toLowerCase()) || null;
    }

    // --- K8sRuntimeAdapter compatible interface ---

    async applyDeployment(manifest) {
        const deploymentName = manifest && manifest.metadata && manifest.metadata.name;
        if (!deploymentName) throw new Error('DeployHubAdapter applyDeployment: missing deployment name');

        const appName = this._appName(deploymentName);
        const image = (manifest.spec &&
            manifest.spec.template &&
            manifest.spec.template.spec &&
            manifest.spec.template.spec.containers &&
            manifest.spec.template.spec.containers[0] &&
            manifest.spec.template.spec.containers[0].image) || this.image;
        const envArray = (manifest.spec &&
            manifest.spec.template &&
            manifest.spec.template.spec &&
            manifest.spec.template.spec.containers &&
            manifest.spec.template.spec.containers[0] &&
            manifest.spec.template.spec.containers[0].env) || [];
        const envVars = envArrayToString(envArray);

        this.logger.log(`[DeployHubAdapter] applyDeployment: app=${appName} image=${image}`);

        const result = await this.client.call('rainbond_deploy_component', {
            app_name: appName,
            component_name: 'collector',
            image,
            namespace: this.namespace,
            env_vars: envVars,
            ports: ''
        });
        this.logger.log('[DeployHubAdapter] applyDeployment result:', JSON.stringify(result));
        return result;
    }

    async deleteDeployment(deploymentName) {
        if (!deploymentName) return { deleted: false };
        const appName = this._appName(deploymentName);
        this.logger.log(`[DeployHubAdapter] deleteDeployment: app=${appName}`);
        try {
            const result = await this.client.call('rainbond_delete_app', { app_name: appName });
            this.logger.log('[DeployHubAdapter] deleteDeployment result:', JSON.stringify(result));
            return { deleted: true };
        } catch (err) {
            const msg = String(err.message || '');
            if (msg.includes('404') || msg.includes('not found') || msg.includes('不存在')) {
                return { deleted: false };
            }
            throw err;
        }
    }

    async patchScale(deploymentName, body, _kubectlArgs) {
        const replicas = body && body.spec && body.spec.replicas;
        const appName = this._appName(deploymentName);
        this.logger.log(`[DeployHubAdapter] patchScale: app=${appName} replicas=${replicas}`);

        if (replicas === 0) {
            // 停止 = 删除组件（会话数据在 PVC 中，不会丢失）
            return this.deleteDeployment(deploymentName);
        }

        // 启动 = 更新/重建组件
        const result = await this.client.call('rainbond_deploy_component', {
            app_name: appName,
            component_name: 'collector',
            image: this.image,
            namespace: this.namespace,
            env_vars: '',
            ports: ''
        });
        return result;
    }

    async patchDeployment(deploymentName, _body, _kubectlArgs) {
        // 重启 = 触发 Deploy Hub 重新部署（滚动更新）
        const appName = this._appName(deploymentName);
        this.logger.log(`[DeployHubAdapter] patchDeployment (restart): app=${appName}`);
        return this.client.call('rainbond_deploy_component', {
            app_name: appName,
            component_name: 'collector',
            image: this.image,
            namespace: this.namespace,
            env_vars: '',
            ports: ''
        });
    }

    async readDeployment(deploymentName) {
        const appName = this._appName(deploymentName);
        const app = await this._findApp(appName);
        if (!app) {
            const err = new Error(`HTTP 404: deployment ${deploymentName} not found`);
            err.statusCode = 404;
            throw err;
        }

        let podStatus = [];
        try {
            const status = await this.client.call('rainbond_get_status', {
                app_id: app.ID || app.id || app.app_id || app.ID
            });
            podStatus = (status && (status.pod_status || status.pods)) || [];
        } catch (_) {}

        const ready = podStatus.some(p => p.ready === true);
        const phase = ready ? 'Running' : (podStatus.length > 0 ? (podStatus[0].phase || 'Pending') : 'Unknown');

        return {
            metadata: { name: deploymentName },
            spec: { replicas: 1 },
            status: {
                readyReplicas: ready ? 1 : 0,
                availableReplicas: ready ? 1 : 0,
                conditions: []
            },
            _deployhub: { appName, podStatus, phase, ready }
        };
    }

    async listCollectors() {
        let apps;
        try { apps = await this.client.call('rainbond_list_apps', {}); } catch (_) { return new Map(); }

        const list = Array.isArray(apps) ? apps : (apps && (apps.apps || apps.data) ? apps.apps || apps.data : []);
        const PREFIX = 'sm-collector-';
        const map = new Map();

        for (const app of list) {
            const appName = ((app.app_name || app.name || '')).toLowerCase();
            if (!appName.startsWith(PREFIX)) continue;

            const suffix = appName.slice(PREFIX.length); // e.g. "wa-test"
            const accountId = suffix;

            let phase = 'Unknown';
            let ready = false;
            try {
                const status = await this.client.call('rainbond_get_status', {
                    app_id: app.ID || app.id || app.app_id
                });
                const pods = (status && (status.pod_status || status.pods)) || [];
                ready = pods.some(p => p.ready === true);
                phase = pods.length > 0 ? (pods[0].phase || 'Unknown') : 'Unknown';
            } catch (_) {}

            map.set(accountId, {
                status: ready ? 'online' : 'launching',
                phase,
                ready,
                restartCount: 0,
                runtime: 'deploy-hub',
                appName
            });
        }

        return map;
    }
}

function createDeployHubAdapter({ logger = console } = {}) {
    const apiUrl = process.env.DEPLOY_HUB_API_URL || 'https://skyline-ark-deploy-hub-mcp.tyhark.com/mcp';
    const token = process.env.DEPLOY_HUB_TOKEN || '';
    const namespace = process.env.WA_K8S_NAMESPACE || process.env.CLOUD_COLLECTOR_NAMESPACE || 'g1469';
    const image = process.env.CLOUD_COLLECTOR_IMAGE || process.env.IMAGE || '';
    return new DeployHubRuntimeAdapter({ apiUrl, token, namespace, image, logger });
}

module.exports = {
    DeployHubRuntimeAdapter,
    DeployHubMcpClient,
    createDeployHubAdapter
};
