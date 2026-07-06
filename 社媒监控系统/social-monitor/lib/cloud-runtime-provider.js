'use strict';

const CLOUD_RUNTIME_PROVIDER = 'deploy-hub';
const LEGACY_CLOUD_RUNTIME_PROVIDERS = new Set([
    CLOUD_RUNTIME_PROVIDER,
    'deployhub',
    'rainbond',
    'k8s',
    'kubernetes'
]);

function normalizeRuntimeProvider(value) {
    const provider = String(value || '').trim().toLowerCase();
    if (provider === 'deployhub') return CLOUD_RUNTIME_PROVIDER;
    if (provider === 'rainbond' || provider === 'k8s' || provider === 'kubernetes') {
        return CLOUD_RUNTIME_PROVIDER;
    }
    return provider || '';
}

function isCloudRuntimeProvider(value) {
    return LEGACY_CLOUD_RUNTIME_PROVIDERS.has(String(value || '').trim().toLowerCase());
}

module.exports = {
    CLOUD_RUNTIME_PROVIDER,
    isCloudRuntimeProvider,
    normalizeRuntimeProvider
};
