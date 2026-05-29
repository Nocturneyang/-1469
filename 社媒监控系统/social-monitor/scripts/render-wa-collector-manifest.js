const fs = require('fs');

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
    if (!value) {
        throw new Error(`Missing --${name} or ${envName}`);
    }
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

function renderManifest(options) {
    const accountName = options.accountName;
    const componentName = safeName(`wa-collector-${accountName}`);
    const pvcName = `${componentName}-data`;
    const image = options.image;
    const apiUrl = options.apiUrl;
    const token = options.token;
    const storage = options.storage;
    const requestMemory = options.requestMemory;
    const limitMemory = options.limitMemory;
    const requestCpu = options.requestCpu;
    const limitCpu = options.limitCpu;

    return `apiVersion: v1
kind: Secret
metadata:
  name: ${componentName}-secret
type: Opaque
data:
  COLLECTOR_TOKEN: ${b64(token)}
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
      storage: ${storage}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${componentName}
  labels:
    app: ${componentName}
    app.kubernetes.io/name: social-monitor-wa-collector
    app.kubernetes.io/component: wa-collector
    app.kubernetes.io/part-of: social-monitor-wa
    wa-account: ${accountName}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${componentName}
      wa-account: ${accountName}
  template:
    metadata:
      labels:
        app: ${componentName}
        app.kubernetes.io/name: social-monitor-wa-collector
        app.kubernetes.io/component: wa-collector
        app.kubernetes.io/part-of: social-monitor-wa
        wa-account: ${accountName}
    spec:
      containers:
        - name: wa-collector
          image: ${image}
          imagePullPolicy: IfNotPresent
          env:
            - name: ACCOUNT_NAME
              value: ${JSON.stringify(accountName)}
            - name: COLLECTOR_API_URL
              value: ${JSON.stringify(apiUrl)}
            - name: COLLECTOR_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ${componentName}-secret
                  key: COLLECTOR_TOKEN
            - name: DATA_DIR
              value: /data
            - name: COLLECTOR_OUTBOX_ENABLED
              value: "true"
            - name: COLLECTOR_OUTBOX_DIR
              value: /data/collector-outbox
            - name: WA_ORCHESTRATOR_MANAGED_INIT
              value: "true"
            - name: WA_RUNTIME_ADAPTER
              value: external
          resources:
            requests:
              cpu: ${requestCpu}
              memory: ${requestMemory}
            limits:
              cpu: ${limitCpu}
              memory: ${limitMemory}
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
    const options = {
        accountName: required(args, 'account-name', 'ACCOUNT_NAME'),
        image: required(args, 'image', 'WA_COLLECTOR_IMAGE'),
        apiUrl: required(args, 'api-url', 'COLLECTOR_API_URL'),
        token: required(args, 'token', 'COLLECTOR_TOKEN'),
        storage: optional(args, 'storage', '2Gi', 'WA_COLLECTOR_STORAGE'),
        storageClassName: optional(args, 'storage-class', 'nas', 'WA_COLLECTOR_STORAGE_CLASS'),
        requestMemory: optional(args, 'request-memory', '2Gi', 'WA_COLLECTOR_REQUEST_MEMORY'),
        limitMemory: optional(args, 'limit-memory', '4Gi', 'WA_COLLECTOR_LIMIT_MEMORY'),
        requestCpu: optional(args, 'request-cpu', '500m', 'WA_COLLECTOR_REQUEST_CPU'),
        limitCpu: optional(args, 'limit-cpu', '2', 'WA_COLLECTOR_LIMIT_CPU')
    };

    const manifest = renderManifest(options);
    if (args.output) {
        fs.writeFileSync(args.output, manifest, 'utf8');
    } else {
        process.stdout.write(manifest);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(`[render-wa-collector-manifest] ${err.message}`);
        process.exit(1);
    }
}

module.exports = {
    renderManifest
};
