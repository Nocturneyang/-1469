const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('./db/database.sqlite', { readonly: true });
const range = {
    start: Date.now() - 86400000 * 2,
    end: Date.now()
};
const activeGroups = db.prepare(`
    SELECT group_name, group_id, receiver_account,
           COUNT(*) AS msg_count
    FROM messages
    WHERE timestamp BETWEEN ? AND ?
      AND content IS NOT NULL AND content != ''
    GROUP BY group_id
    HAVING msg_count >= 5
  `).all(range.start, range.end);

const accountConfig = JSON.parse(
  fs.readFileSync('./config/account-regions.json', 'utf8')
);
const REGION_MAP = Object.fromEntries(
  accountConfig.accounts.map((a) => [a.account, a])
);

function getRegionLabel(receiverAccount) {
  const info = REGION_MAP[`wa-${receiverAccount}`] ||
               REGION_MAP[`tg-${receiverAccount}`] ||
               REGION_MAP[receiverAccount];
  return info || { region: '未知区', platform: 'wa' };
}

const platforms = new Set();
for (const group of activeGroups) {
    const regionInfo = getRegionLabel(group.receiver_account);
    platforms.add(regionInfo.platform || 'wa');
}
console.log(Array.from(platforms));
