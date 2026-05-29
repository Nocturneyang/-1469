const { Pm2RuntimeAdapter } = require('./pm2-runtime-adapter');
const { K8sRuntimeAdapter } = require('./k8s-runtime-adapter');

function createRuntimeAdapter(options = {}) {
    const adapterName = (process.env.WA_RUNTIME_ADAPTER || 'pm2').trim().toLowerCase();

    if (adapterName === 'pm2') {
        return new Pm2RuntimeAdapter(options);
    }
    if (adapterName === 'k8s' || adapterName === 'kubernetes' || adapterName === 'rainbond') {
        return new K8sRuntimeAdapter(options);
    }

    throw new Error(`Unsupported WA_RUNTIME_ADAPTER: ${adapterName}`);
}

module.exports = {
    createRuntimeAdapter
};
