'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });

const {
    db,
    listCollectorRuntimeSpecs,
    updateCollectorRuntimeDesiredState
} = require('../db/database');
const {
    CloudCollectorOrchestrator,
    isCloudCollectorEnabled
} = require('../lib/cloud-collector-orchestrator');
const { parseShanghaiDate } = require('../lib/time');

const INTERVAL_MS = Number(process.env.CLOUD_COLLECTOR_SUPERVISOR_INTERVAL_MS || 30000);
const STALE_SECONDS = Number(process.env.CLOUD_COLLECTOR_HEARTBEAT_STALE_SECONDS || 90);
const RESTART_STALE_SECONDS = Number(process.env.CLOUD_COLLECTOR_RESTART_STALE_SECONDS || 300);
const NO_HEARTBEAT_REAPPLY_SECONDS = Number(process.env.CLOUD_COLLECTOR_NO_HEARTBEAT_REAPPLY_SECONDS || 600);

function secondsSince(value) {
    if (!value) return null;
    const ts = parseShanghaiDate(value).getTime();
    if (!Number.isFinite(ts)) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

function latestHeartbeat(accountId) {
    return db.prepare(`
        SELECT *
        FROM collector_heartbeats
        WHERE account_id = ?
        ORDER BY datetime(updated_at) DESC
        LIMIT 1
    `).get(accountId);
}

function updateAccountRuntime(accountId, patch) {
    db.prepare(`
        UPDATE accounts
        SET orchestrator_state = COALESCE(@orchestrator_state, orchestrator_state),
            health_status = COALESCE(@health_status, health_status),
            collector_phase = COALESCE(@collector_phase, collector_phase),
            collector_run_id = COALESCE(@collector_run_id, collector_run_id),
            collector_heartbeat_age_seconds = COALESCE(@collector_heartbeat_age_seconds, collector_heartbeat_age_seconds),
            last_runtime_event_at = COALESCE(@last_runtime_event_at, last_runtime_event_at),
            last_restart_reason = COALESCE(@last_restart_reason, last_restart_reason),
            last_supervisor_check_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours')
        WHERE id = @account_id
    `).run({
        account_id: accountId,
        orchestrator_state: patch.orchestratorState || null,
        health_status: patch.healthStatus || null,
        collector_phase: patch.collectorPhase || null,
        collector_run_id: patch.collectorRunId || null,
        collector_heartbeat_age_seconds: patch.heartbeatAgeSeconds ?? null,
        last_runtime_event_at: patch.lastRuntimeEventAt || null,
        last_restart_reason: patch.lastRestartReason || null
    });
}

async function reconcileSpec(orchestrator, spec) {
    const hb = latestHeartbeat(spec.account_id);
    const heartbeatAge = hb ? secondsSince(hb.updated_at) : null;
    const fresh = heartbeatAge !== null && heartbeatAge <= STALE_SECONDS;

    updateAccountRuntime(spec.account_id, {
        orchestratorState: spec.desired_state === 'stopped' ? 'stopped' : (fresh ? 'healthy' : 'stale_heartbeat'),
        healthStatus: fresh ? (hb.health_status || hb.phase || 'healthy') : 'stale_heartbeat',
        collectorPhase: hb?.phase || null,
        collectorRunId: hb?.run_id || null,
        heartbeatAgeSeconds: heartbeatAge,
        lastRuntimeEventAt: hb?.updated_at || null
    });

    if (spec.desired_state !== 'running') return;

    if (!hb) {
        const lastApplyAge = secondsSince(spec.last_applied_at || spec.updated_at);
        if (lastApplyAge !== null && lastApplyAge < NO_HEARTBEAT_REAPPLY_SECONDS) {
            updateAccountRuntime(spec.account_id, {
                orchestratorState: 'starting',
                lastRestartReason: `No heartbeat yet; last deployment ensured ${lastApplyAge}s ago`
            });
            return;
        }
        await orchestrator.ensureRuntime(spec.account_id, { migrationSource: spec.migration_source || 'supervisor' });
        updateAccountRuntime(spec.account_id, {
            orchestratorState: 'starting',
            lastRestartReason: 'No heartbeat yet; ensured cloud collector deployment'
        });
        return;
    }

    if (heartbeatAge !== null && heartbeatAge > RESTART_STALE_SECONDS) {
        await orchestrator.restart(spec.account_id);
        updateAccountRuntime(spec.account_id, {
            orchestratorState: 'restarting',
            lastRestartReason: `Heartbeat stale for ${heartbeatAge}s; rolling collector restart`
        });
    }
}

async function tick(orchestrator) {
    const specs = listCollectorRuntimeSpecs();
    for (const spec of specs) {
        try {
            await reconcileSpec(orchestrator, spec);
        } catch (err) {
            console.error(`[CloudSupervisor] reconcile failed for ${spec.account_id}:`, err.message);
            updateCollectorRuntimeDesiredState(spec.account_id, spec.desired_state, {
                lastError: err.message,
                orchestratorState: 'reconcile_error',
                healthStatus: 'reconcile_error'
            });
        }
    }
}

async function main() {
    if (!isCloudCollectorEnabled()) {
        console.log('[CloudSupervisor] CLOUD_COLLECTOR_ENABLED is disabled; supervisor parked.');
        setInterval(() => {}, 3600000);
        return;
    }

    const orchestrator = new CloudCollectorOrchestrator({ logger: console });
    console.log(`[CloudSupervisor] started; interval=${INTERVAL_MS}ms`);
    await tick(orchestrator).catch(err => console.error('[CloudSupervisor] initial tick failed:', err.message));
    setInterval(() => {
        tick(orchestrator).catch(err => console.error('[CloudSupervisor] tick failed:', err.message));
    }, INTERVAL_MS);
}

main().catch(err => {
    console.error('[CloudSupervisor] fatal:', err.message);
    process.exit(1);
});
