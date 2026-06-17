// Analytics.jsx — /analytics (数据看板)
function Analytics() {
  // Bar chart heights (simulated 7-day data)
  const days = [
    { d: "12-01", p0: 2,  p1: 8,  closed: 12 },
    { d: "12-02", p0: 1,  p1: 6,  closed: 9 },
    { d: "12-03", p0: 4,  p1: 12, closed: 18 },
    { d: "12-04", p0: 1,  p1: 9,  closed: 14 },
    { d: "12-05", p0: 0,  p1: 5,  closed: 11 },
    { d: "12-06", p0: 2,  p1: 7,  closed: 13 },
    { d: "12-07", p0: 1,  p1: 4,  closed: 8 },
  ];
  const max = 20;
  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">🚨</span> 故障告警指标</span>
          <span className="hint">P0 / P1 累计 · 实时同步 analytics.sqlite</span>
        </div>
        <div className="grid-4">
          <div className="stat-card" style={{ "--c": "var(--color-info)" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-info)" }}></div>
            <div className="stat-lbl">累计告警次数</div>
            <div className="stat-val" style={{ color: "var(--color-info)", fontSize: 40 }}>1,284</div>
            <div className="stat-foot">近 7 日 · <span className="up">↑ 12.4%</span></div>
          </div>
          <div className="stat-card" style={{ position: "relative" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-danger)" }}></div>
            <div className="stat-lbl">P0 紧急告警</div>
            <div className="stat-val" style={{ color: "var(--color-danger)", fontSize: 40 }}>11</div>
            <div className="stat-foot">近 7 日 · <span className="down">↓ 3 起</span></div>
          </div>
          <div className="stat-card" style={{ position: "relative" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-warning)" }}></div>
            <div className="stat-lbl">P1 聚合告警</div>
            <div className="stat-val" style={{ color: "var(--color-warning)", fontSize: 40 }}>51</div>
            <div className="stat-foot">近 7 日</div>
          </div>
          <div className="stat-card" style={{ position: "relative" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-success)" }}></div>
            <div className="stat-lbl">已闭环问题</div>
            <div className="stat-val" style={{ color: "var(--color-success)", fontSize: 40 }}>85</div>
            <div className="stat-foot">闭环率 · <span className="up">93%</span></div>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "5fr 4fr", gap: 24 }}>
        <div className="panel">
          <div className="panel-title">
            <span className="title-text"><span className="panel-icon">📊</span> 近 7 日告警趋势</span>
            <span className="hint">堆叠柱状: P0 (红) · P1 (黄) · 闭环 (绿)</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 18, height: 240, padding: "20px 8px" }}>
            {days.map(d => {
              const total = d.p0 + d.p1 + d.closed;
              return (
                <div key={d.d} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--t2)", fontWeight: 700 }}>{total}</div>
                  <div style={{ width: "100%", maxWidth: 32, display: "flex", flexDirection: "column", justifyContent: "flex-end",
                                height: 180, gap: 1, borderRadius: 6, overflow: "hidden", background: "var(--bg)" }}>
                    <div style={{ height: (d.closed / max) * 180, background: "var(--color-success)" }}></div>
                    <div style={{ height: (d.p1 / max) * 180,    background: "var(--color-warning)" }}></div>
                    <div style={{ height: (d.p0 / max) * 180,    background: "var(--color-danger)" }}></div>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--t3)", fontFamily: "var(--font-mono)" }}>{d.d}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 18, justifyContent: "center", marginTop: 8, fontSize: 11, color: "var(--t3)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-danger)" }}></span> P0</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-warning)" }}></span> P1</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-success)" }}></span> 闭环</span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span className="title-text"><span className="panel-icon">🎯</span> 闭环完成率</span>
            <span className="hint">滚动 30 日</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 0" }}>
            {/* SVG donut ring */}
            <svg width="180" height="180" viewBox="0 0 180 180">
              <circle cx="90" cy="90" r="76" fill="none" stroke="var(--bg)" strokeWidth="20" />
              <circle cx="90" cy="90" r="76" fill="none" stroke="var(--color-success)" strokeWidth="20"
                      strokeDasharray="477.5" strokeDashoffset="33.5" strokeLinecap="round"
                      transform="rotate(-90 90 90)" />
            </svg>
            <div style={{ marginTop: -110, textAlign: "center" }}>
              <div style={{ fontSize: 44, fontWeight: 800, color: "var(--color-success)", letterSpacing: "-2px", lineHeight: 1 }}>93%</div>
              <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 4, fontWeight: 600 }}>闭环完成率</div>
            </div>
            <div style={{ marginTop: 60, display: "flex", gap: 24, fontSize: 12 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--t)" }}>62</div>
                <div style={{ color: "var(--t3)" }}>新建</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--color-success)" }}>58</div>
                <div style={{ color: "var(--t3)" }}>已闭环</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--color-danger)" }}>4</div>
                <div style={{ color: "var(--t3)" }}>逃逸</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">📅</span> 每日摘要与周报</span>
          <span className="hint">运营自动生成的摘要存档</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          <div style={{ background: "var(--bg-tint)", borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 11, color: "var(--t3)", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>已生成日报册数</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "var(--t)", letterSpacing: "-0.5px" }}>184</div>
          </div>
          <div style={{ background: "var(--bg-tint)", borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 11, color: "var(--t3)", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>监控群组覆盖面</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "var(--t)", letterSpacing: "-0.5px" }}>142</div>
          </div>
          <div style={{ background: "var(--bg-tint)", borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 11, color: "var(--t3)", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>本周质检供应商</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "var(--t)", letterSpacing: "-0.5px" }}>23</div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.Analytics = Analytics;
