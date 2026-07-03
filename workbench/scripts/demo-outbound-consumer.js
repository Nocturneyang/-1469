const { DEFAULT_WORKBENCH_DB_PATH } = require('../db/workbench-db');
const { createOutboundConsumer } = require('../lib/outbound-consumer');

const platform = process.env.WORKBENCH_PLATFORM || process.argv[2] || 'wa';
const account = process.env.WORKBENCH_ACCOUNT || process.argv[3] || 'nanya_wa';
const dbPath = process.env.WORKBENCH_DB_PATH || DEFAULT_WORKBENCH_DB_PATH;

async function main() {
  const consumer = createOutboundConsumer({
    dbPath,
    platform,
    account,
    sendMessage: async (task) => {
      if (process.env.WORKBENCH_SEND_DRY_RUN !== '1') {
        throw Object.assign(new Error('demo consumer requires WORKBENCH_SEND_DRY_RUN=1'), {
          code: 'DRY_RUN_REQUIRED',
        });
      }
      return { remote_msg_id: `demo-${task.id}-${Date.now()}` };
    },
  });

  try {
    const result = await consumer.runOnce();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    consumer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
