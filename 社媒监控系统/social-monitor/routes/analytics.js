const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const ANALYTICS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'db', 'analytics.sqlite');
const SOURCE_DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'db', 'database.sqlite');
let _analyticsDb = null;
let _sourceDb = null;

function getAnalyticsDb() {
    if (_analyticsDb) return _analyticsDb;
    if (!fs.existsSync(ANALYTICS_PATH)) return null;
    try {
        const Database = require('better-sqlite3');
        _analyticsDb = new Database(ANALYTICS_PATH, { readonly: true });
        return _analyticsDb;
    } catch (e) {
        console.error('[server] 无法打开 analytics.sqlite:', e.message);
        return null;
    }
}

function getSourceDb() {
    if (_sourceDb) return _sourceDb;
    if (!fs.existsSync(SOURCE_DB_PATH)) return null;
    try {
        const Database = require('better-sqlite3');
        _sourceDb = new Database(SOURCE_DB_PATH, { readonly: true });
        return _sourceDb;
    } catch (e) {
        console.error('[server] 无法打开 database.sqlite:', e.message);
        return null;
    }
}

router.get('/analytics/summary', (req, res) => {
    const adb = getAnalyticsDb();
    if (!adb) {
        return res.json({ success: true, data: { ready: false, totalAlerts: 0, p0: 0, p1: 0, openIssues: 0, closedIssues: 0, alerts: [], issueResolveRate: 0, digestCount: 0, groupsCovered: 0, assessedSuppliers: 0 } });
    }
    try {
        const p0 = adb.prepare("SELECT COUNT(*) AS c FROM alert_records WHERE alert_level='p0'").get()?.c || 0;
        const p1 = adb.prepare("SELECT COUNT(*) AS c FROM alert_records WHERE alert_level='p1'").get()?.c || 0;
        const openIssues = adb.prepare("SELECT COUNT(*) AS c FROM issue_records WHERE status='open'").get()?.c || 0;
        const closedIssues = adb.prepare("SELECT COUNT(*) AS c FROM issue_records WHERE status='closed'").get()?.c || 0;
        const totalIssues = openIssues + closedIssues;
        const issueResolveRate = totalIssues > 0 ? Math.round((closedIssues / totalIssues) * 100) : 0;
        
        let digestCount = 0;
        try {
            digestCount = adb.prepare("SELECT COUNT(*) AS c FROM daily_digests").get()?.c || 0;
        } catch (e) {
            // Table doesn't exist, keep as 0
        }
        
        let groupsCovered = 0;
        try {
            const sdb = getSourceDb();
            if (sdb) {
                groupsCovered = sdb.prepare("SELECT COUNT(DISTINCT group_name) AS c FROM messages WHERE group_name IS NOT NULL AND group_name != ''").get()?.c || 0;
            }
        } catch (e) {
            // Table doesn't exist, keep as 0
        }
        
        let assessedSuppliers = 0;
        try {
            assessedSuppliers = adb.prepare("SELECT COUNT(DISTINCT business_sector) AS c FROM supplier_profiles").get()?.c || 0;
        } catch (e) {
            // Table doesn't exist, keep as 0
        }

        const alerts = [];
        if (p0 > 0) {
            alerts.push({ level: 'P0', count: p0, platforms: 'WhatsApp, Telegram' });
        }
        if (p1 > 0) {
            alerts.push({ level: 'P1', count: p1, platforms: 'WhatsApp, Telegram, Teams' });
        }

        res.json({ 
            success: true, 
            data: { 
                ready: true,
                totalAlerts: p0 + p1,
                p0,
                p1,
                openIssues,
                closedIssues,
                alerts,
                issueResolveRate,
                digestCount,
                groupsCovered,
                assessedSuppliers
            } 
        });
    } catch (err) {
        console.error('Analytics summary error:', err);
        res.json({ success: true, data: { ready: false, totalAlerts: 0, p0: 0, p1: 0, openIssues: 0, closedIssues: 0, alerts: [], issueResolveRate: 0, digestCount: 0, groupsCovered: 0, assessedSuppliers: 0 } });
    }
});

router.get('/status', (req, res) => {
    res.json({ success: true, running: true });
});

router.get('/knowledge-base', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });

        const { keyword, sector, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let sql = 'SELECT * FROM qa_knowledge_base WHERE 1=1';
        const params = [];

        if (keyword) {
            sql += ' AND (question_summary LIKE ? OR question_keywords LIKE ? OR question_type LIKE ?)';
            const kw = `%${keyword}%`;
            params.push(kw, kw, kw);
        }
        if (sector) {
            sql += ' AND business_sector = ?';
            params.push(sector);
        }

        const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
        const { total } = adb.prepare(countSql).get(...params);

        sql += ' ORDER BY confidence DESC, frequency DESC LIMIT ? OFFSET ?';
        params.push(limitNum, offset);

        const rows = adb.prepare(sql).all(...params);

        res.json({
            success: true,
            data: rows.map(r => ({
                ...r,
                answer_steps: (r.answer_pattern || '').split('\n').filter(Boolean),
                question_keywords: (r.question_keywords || '').split(/[,，]/).map(k => k.trim()).filter(Boolean),
            })),
            total,
            page: pageNum,
            limit: limitNum,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-base/sectors', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT business_sector FROM qa_knowledge_base WHERE business_sector IS NOT NULL ORDER BY business_sector'
        ).all();
        res.json({ success: true, data: rows.map(r => r.business_sector) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/supplier-profiles/sectors', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT business_sector FROM supplier_profiles WHERE business_sector IS NOT NULL ORDER BY business_sector'
        ).all();
        res.json({ success: true, data: rows.map(r => r.business_sector) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/supplier-profiles/:groupName', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.status(503).json({ success: false, error: 'analytics 不可用' });

        const groupName = decodeURIComponent(req.params.groupName);
        const profile = adb.prepare('SELECT * FROM supplier_profiles WHERE group_name = ?').get(groupName);
        if (!profile) return res.status(404).json({ success: false, error: '供应商未找到' });

        const recentAlerts = adb.prepare(`
            SELECT alert_level, trigger_type, trigger_keywords, created_at
            FROM alert_records WHERE group_name = ? ORDER BY created_at DESC LIMIT 10
        `).all(groupName);

        const qualityMetrics = adb.prepare(`
            SELECT metric_date, metric_type, metric_value
            FROM channel_quality_metrics
            WHERE group_name = ? AND metric_date >= ?
            ORDER BY metric_date DESC, metric_type
            LIMIT 100
        `).all(groupName, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0]);

        res.json({
            success: true,
            data: {
                ...profile,
                top_issue_types: JSON.parse(profile.top_issue_types || '[]'),
                active_hours: JSON.parse(profile.active_hours || '{}'),
                ai_attitude_tags: JSON.parse(profile.ai_attitude_tags || '[]'),
                ai_insight_tags: JSON.parse(profile.ai_insight_tags || '[]'),
                ai_insight_summary: profile.ai_insight_summary || '',
                ai_sub_scores: JSON.parse(profile.ai_sub_scores || '{}'),
                ai_avg_turns: profile.ai_avg_turns,
                ai_fcr: profile.ai_fcr,
                ai_tech_contact: profile.ai_tech_contact,
                ai_tech_reply_rate: profile.ai_tech_reply_rate,
                ai_planned_maintenance_pct: profile.ai_planned_maintenance_pct,
                ai_profile_version: profile.ai_profile_version,
                recent_alerts: recentAlerts,
                quality_metrics: qualityMetrics,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/supplier-profiles', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });

        const { sector, region, sort, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let sql = 'SELECT * FROM supplier_profiles WHERE 1=1';
        const params = [];

        if (sector) { sql += ' AND business_sector = ?'; params.push(sector); }
        if (region) { sql += ' AND region = ?'; params.push(region); }

        const orderCols = {
            score: 'reliability_score DESC',
            issues: 'total_issues DESC',
            response: 'avg_response_mins ASC',
            commitment: 'commitment_rate DESC',
        };
        sql += ' ORDER BY ' + (orderCols[sort] || 'reliability_score DESC');

        const countSql = sql.replace(/SELECT \*/, 'SELECT COUNT(*) as total')
            .replace(/ ORDER BY .*/, '');
        const { total } = adb.prepare(countSql).get(...params);

        sql += ' LIMIT ? OFFSET ?';
        params.push(limitNum, offset);

        const rows = adb.prepare(sql).all(...params);

        res.json({
            success: true,
            data: rows.map(r => ({
                ...r,
                top_issue_types: JSON.parse(r.top_issue_types || '[]'),
                active_hours: JSON.parse(r.active_hours || '{}'),
            })),
            total, page: pageNum, limit: limitNum,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/device-kb', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });
        const { keyword, category, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let where = 'WHERE 1=1';
        const params = [];
        if (keyword) {
            where += ' AND (device_model LIKE ? OR fault_symptom LIKE ? OR solution_steps LIKE ?)';
            const kw = `%${keyword}%`;
            params.push(kw, kw, kw);
        }
        if (category) { where += ' AND fault_category = ?'; params.push(category); }

        const total = adb.prepare(`SELECT COUNT(*) AS c FROM device_knowledge_graph ${where}`).get(...params)?.c || 0;
        const rows = adb.prepare(
            `SELECT * FROM device_knowledge_graph ${where} ORDER BY frequency DESC, last_seen_at DESC LIMIT ? OFFSET ?`
        ).all(...params, limitNum, offset);
        res.json({ success: true, data: rows, total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/device-kb/categories', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT fault_category FROM device_knowledge_graph WHERE fault_category IS NOT NULL ORDER BY fault_category'
        ).all();
        res.json({ success: true, data: rows.map(r => r.fault_category) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/content-templates', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });
        const { keyword, customer, type, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let where = 'WHERE 1=1';
        const params = [];
        if (keyword) {
            where += ' AND (template_content LIKE ? OR compliance_notes LIKE ?)';
            const kw = `%${keyword}%`;
            params.push(kw, kw);
        }
        if (customer) { where += ' AND customer_name = ?'; params.push(customer); }
        if (type) { where += ' AND template_type = ?'; params.push(type); }

        const total = adb.prepare(`SELECT COUNT(*) AS c FROM content_template_lib ${where}`).get(...params)?.c || 0;
        const rows = adb.prepare(
            `SELECT * FROM content_template_lib ${where} ORDER BY frequency DESC, last_seen_at DESC LIMIT ? OFFSET ?`
        ).all(...params, limitNum, offset);
        res.json({ success: true, data: rows, total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/content-templates/customers', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT customer_name FROM content_template_lib WHERE customer_name IS NOT NULL ORDER BY customer_name'
        ).all();
        res.json({ success: true, data: rows.map(r => r.customer_name) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Daily Digest API
router.get('/daily-digest', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: { digests: [], trend: null, regions: [], sectors: [] } });

        const { date, region, sector } = req.query;
        
        // Helper function to normalize date format to match database format (YYYY-M-D)
        function normalizeDate(dateStr) {
            if (!dateStr) return dateStr;
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        }
        
        // If no date specified, get the most recent date from database
        let targetDate = date;
        if (!targetDate) {
            const latestDate = adb.prepare('SELECT digest_date FROM daily_digests ORDER BY digest_date DESC LIMIT 1').get();
            if (latestDate) {
                targetDate = latestDate.digest_date;
            }
        }
        
        let sql = 'SELECT * FROM daily_digests WHERE 1=1';
        const params = [];
        
        if (targetDate) {
            sql += ' AND digest_date = ?';
            params.push(targetDate);
        }
        
        if (region) {
            sql += ' AND region = ?';
            params.push(region);
        }
        
        if (sector) {
            sql += ' AND business_sector = ?';
            params.push(sector);
        }
        
        sql += ' ORDER BY digest_date DESC, business_sector, msg_count DESC';
        
        const digests = adb.prepare(sql).all(...params);
        
        // Parse JSON fields
        const parsedDigests = digests.map(d => ({
            ...d,
            key_points: JSON.parse(d.key_points || '[]'),
            follow_up: JSON.parse(d.follow_up || '[]'),
        }));
        
        // Calculate trend for selected date
        let trend = null;
        if (targetDate) {
            // Parse the target date to calculate previous dates
            const targetDateObj = new Date(targetDate);
            const prevDateObj = new Date(targetDateObj.getTime() - 24 * 60 * 60 * 1000);
            const weekDateObj = new Date(targetDateObj.getTime() - 7 * 24 * 60 * 60 * 1000);
            
            const prevDate = normalizeDate(prevDateObj.toISOString().split('T')[0]);
            const weekDate = normalizeDate(weekDateObj.toISOString().split('T')[0]);
            
            // Build trend query with same filters as main query
            let trendSql = 'SELECT SUM(msg_count) as total FROM daily_digests WHERE digest_date = ?';
            const trendParams = [targetDate];
            
            if (region) {
                trendSql += ' AND region = ?';
                trendParams.push(region);
            }
            
            if (sector) {
                trendSql += ' AND business_sector = ?';
                trendParams.push(sector);
            }
            
            const currentTotal = adb.prepare(trendSql).get(...trendParams)?.total || 0;
            
            // Previous day trend
            let prevTrendSql = trendSql.replace('?', '?', 1);
            const prevTrendParams = [prevDate];
            if (region) prevTrendParams.push(region);
            if (sector) prevTrendParams.push(sector);
            const prevTotal = adb.prepare(prevTrendSql).get(...prevTrendParams)?.total || 0;
            
            // Last week trend
            let weekTrendSql = trendSql.replace('?', '?', 1);
            const weekTrendParams = [weekDate];
            if (region) weekTrendParams.push(region);
            if (sector) weekTrendParams.push(sector);
            const weekTotal = adb.prepare(weekTrendSql).get(...weekTrendParams)?.total || 0;
            
            const trendPrevDay = prevTotal > 0 ? ((currentTotal - prevTotal) / prevTotal * 100).toFixed(0) : null;
            const trendLastWeek = weekTotal > 0 ? ((currentTotal - weekTotal) / weekTotal * 100).toFixed(0) : null;
            
            trend = {
                yesterdayTotal: currentTotal,
                prevDayCount: prevTotal,
                lastWeekCount: weekTotal,
                trendPrevDay,
                trendLastWeek
            };
        }
        
        // Get available regions and sectors
        const regions = adb.prepare('SELECT DISTINCT region FROM daily_digests WHERE region IS NOT NULL ORDER BY region').all().map(r => r.region);
        const sectors = adb.prepare('SELECT DISTINCT business_sector FROM daily_digests WHERE business_sector IS NOT NULL ORDER BY business_sector').all().map(r => r.business_sector);
        
        // Get available dates - sort by date value instead of string
        const allDates = adb.prepare('SELECT DISTINCT digest_date FROM daily_digests').all().map(r => r.digest_date);
        // Sort dates properly by parsing them
        const dates = allDates.sort((a, b) => {
            const [yearA, monthA, dayA] = a.split('-').map(Number);
            const [yearB, monthB, dayB] = b.split('-').map(Number);
            const dateA = new Date(yearA, monthA - 1, dayA);
            const dateB = new Date(yearB, monthB - 1, dayB);
            return dateB - dateA;
        }).slice(0, 7);
        
        res.json({
            success: true,
            data: {
                digests: parsedDigests,
                trend,
                regions,
                sectors,
                dates,
                selectedDate: targetDate || dates[0] || null
            }
        });
    } catch (err) {
        console.error('Daily digest API error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
module.exports.getAnalyticsDb = getAnalyticsDb;
