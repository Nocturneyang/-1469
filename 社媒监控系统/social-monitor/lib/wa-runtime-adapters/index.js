const { Pm2RuntimeAdapter } = require('./pm2-runtime-adapter');
const { createDeployHubAdapter } = require('./deploy-hub-runtime-adapter');

function createRuntimeAdapter(options = {}) {
    const adapterName = (process.env.WA_RUNTIME_ADAPTER || 'pm2').trim().toLowerCase();

    if (adapterName === 'pm2') {
        return new Pm2RuntimeAdapter(options);
    }
    if (adapterName === 'deploy-hub' || adapterName === 'deployhub' || adapterName === 'rainbond') {
        return createDeployHubAdapter(options);
    }
    if (adapterName === 'k8s' || adapterName === 'kubernetes') {
        throw new Error('WA_RUNTIME_ADAPTER=k8s is deprecated; use WA_RUNTIME_ADAPTER=deploy-hub');
    }

    throw new Error(`Unsupported WA_RUNTIME_ADAPTER: ${adapterName}`);
}

module.exports = {
    createRuntimeAdapter
};
