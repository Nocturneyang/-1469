'use strict';

const { createCollectorClient } = require('./collector-client');

function envFlag(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function createCollectorSink({
    baseUrl = process.env.COLLECTOR_API_URL,
    token = process.env.COLLECTOR_TOKEN,
    logger = console,
    local = {}
} = {}) {
    const remoteOnly = envFlag('COLLECTOR_REMOTE_ONLY');
    const client = createCollectorClient({ baseUrl, token, logger });

    async function callLocal(name, args) {
        if (remoteOnly) return null;
        const fn = local[name];
        if (typeof fn !== 'function') return null;
        return fn(...args);
    }

    async function callRemote(name, args) {
        if (!client || typeof client[name] !== 'function') return null;
        return client[name](...args);
    }

    return {
        remoteOnly,
        client,
        heartbeat: (payload) => Promise.all([
            callLocal('heartbeat', [payload]),
            callRemote('heartbeat', [payload])
        ]),
        event: (payload) => Promise.all([
            callLocal('event', [payload]),
            callRemote('event', [payload])
        ]),
        accountStatus: (payload) => Promise.all([
            callLocal('accountStatus', [payload]),
            callRemote('accountStatus', [payload])
        ]),
        message: async (payload) => {
            const localResult = await callLocal('message', [payload]);
            const remoteResult = await callRemote('message', [payload]);
            return remoteResult || localResult;
        },
        media: async (payload) => {
            const remoteResult = await callRemote('media', [payload]);
            if (remoteResult) return remoteResult;
            return callLocal('media', [payload]);
        },
        flushOutbox: () => client?.flushOutbox?.()
    };
}

module.exports = {
    createCollectorSink
};
