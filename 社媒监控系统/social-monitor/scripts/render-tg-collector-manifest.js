const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

function required(args, name, envName = name.toUpperCase().replace(/-/g, '_')) {
    const value = args[name] || process.env[envName];
    if (!value) throw new Error(`Missing --${name} or ${envName}`);
    return String(value);
}

function optional(args, name, fallback, envName = name.toUpperCase().replace(/-/g, '_')) {
    return String(args[name] || process.env[envName] || fallback);
}

function safeName(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function b64(value) {
    return Buffer.from(String(value), 'utf8').toString('base64');
}

function secretKeyForSession(accountName) {
    return `TG_USER_SESSION_${String(accountName).toUpperCase()}`;
}

function renderManifest(options) {
    const accountName = options.accountName;
    const componentName = safeName(`tg-collector-${accountName}`);
    const pvcName = `${componentName}-data`;
    const secretName = `${componentName}-secret`;
    const image = options.image;
    const type = options.type;
    const userSecretData = type === 'user'
        ? `  TG_API_ID: ${b64(options.apiId || '')}
  TG_API_HASH: ${b64(options.apiHash || '')}
  ${secretKeyForSession(accountName)}: ${b64(options.session || '')}`
        : `  TG_BOT_TOKEN: ${b64(options.botToken || '')}`;
    const userEnv = type === 'user'
        ? `            - name: TG_API_ID
              valueFrom:
                secretKeyRef:
                  name: ${secretName}
                  key: TG_API_ID
                  optional: true
            - name: TG_API_HASH
              valueFrom:
                secretKeyRef:
                  name: ${secretName}
                  key: TG_API_HASH
                  optional: true
            - name: ${secretKeyForSession(accountName)}
              valueFrom:
                secretKeyRef:
                  name: ${secretName}
                  key: ${secretKeyForSession(accountName)}
                  optional: true`
        : `            - name: TG_BOT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ${secretName}
                  key: TG_BOT_TOKEN
                  optional: true`;

    return `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
type: Opaque
data:
  COLLECTOR_TOKEN: ${b64(options.token)}
${userSecretData}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
spec:
  storageClassName: ${options.storageClassName}
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${options.storage}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${componentName}
  labels:
    app: ${componentName}
    app.kubernetes.io/name: social-monitor-tg-collector
    app.kubernetes.io/component: tg-collector
    app.kubernetes.io/part-of: social-monitor-tg
    tg-account: ${accountName}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${componentName}
      tg-account: ${accountName}
  template:
    metadata:
      labels:
        app: ${componentName}
        app.kubernetes.io/name: social-monitor-tg-collector
        app.kubernetes.io/component: tg-collector
        app.kubernetes.io/part-of: social-monitor-tg
        tg-account: ${accountName}
    spec:
      containers:
        - name: tg-collector
          image: ${image}
          imagePullPolicy: IfNotPresent
          env:
            - name: TG_ACCOUNT_NAME
              value: ${JSON.stringify(accountName)}
            - name: TG_COLLECTOR_TYPE
              value: ${JSON.stringify(type)}
            - name: COLLECTOR_API_URL
              value: ${JSON.stringify(options.apiUrl)}
            - name: COLLECTOR_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ${secretName}
                  key: COLLECTOR_TOKEN
${userEnv}
            - name: DATA_DIR
              value: /data
            - name: COLLECTOR_OUTBOX_ENABLED
              value: "true"
            - name: COLLECTOR_OUTBOX_DIR
              value: /data/collector-outbox
            - name: TG_WARMUP_SECONDS
              value: ${JSON.stringify(options.warmupSeconds)}
            - name: TG_DAILY_LIMIT
              value: ${JSON.stringify(options.dailyLimit)}
            - name: TG_BATCH_SIZE
              value: ${JSON.stringify(options.batchSize)}
            - name: TG_SLEEP_MIN_MS
              value: ${JSON.stringify(options.sleepMinMs)}
            - name: TG_SLEEP_MAX_MS
              value: ${JSON.stringify(options.sleepMaxMs)}
            - name: TG_BACKFILL_DAYS
              value: ${JSON.stringify(options.backfillDays)}
            - name: TG_ENABLE_BACKFILL
              value: ${JSON.stringify(options.enableBackfill)}
          resources:
            requests:
              cpu: ${options.requestCpu}
              memory: ${options.requestMemory}
            limits:
              cpu: ${options.limitCpu}
              memory: ${options.limitMemory}
          volumeMounts:
            - name: collector-data
              mountPath: /data
      volumes:
        - name: collector-data
          persistentVolumeClaim:
            claimName: ${pvcName}
`;
}

function main() {
    const args = parseArgs(process.argv);
    const accountName = required(args, 'account-name', 'TG_ACCOUNT_NAME');
    const type = String(args.type || 'user').toLowerCase();
    const accountKey = accountName.toUpperCase().replace(/-/g, '_');
    const options = {
        accountName,
        image: required(args, 'image', 'TG_COLLECTOR_IMAGE'),
        apiUrl: required(args, 'api-url', 'COLLECTOR_API_URL'),
        token: required(args, 'token', 'COLLECTOR_TOKEN'),
        type,
        apiId: args['api-id'] || process.env[`TG_API_ID_${accountKey}`] || process.env.TG_API_ID || '',
        apiHash: args['api-hash'] || process.env[`TG_API_HASH_${accountKey}`] || process.env.TG_API_HASH || '',
        session: optional(args, 'session', '', secretKeyForSession(accountName)),
        botToken: optional(args, 'bot-token', '', 'TG_BOT_TOKEN'),
        storage: optional(args, 'storage', '1Gi', 'TG_COLLECTOR_STORAGE'),
        storageClassName: optional(args, 'storage-class', 'nas', 'TG_COLLECTOR_STORAGE_CLASS'),
        requestMemory: optional(args, 'request-memory', '256Mi', 'TG_COLLECTOR_REQUEST_MEMORY'),
        limitMemory: optional(args, 'limit-memory', '768Mi', 'TG_COLLECTOR_LIMIT_MEMORY'),
        requestCpu: optional(args, 'request-cpu', '100m', 'TG_COLLECTOR_REQUEST_CPU'),
        limitCpu: optional(args, 'limit-cpu', '1', 'TG_COLLECTOR_LIMIT_CPU'),
        warmupSeconds: optional(args, 'warmup-seconds', '600', 'TG_WARMUP_SECONDS'),
        dailyLimit: optional(args, 'daily-limit', '2000', 'TG_DAILY_LIMIT'),
        batchSize: optional(args, 'batch-size', '100', 'TG_BATCH_SIZE'),
        sleepMinMs: optional(args, 'sleep-min-ms', '3000', 'TG_SLEEP_MIN_MS'),
        sleepMaxMs: optional(args, 'sleep-max-ms', '8000', 'TG_SLEEP_MAX_MS'),
        backfillDays: optional(args, 'backfill-days', '0', 'TG_BACKFILL_DAYS'),
        enableBackfill: optional(args, 'enable-backfill', 'true', 'TG_ENABLE_BACKFILL')
    };

    if (type === 'user' && (!options.apiId || !options.apiHash || !options.session)) {
        throw new Error(`TG user collector ${accountName} requires TG_API_ID, TG_API_HASH and ${secretKeyForSession(accountName)}`);
    }
    if (type === 'bot' && !options.botToken) {
        throw new Error(`TG bot collector ${accountName} requires TG_BOT_TOKEN`);
    }

    const manifest = renderManifest(options);
    if (args.output) fs.writeFileSync(args.output, manifest, 'utf8');
    else process.stdout.write(manifest);
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(`[render-tg-collector-manifest] ${err.message}`);
        process.exit(1);
    }
}

module.exports = {
    renderManifest
};
