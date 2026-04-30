const Database = require('better-sqlite3');
const db = new Database('./db/database.sqlite', { readonly: true });
function getYesterdayRange() {
  const now = new Date();
  const tzOffset = 8 * 60 * 60 * 1000;
  const todayStart = new Date(
    Math.floor((now.getTime() + tzOffset) / 86400000) * 86400000 - tzOffset
  );
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  return {
    start: yesterdayStart.getTime(),
    end: todayStart.getTime() - 1
  };
}
const range = getYesterdayRange();
const activeGroups = db.prepare(`
    SELECT group_name, group_id, receiver_account,
           COUNT(*) AS msg_count
    FROM messages
    WHERE timestamp BETWEEN ? AND ?
      AND content IS NOT NULL AND content != ''
    GROUP BY group_id
    HAVING msg_count >= 5
  `).all(range.start, range.end);
console.log(Array.from(new Set(activeGroups.map(g => g.receiver_account))));
