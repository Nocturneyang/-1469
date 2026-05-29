#!/usr/bin/env node
const { getWaChromeStats } = require('../lib/wa-chrome-runtime');

getWaChromeStats((err, stats) => {
    if (err) {
        console.error(`[WA Runtime] ${err.message}`);
        process.exit(1);
    }

    console.log(`WA Chrome total: ${stats.totalRssMb} MB / ${stats.totalProcessCount} processes`);
    if (!stats.accounts.length) {
        console.log('No WhatsApp Chrome processes found.');
        return;
    }

    console.table(stats.accounts.map(item => ({
        account: item.accountName,
        rss_mb: item.rssMb,
        processes: item.processCount,
        pids: item.pids.join(',')
    })));
});
