// SupplierProfiles.jsx — /profiles (供应商画像)
// Uses the stone+indigo Report aesthetic from the real codebase

const SUPPLIERS = [
  { name: "深圳·锐讯通信网络服务", sector: "网络设备", region: "华南区", score: 87,
    p50: 12, open: 0, commit: 0.94, p95: 38, mttr: 96, recurrence: 0.08, total: 1284 },
  { name: "上海·盈通信息技术",     sector: "支付通道", region: "华东区", score: 92,
    p50: 8,  open: 0, commit: 0.98, p95: 22, mttr: 45, recurrence: 0.04, total: 2102 },
  { name: "广州·星辰云服务",        sector: "支付通道", region: "华南区", score: 78,
    p50: 24, open: 1, commit: 0.81, p95: 67, mttr: 132, recurrence: 0.18, total: 942 },
  { name: "Mason 出海代理团队",     sector: "出海业务", region: "东南亚", score: 65,
    p50: 42, open: 3, commit: 0.62, p95: 145, mttr: 240, recurrence: 0.31, total: 568 },
  { name: "北京·华讯科技",          sector: "网络设备", region: "华北区", score: 81,
    p50: 18, open: 0, commit: 0.88, p95: 52, mttr: 78, recurrence: 0.12, total: 824 },
  { name: "深圳·讯飞硬件",          sector: "设备技术", region: "华南区", score: 58,
    p50: 56, open: 4, commit: 0.55, p95: 188, mttr: 312, recurrence: 0.42, total: 312 },
];

const scoreColor = (s) => s >= 80 ? "var(--r-green-700)" : s >= 60 ? "var(--r-amber-700)" : "var(--r-red-700)";
const scoreBg    = (s) => s >= 80 ? "var(--r-green-50)"  : s >= 60 ? "var(--r-amber-50)"  : "var(--r-red-50)";

function SupplierList({ onSelect }) {
  const [sector, setSector] = React.useState("全部板块");
  const [sort, setSort] = React.useState("score");
  const sectors = ["全部板块", ...new Set(SUPPLIERS.map(s => s.sector))];
  let visible = sector === "全部板块" ? SUPPLIERS : SUPPLIERS.filter(s => s.sector === sector);
  visible = [...visible].sort((a, b) => {
    if (sort === "score")    return b.score - a.score;
    if (sort === "issues")   return b.open - a.open;
    if (sort === "response") return a.p50 - b.p50;
    if (sort === "commit")   return b.commit - a.commit;
    return 0;
  });

  return (
    <div className="view-enter report-mode" style={{ margin: "-32px -40px -48px", padding: "32px 40px 48px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--stone-900)", margin: 0, letterSpacing: "-0.3px" }}>供应商可靠性画像</h2>
          <p style={{ fontSize: 12, color: "var(--stone-400)", margin: "4px 0 0 0" }}>
            每日 03:00 自动更新 · 评分 = 100 − 告警扣分 − 承诺违约扣分 − 响应慢扣分
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <select className="form-control" value={sector} onChange={e => setSector(e.target.value)} style={{ minWidth: 140 }}>
            {sectors.map(s => <option key={s}>{s}</option>)}
          </select>
          <select className="form-control" value={sort} onChange={e => setSort(e.target.value)} style={{ minWidth: 140 }}>
            <option value="score">评分最高</option>
            <option value="issues">告警最多</option>
            <option value="response">响应最快</option>
            <option value="commit">兑现率最高</option>
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
        {visible.map(s => (
          <div key={s.name} className="r-card" onClick={() => onSelect(s)} style={{ cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14, gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "var(--stone-900)",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  <span className="tag indigo">{s.sector}</span>
                  <span className="tag slate">{s.region}</span>
                </div>
              </div>
              <div style={{
                width: 52, height: 52, borderRadius: "50%", flexShrink: 0,
                background: scoreBg(s.score), color: scoreColor(s.score),
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 19, fontWeight: 700
              }}>{s.score}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8,
                          paddingTop: 12, borderTop: "1px solid var(--stone-100)" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--stone-900)" }}>{s.p50}min</div>
                <div style={{ fontSize: 10, color: "var(--stone-400)", marginTop: 2 }}>P50响应</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: s.open > 0 ? "var(--r-red-700)" : "var(--stone-900)" }}>{s.open}</div>
                <div style={{ fontSize: 10, color: "var(--stone-400)", marginTop: 2 }}>未闭环</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--stone-900)" }}>{Math.round(s.commit * 100)}%</div>
                <div style={{ fontSize: 10, color: "var(--stone-400)", marginTop: 2 }}>兑现率</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SupplierDetail({ s, onBack }) {
  const subScores = [
    { label: "主动上报与预警", pct: 86 },
    { label: "首问解决率 FCR",  pct: 72 },
    { label: "技术配合态度",    pct: 88 },
    { label: "计划内变更占比",  pct: 64 },
  ];
  const barColor = (v) => v >= 70 ? "var(--r-green-700)" : v >= 40 ? "var(--r-amber-700)" : "var(--r-red-700)";

  return (
    <div className="view-enter report-mode" style={{ margin: "-32px -40px -48px", padding: "32px 40px 48px" }}>
      <nav style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--stone-400)", marginBottom: 24 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--indigo-600)", cursor: "pointer", fontSize: 13, padding: 0, fontWeight: 600 }}>← 供应商矩阵</button>
        <span>/</span><span>{s.sector}</span><span>/</span>
        <span style={{ color: "var(--stone-900)", fontWeight: 600 }}>{s.name}</span>
      </nav>

      <section style={{ display: "flex", flexWrap: "wrap", gap: 32, marginBottom: 32, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--stone-900)", margin: "0 0 12px", letterSpacing: "-0.5px" }}>{s.name}</h1>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="tag indigo">{s.sector}</span>
            <span className="tag slate">{s.region}</span>
          </div>
        </div>
        <div className="r-card" style={{ textAlign: "center", minWidth: 180 }}>
          <div style={{ fontSize: 11, color: "var(--stone-400)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>综合 SLA 评分</div>
          <div style={{ fontSize: 56, fontWeight: 700, letterSpacing: "-2px", color: scoreColor(s.score), lineHeight: 1 }}>{s.score}</div>
          <div style={{ fontSize: 12, color: "var(--stone-600)", marginTop: 4 }}>基于 {s.total} 条消息</div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 32 }}>
        <div className="r-card">
          <div style={{ fontSize: 11, color: "var(--stone-400)", letterSpacing: 0.5, marginBottom: 4 }}>平均响应 P50</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--stone-900)", letterSpacing: "-0.5px" }}>{s.p50}min</div>
        </div>
        <div className="r-card">
          <div style={{ fontSize: 11, color: "var(--stone-400)", letterSpacing: 0.5, marginBottom: 4 }}>P95 长尾</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--stone-900)", letterSpacing: "-0.5px" }}>{s.p95}min</div>
        </div>
        <div className="r-card">
          <div style={{ fontSize: 11, color: "var(--stone-400)", letterSpacing: 0.5, marginBottom: 4 }}>平均解决 MTTR</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--stone-900)", letterSpacing: "-0.5px" }}>{s.mttr}min</div>
        </div>
        <div className="r-card" style={{ background: s.open === 0 ? "var(--r-green-50)" : "#fff", borderColor: s.open === 0 ? "var(--r-green-100)" : "var(--stone-200)" }}>
          <div style={{ fontSize: 11, color: "var(--stone-400)", letterSpacing: 0.5, marginBottom: 4 }}>逃逸告警</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: s.open === 0 ? "var(--r-green-700)" : "var(--r-red-700)", letterSpacing: "-0.5px" }}>{s.open}</div>
          <div style={{ fontSize: 12, color: s.open === 0 ? "var(--r-green-700)" : "var(--r-red-700)", marginTop: 4, fontWeight: 600 }}>
            {s.open === 0 ? "SLA 100% 达成" : "待处理 " + s.open + " 项"}
          </div>
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "7fr 5fr", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="r-card">
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--stone-900)", margin: "0 0 18px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 18, background: "var(--indigo-600)", borderRadius: 2 }}></span>
              服务态度与配合度
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              <div style={{ background: "var(--stone-50)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--stone-600)", marginBottom: 8 }}>主动上报率</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: s.commit >= 0.6 ? "var(--r-green-700)" : "var(--r-red-700)" }}>{Math.round(s.commit * 100)}%</div>
                <div style={{ height: 5, background: "var(--stone-100)", borderRadius: 999, overflow: "hidden", marginTop: 8 }}>
                  <div style={{ width: (s.commit * 100) + "%", height: "100%", background: s.commit >= 0.6 ? "var(--r-green-700)" : "var(--r-red-700)", borderRadius: 999 }}></div>
                </div>
              </div>
              <div style={{ background: "var(--stone-50)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--stone-600)", marginBottom: 8 }}>问题复发率</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: s.recurrence <= 0.2 ? "var(--r-green-700)" : s.recurrence <= 0.4 ? "var(--r-amber-700)" : "var(--r-red-700)" }}>{Math.round(s.recurrence * 100)}%</div>
                <div style={{ height: 5, background: "var(--stone-100)", borderRadius: 999, overflow: "hidden", marginTop: 8 }}>
                  <div style={{ width: (s.recurrence * 100) + "%", height: "100%", background: s.recurrence <= 0.2 ? "var(--r-green-700)" : "var(--r-red-700)", borderRadius: 999 }}></div>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--stone-600)", fontWeight: 500 }}>态度标签:</span>
              <span className="tag green">配合积极</span>
              <span className="tag green">主动上报</span>
              {s.recurrence > 0.3 && <span className="tag red">复发率偏高</span>}
            </div>
          </section>

          <section className="r-card">
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--stone-900)", margin: "0 0 18px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 18, background: "var(--r-green-700)", borderRadius: 2 }}></span>
              问题解决效率
            </h2>
            {subScores.map(sc => (
              <div key={sc.label} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: "var(--stone-600)" }}>{sc.label}</span>
                  <span style={{ fontWeight: 700, color: barColor(sc.pct) }}>{sc.pct}%</span>
                </div>
                <div style={{ height: 6, background: "var(--stone-100)", borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ width: sc.pct + "%", height: "100%", background: barColor(sc.pct), borderRadius: 999 }}></div>
                </div>
              </div>
            ))}
          </section>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="r-card">
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--stone-900)", margin: "0 0 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 18, background: "var(--r-violet-700)", borderRadius: 2 }}></span>
              AI 综合洞察
            </h2>
            <p style={{ fontSize: 13, color: "var(--stone-600)", lineHeight: 1.8, marginBottom: 12 }}>
              工作日响应速度达标 (P50 {s.p50}min)。月内闭环 {Math.round(s.commit*100)}% 主动上报率优于同板块均值。
              复发率 {Math.round(s.recurrence*100)}%, 主要集中在 SN-A341 网关 firmware 升级未推进。建议季度内推动设备替换。
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <span className="tag green">响应快</span>
              <span className="tag green">协作流畅</span>
              <span className="tag amber">硬件升级滞后</span>
            </div>
          </section>

          <section className="r-card">
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--stone-900)", margin: "0 0 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 18, background: "var(--r-red-700)", borderRadius: 2 }}></span>
              近期告警
            </h2>
            {[
              { lvl: "P1", text: "网关延迟 > 12 min", time: "12-04 16:32" },
              { lvl: "P0", text: "OTP 上游全通道下跌", time: "12-03 09:14" },
              { lvl: "P1", text: "SN-A341 firmware 拒升级", time: "12-02 11:22" }
            ].map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--stone-100)", fontSize: 13 }}>
                <span className={"tag " + (a.lvl === "P0" ? "p0" : "p1")} style={{ fontSize: 10, minWidth: 28, justifyContent: "center" }}>{a.lvl}</span>
                <span style={{ color: "var(--stone-900)", flex: 1 }}>{a.text}</span>
                <span style={{ color: "var(--stone-400)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{a.time}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function SupplierProfiles() {
  const [detail, setDetail] = React.useState(null);
  if (detail) return <SupplierDetail s={detail} onBack={() => setDetail(null)} />;
  return <SupplierList onSelect={setDetail} />;
}

window.SupplierProfiles = SupplierProfiles;
