// Dashboard.jsx — / route (全盘态势)
const { useState, useEffect } = React;

function Dashboard() {
  const [stats, setStats] = useState({ total: 142308, wa: 88142, tg: 42016, tgu: 9820, media: 12150 });
  useEffect(() => {
    const t = setInterval(() => setStats(s => ({
      ...s,
      total: s.total + Math.floor(Math.random() * 12) + 1,
      wa: s.wa + Math.floor(Math.random() * 6),
      tg: s.tg + Math.floor(Math.random() * 4),
    })), 2200);
    return () => clearInterval(t);
  }, []);

  const alerts = [
    { lvl: "P0", text: "深圳·锐讯通信网络服务 · 网关延迟 > 12 分钟", time: "16:32",  group: "支付通道运维" },
    { lvl: "P1", text: "OTP 通道兑现率跌至 78% (近 1h)",          time: "16:18",  group: "Customer · OTP" },
    { lvl: "P1", text: "tgu-user03 触发频控保护,自动降速",         time: "15:55",  group: "TG 个人号" },
    { lvl: "P1", text: "Teams Session 失效 · teams_01",            time: "15:32",  group: "Teams" },
  ];
  const closedRecent = [
    { id: 1, supplier: "上海·盈通信息", text: "API 网关 504 故障 · 已切节点", time: "15:08", mttr: "12min" },
    { id: 2, supplier: "广州·星辰云",   text: "OTP 通道补量完成 · 12,400 条", time: "14:21", mttr: "47min" },
    { id: 3, supplier: "深圳·锐讯通信", text: "设备 SN-A341 重启完成",       time: "13:55", mttr: "6min"  },
  ];

  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">📡</span> 数据采集吞吐量</span>
          <span className="hint">滚动窗口 24h · 自动 10s 刷新 · 4 个采集终端在线</span>
        </div>
        <div className="grid-4">
          <div className="stat-card color-p">
            <div className="stat-lbl">实时总入库数</div>
            <div className="stat-val">{stats.total.toLocaleString()}</div>
            <div className="stat-foot"><span className="up">↑ 18.4%</span> 较昨日同时段</div>
          </div>
          <div className="stat-card color-wa">
            <div className="stat-lbl">WhatsApp 规模</div>
            <div className="stat-val">{stats.wa.toLocaleString()}</div>
            <div className="stat-foot"><span className="up">↑ 1,203</span> · 24h</div>
          </div>
          <div className="stat-card color-tg">
            <div className="stat-lbl">Telegram 规模</div>
            <div className="stat-val">{stats.tg.toLocaleString()}</div>
            <div className="stat-foot"><span className="up">↑ 480</span> · 24h</div>
          </div>
          <div className="stat-card color-m">
            <div className="stat-lbl">含媒体附件数</div>
            <div className="stat-val">{stats.media.toLocaleString()}</div>
            <div className="stat-foot"><span className="down">↓ 86</span> · 24h</div>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "5fr 4fr", gap: 24 }}>
        <div className="panel">
          <div className="panel-title">
            <span className="title-text"><span className="panel-icon">🚨</span> 实时告警流</span>
            <span className="hint">P0 · P1 自动路由至区域负责人</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {alerts.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px",
                                    background: "#fff", border: "1px solid var(--border)", borderRadius: 14 }}>
                <span className={"tag " + (a.lvl === "P0" ? "p0" : "p1")} style={{ fontSize: 10, minWidth: 32, justifyContent: "center" }}>{a.lvl}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "var(--t)", fontWeight: 600, marginBottom: 2 }}>{a.text}</div>
                  <div style={{ fontSize: 11, color: "var(--t3)" }}>{a.group}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--font-mono)" }}>{a.time}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span className="title-text"><span className="panel-icon">✅</span> 近期闭环</span>
            <span className="hint">今日 12 项</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {closedRecent.map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px",
                                       background: "var(--bg-tint)", borderRadius: 12 }}>
                <span className="tag green" style={{ fontSize: 10, minWidth: 38, justifyContent: "center" }}>闭环</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--t)", fontWeight: 600 }}>{c.text}</div>
                  <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>{c.supplier} · MTTR {c.mttr}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--font-mono)" }}>{c.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
