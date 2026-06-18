#!/usr/bin/env node
'use strict';

const { db } = require('../db/database');

function hasFlag(name) {
  return process.argv.includes(name);
}

function main() {
  const execute = hasFlag('--execute');
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN media_path IS NOT NULL AND media_path != '' THEN 1 ELSE 0 END) AS with_path
    FROM messages
    WHERE has_media = 1
       OR (media_path IS NOT NULL AND media_path != '')
  `).get();

  const total = Number(row?.total || 0);
  const withPath = Number(row?.with_path || 0);

  if (!execute) {
    console.log(`Media references: ${total}, with_path=${withPath}`);
    console.log('Dry-run only. Re-run with --execute to clear has_media/media_path.');
    return;
  }

  const info = db.prepare(`
    UPDATE messages
    SET has_media = 0,
        media_path = NULL
    WHERE has_media = 1
       OR (media_path IS NOT NULL AND media_path != '')
  `).run();

  console.log(`Cleared media references: ${info.changes}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[clear-media-references] ${err.message}`);
    process.exit(1);
  }
}
