#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const distDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'frontend', 'dist'));
const compressible = /\.(?:js|css|html|svg|json|txt|map)$/i;
const minBytes = Number(process.env.PRECOMPRESS_MIN_BYTES || 1024);

function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(fullPath));
        } else if (
            entry.isFile() &&
            compressible.test(entry.name) &&
            !entry.name.endsWith('.br') &&
            !entry.name.endsWith('.gz')
        ) {
            out.push(fullPath);
        }
    }
    return out;
}

function writeIfSmaller(target, data, sourceSize) {
    if (data.length >= sourceSize) return false;
    fs.writeFileSync(target, data);
    return true;
}

let sourceCount = 0;
let outputCount = 0;
let rawBytes = 0;
let compressedBytes = 0;

for (const file of walk(distDir)) {
    const source = fs.readFileSync(file);
    if (source.length < minBytes) continue;

    sourceCount += 1;
    rawBytes += source.length;

    const br = zlib.brotliCompressSync(source, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        },
    });
    if (writeIfSmaller(`${file}.br`, br, source.length)) {
        outputCount += 1;
        compressedBytes += br.length;
    }

    const gz = zlib.gzipSync(source, { level: 9 });
    if (writeIfSmaller(`${file}.gz`, gz, source.length)) {
        outputCount += 1;
        compressedBytes += gz.length;
    }
}

console.log(`[precompress] scanned=${sourceCount} outputs=${outputCount} raw=${rawBytes} compressed=${compressedBytes}`);
