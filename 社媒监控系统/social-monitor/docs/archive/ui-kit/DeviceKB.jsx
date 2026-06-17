// DeviceKB.jsx — /devicekb (设备知识库)
const DEVICES = [
  { id: 1, model: "SN-A341 网关",         category: "通信网关", frequency: 28,
    symptom: "TCP 长连接 30 分钟后断流,日志报 EHOSTUNREACH",
    solution: "Firmware ≤ 2.1.4 已知 bug。升级到 2.1.7+ 或部署 60s 心跳 cron。" },
  { id: 2, model: "Yealink T46S 话机",    category: "终端设备", frequency: 14,
    symptom: "登录后 5 分钟内自动注销,无报错日志",
    solution: "SIP server 配置中关闭 keep-alive,改用 OPTIONS 心跳,间隔 30s。" },
  { id: 3, model: "Cisco SG250 交换机",   category: "网络设备", frequency: 9,
    symptom: "VLAN 100 间歇性丢包,丢包率 2-5%",
    solution: "Port-mirror 配置冲突。删除老的 monitor session,重做并指定 source vlan only。" },
  { id: 4, model: "华为 AR3260 路由器",    category: "网络设备", frequency: 11,
    symptom: "BGP 邻居震荡,session 每隔 2-3 小时 reset",
    solution: "MTU 与上游不一致 (1500 vs 1492),修改 GE0/0/0 接口 mtu 1492 并 commit。" },
  { id: 5, model: "Dahua IPC-HFW2200",   category: "监控设备", frequency: 6,
    symptom: "RTSP 流卡顿,码率自动降到 512Kbps",
    solution: "PoE 供电不足,SUP 功率溢出。替换为 PoE+ 交换机或独立 12V 电源。" },
];

function DeviceKB() {
  const [q, setQ] = React.useState("");
  const [cat, setCat] = React.useState("全部分类");
  const cats = ["全部分类", ...new Set(DEVICES.map(d => d.category))];
  const visible = DEVICES.filter(d =>
    (cat === "全部分类" || d.category === cat) &&
    (!q || d.model.includes(q) || d.symptom.includes(q) || d.solution.includes(q))
  );
  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">🔧</span> 设备知识库</span>
          <span className="hint">设备供应商闭环问题自动提取: 型号 → 故障 → 方案 · 共 {DEVICES.length} 条</span>
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 22, flexWrap: "wrap" }}>
          <input className="form-control" style={{ flex: 1, minWidth: 240, maxWidth: 380 }}
                 placeholder="搜索型号 / 故障 / 方案..." value={q} onChange={e => setQ(e.target.value)} />
          <select className="form-control" value={cat} onChange={e => setCat(e.target.value)} style={{ minWidth: 140 }}>
            {cats.map(c => <option key={c}>{c}</option>)}
          </select>
          <button className="btn-primary">🔍 搜索</button>
        </div>

        {visible.length === 0 ? <div className="empty-state">暂无匹配设备</div> :
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {visible.map(d => (
            <div key={d.id} className="msg-card" style={{ flexDirection: "column", gap: 12, alignItems: "stretch" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "var(--t)", marginBottom: 4 }}>{d.model}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <span className="tag slate">{d.category}</span>
                    <span className="tag purple">命中 {d.frequency} 次</span>
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ background: "rgba(229,62,62,0.05)", borderLeft: "3px solid var(--color-danger)",
                              padding: "12px 16px", borderRadius: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--color-danger)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>故障</div>
                  <div style={{ fontSize: 13, color: "var(--t)", lineHeight: 1.55 }}>{d.symptom}</div>
                </div>
                <div style={{ background: "rgba(56,161,105,0.05)", borderLeft: "3px solid var(--color-success)",
                              padding: "12px 16px", borderRadius: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--color-success)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>方案</div>
                  <div style={{ fontSize: 13, color: "var(--t)", lineHeight: 1.55 }}>{d.solution}</div>
                </div>
              </div>
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

window.DeviceKB = DeviceKB;
